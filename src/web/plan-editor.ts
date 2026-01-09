/**
 * PlanEditor - ProseMirror-based editor for plan documents
 *
 * Features:
 * - Editable paragraphs and code blocks
 * - Non-editable, horizontally scrollable ASCII diagrams
 * - Diff highlighting via decorations
 * - iOS autocomplete support
 * - Full-screen diagram viewer with pinch-to-zoom
 */

import { EditorState, Transaction, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, undo, redo, undoDepth, redoDepth } from "prosemirror-history";
import { inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { splitListItem, liftListItem, sinkListItem } from "prosemirror-schema-list";
import { Node } from "prosemirror-model";
import * as Diff from "diff";
import { parseMarkdown, serializeMarkdown, schema } from "./prosemirror-schema.js";

export interface PlanEditorOptions {
  /** Initial markdown content */
  value?: string;
  /** Baseline content for diff comparison */
  baseline?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Callback when content changes */
  onChange?: (value: string) => void;
}

// Shared state for diff highlighting
let baselineDoc: Node | null = null;

type SectionFoldState = {
  collapsed: Set<number>;
};

const sectionFoldKey = new PluginKey<SectionFoldState>("section-fold");

// Extract plain text with position mapping from a doc
function extractTextWithPositions(doc: Node): { text: string; positions: number[] } {
  const text: string[] = [];
  const positions: number[] = [];

  const appendText = (node: Node, basePos: number) => {
    node.descendants((child, pos) => {
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) {
          text.push(child.text[i]);
          positions.push(basePos + pos + 1 + i);
        }
      } else if (child.type.name === "hard_break") {
        text.push("\n");
        positions.push(basePos + pos + 1);
      }
      return true;
    });
  };

  doc.forEach((block, pos, index) => {
    appendText(block, pos);
    if (index < doc.childCount - 1) {
      text.push("\n");
      positions.push(pos + block.nodeSize);
    }
  });

  return { text: text.join(""), positions };
}

function createDiffDecorations(doc: Node, baseline: Node | null): DecorationSet {
  if (!baseline) {
    return DecorationSet.empty;
  }

  const current = extractTextWithPositions(doc);
  const base = extractTextWithPositions(baseline);

  if (current.text === base.text) {
    return DecorationSet.empty;
  }

  const decorations: Decoration[] = [];
  const changes = Diff.diffLines(base.text, current.text);

  let currentIdx = 0;

  const addInlineRange = (startIdx: number, endIdx: number) => {
    const startPos = current.positions[startIdx];
    const endPos = current.positions[endIdx];
    if (startPos !== undefined && endPos !== undefined) {
      decorations.push(Decoration.inline(startPos, endPos + 1, { class: "diff-added" }));
    }
  };

  const addInline = (startIdx: number, value: string) => {
    if (!value) {
      return;
    }
    let runStart = -1;
    for (let offset = 0; offset < value.length; offset++) {
      if (value[offset] === "\n") {
        if (runStart >= 0) {
          addInlineRange(startIdx + runStart, startIdx + offset - 1);
          runStart = -1;
        }
        continue;
      }
      if (runStart < 0) {
        runStart = offset;
      }
    }
    if (runStart >= 0) {
      addInlineRange(startIdx + runStart, startIdx + value.length - 1);
    }
  };

  const addRemoved = (insertIdx: number, removedText: string) => {
    if (!removedText) {
      return;
    }
    const markerPos =
      current.positions[insertIdx] ??
      (current.positions.length > 0 ? current.positions[current.positions.length - 1] + 1 : 0);
    let safePos = Math.max(0, Math.min(markerPos, doc.content.size));
    // For single-line content, try to place widget inside a textblock
    if (!removedText.includes("\n") && safePos > 0) {
      const resolved = doc.resolve(safePos);
      if (!resolved.parent.isTextblock) {
        const shifted = safePos - 1;
        if (doc.resolve(shifted).parent.isTextblock) {
          safePos = shifted;
        }
      }
    }

    // Check if we're about to place a widget inside a heading
    // If so, place it BEFORE the heading instead
    if (safePos > 0) {
      const resolved = doc.resolve(safePos);
      for (let d = resolved.depth; d > 0; d--) {
        const node = resolved.node(d);
        if (node.type.name === "heading") {
          // Move to before the heading
          safePos = resolved.before(d);
          break;
        }
      }
    }

    // Check if removed text contains newlines (multi-line deletion)
    const hasNewlines = removedText.includes("\n");

    decorations.push(
      Decoration.widget(
        safePos,
        () => {
          if (hasNewlines) {
            // Multi-line: render each line as a separate div to prevent overlap
            const container = document.createElement("span");
            container.className = "diff-removed-block";
            container.setAttribute("aria-hidden", "true");
            container.contentEditable = "false";

            const lines = removedText.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line) {
                const lineEl = document.createElement("span");
                lineEl.className = "diff-removed-line";
                lineEl.textContent = line;
                container.appendChild(lineEl);
              }
              // Add line break between lines (but not after last)
              if (i < lines.length - 1) {
                container.appendChild(document.createElement("br"));
              }
            }
            return container;
          } else {
            // Single line: use simple span
            const ghost = document.createElement("span");
            ghost.className = "diff-removed";
            ghost.textContent = removedText;
            ghost.setAttribute("aria-hidden", "true");
            ghost.contentEditable = "false";
            return ghost;
          }
        },
        { side: 1, ignoreSelection: true },
      ),
    );
  };

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    const len = change.value.length;

    if (change.removed && changes[i + 1]?.added) {
      const removed = change.value;
      const added = changes[i + 1]?.value ?? "";
      const charChanges = Diff.diffChars(removed, added);
      let lineIdx = 0;

      for (const charChange of charChanges) {
        const charLen = charChange.value.length;
        if (charChange.added) {
          addInline(currentIdx + lineIdx, charChange.value);
          lineIdx += charLen;
        } else if (charChange.removed) {
          addRemoved(currentIdx + lineIdx, charChange.value);
        } else {
          lineIdx += charLen;
        }
      }

      currentIdx += added.length;
      i += 1;
    } else if (change.added) {
      addInline(currentIdx, change.value);
      currentIdx += len;
    } else if (change.removed) {
      addRemoved(currentIdx, change.value);
    } else {
      currentIdx += len;
    }
  }

  return DecorationSet.create(doc, decorations);
}

function buildSectionFoldDecorations(doc: Node, collapsed: Set<number>): DecorationSet {
  const decorations: Decoration[] = [];
  const headings: Array<{ pos: number; level: number; size: number }> = [];

  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.type.name === "heading") {
      headings.push({
        pos,
        level: Number(node.attrs.level || 1),
        size: node.nodeSize,
      });
      return false;
    }
    return true;
  });

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const isCollapsed = collapsed.has(heading.pos);
    if (!isCollapsed) {
      continue;
    }

    const from = heading.pos + heading.size;
    let to = doc.content.size;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= heading.level) {
        to = headings[j].pos;
        break;
      }
    }

    if (to <= from) {
      continue;
    }

    doc.nodesBetween(from, to, (node, pos) => {
      if (node.isBlock) {
        decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "pm-collapsed" }));
        return false;
      }
      return true;
    });
  }

  return DecorationSet.create(doc, decorations);
}

function diffPlugin(): Plugin {
  return new Plugin({
    state: {
      init(_, state) {
        return createDiffDecorations(state.doc, baselineDoc);
      },
      apply(tr, _oldDecorations, _oldState, newState) {
        if (tr.docChanged) {
          return createDiffDecorations(newState.doc, baselineDoc);
        }
        return createDiffDecorations(newState.doc, baselineDoc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

function sectionFoldPlugin(): Plugin<SectionFoldState> {
  return new Plugin({
    key: sectionFoldKey,
    state: {
      init: () => ({ collapsed: new Set() }),
      apply(tr, value) {
        let collapsed = new Set<number>();
        for (const pos of value.collapsed) {
          const mappedPos = tr.mapping.map(pos);
          const node = tr.doc.nodeAt(mappedPos);
          if (node?.type.name === "heading") {
            collapsed.add(mappedPos);
          }
        }

        const meta = tr.getMeta(sectionFoldKey) as { type: "toggle"; pos: number } | undefined;
        if (meta?.type === "toggle") {
          if (collapsed.has(meta.pos)) {
            collapsed.delete(meta.pos);
          } else {
            collapsed.add(meta.pos);
          }
        }

        return { collapsed };
      },
    },
    props: {
      decorations(state) {
        const pluginState = sectionFoldKey.getState(state);
        if (!pluginState) {
          return null;
        }
        return buildSectionFoldDecorations(state.doc, pluginState.collapsed);
      },
    },
  });
}

type ActiveHeading = {
  pos: number;
  node: Node;
};

type ActiveListItem = {
  pos: number;
  node: Node;
  list: Node;
  listPos: number;
  index: number;
  paragraphPos: number;
};

function getActiveHeading(state: EditorState): ActiveHeading | null {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) {
    return null;
  }
  const parent = $from.parent;
  if (parent.type.name !== "heading") {
    return null;
  }
  return { pos: $from.before(), node: parent };
}

function getActiveListItem(state: EditorState): ActiveListItem | null {
  const { $from, $to } = state.selection;
  if (!$from.sameParent($to)) {
    return null;
  }
  if ($from.parent.type.name !== "paragraph") {
    return null;
  }

  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type.name !== "list_item") {
      continue;
    }
    const listDepth = depth - 1;
    if (listDepth < 0) {
      return null;
    }
    const list = $from.node(listDepth);
    if (!list || (list.type.name !== "bullet_list" && list.type.name !== "ordered_list")) {
      return null;
    }
    const index = $from.index(listDepth);
    const listItemPos = $from.before(depth);
    const listPos = $from.before(listDepth);
    return {
      pos: listItemPos,
      node,
      list,
      listPos,
      index,
      paragraphPos: $from.before(),
    };
  }

  return null;
}

function isAtHeadingStart(state: EditorState, headingPos: number): boolean {
  return state.selection.empty && state.selection.from === headingPos + 1;
}

function updateHeadingLevel(
  view: EditorView,
  heading: ActiveHeading,
  nextLevel: number | null,
): boolean {
  const { state } = view;
  const { schema } = state;

  if (nextLevel === null) {
    // Convert heading to paragraph and ensure cursor is placed at the start
    // of the new paragraph's content (not at position 0 which would cause
    // joinBackward on next backspace)
    const tr = state.tr.setNodeMarkup(heading.pos, schema.nodes.paragraph);
    // Position cursor at start of paragraph content (heading.pos + 1)
    const $pos = tr.doc.resolve(heading.pos + 1);
    tr.setSelection(TextSelection.near($pos));
    view.dispatch(tr);
    return true;
  }

  const currentLevel = Number(heading.node.attrs.level || 1);
  const clampedLevel = Math.max(1, Math.min(6, nextLevel));
  if (clampedLevel === currentLevel) {
    return true;
  }

  view.dispatch(state.tr.setNodeMarkup(heading.pos, schema.nodes.heading, { level: clampedLevel }));
  return true;
}

function headingEditPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const heading = getActiveHeading(state);
        if (!heading) {
          return DecorationSet.empty;
        }
        const level = Math.max(1, Math.min(6, Number(heading.node.attrs.level || 1)));
        return DecorationSet.create(state.doc, [
          Decoration.node(heading.pos, heading.pos + heading.node.nodeSize, {
            class: "pm-heading-editing",
            "data-md-prefix": "#".repeat(level) + " ",
          }),
        ]);
      },
      handleTextInput(view, from, to, text) {
        if (from !== to) {
          return false;
        }
        const heading = getActiveHeading(view.state);
        if (!heading || !isAtHeadingStart(view.state, heading.pos)) {
          return false;
        }
        if (!/^#+$/.test(text)) {
          return false;
        }
        const level = Number(heading.node.attrs.level || 1);
        // At max level (6), don't intercept - let user type # as text
        if (level >= 6) {
          return false;
        }
        return updateHeadingLevel(view, heading, level + text.length);
      },
      handleKeyDown(view, event) {
        if (event.key !== "Backspace") {
          return false;
        }
        const heading = getActiveHeading(view.state);
        if (!heading || !isAtHeadingStart(view.state, heading.pos)) {
          return false;
        }
        event.preventDefault();
        const level = Number(heading.node.attrs.level || 1);
        if (level > 1) {
          return updateHeadingLevel(view, heading, level - 1);
        }
        return updateHeadingLevel(view, heading, null);
      },
    },
  });
}

function listEditPlugin(): Plugin {
  return new Plugin({
    props: {
      decorations(state) {
        const listItem = getActiveListItem(state);
        if (!listItem) {
          return DecorationSet.empty;
        }
        let prefix = "- ";
        if (listItem.list.type.name === "ordered_list") {
          const order = Number(listItem.list.attrs.order || 1);
          prefix = `${order + listItem.index}. `;
        }
        return DecorationSet.create(state.doc, [
          Decoration.node(listItem.pos, listItem.pos + listItem.node.nodeSize, {
            class: "pm-list-editing",
          }),
          Decoration.widget(
            listItem.paragraphPos + 1,
            () => {
              const span = document.createElement("span");
              span.className = "pm-list-editing-prefix";
              span.textContent = prefix;
              span.style.setProperty("--md-prefix-width", `${prefix.length}ch`);
              span.setAttribute("aria-hidden", "true");
              span.contentEditable = "false";
              return span;
            },
            { side: -1, ignoreSelection: true },
          ),
        ]);
      },
      handleKeyDown(view, event) {
        // Handle backspace/delete to prevent content merge with headings after lists
        if (event.key !== "Backspace" && event.key !== "Delete") {
          return false;
        }

        const { state } = view;
        const { selection } = state;

        // Only handle non-empty selections
        if (selection.empty) {
          return false;
        }

        const $from = state.doc.resolve(selection.from);

        // Find all lists in the ancestry (from innermost to outermost)
        // We need to find the top-level list that is followed by a heading
        const listsInAncestry: Array<{
          depth: number;
          node: Node;
          start: number;
          end: number;
        }> = [];

        for (let d = $from.depth; d >= 0; d--) {
          const node = $from.node(d);
          if (node.type.name === "bullet_list" || node.type.name === "ordered_list") {
            const start = $from.before(d);
            listsInAncestry.push({
              depth: d,
              node,
              start,
              end: start + node.nodeSize,
            });
          }
        }

        if (listsInAncestry.length === 0) {
          return false;
        }

        // Find the outermost list that is followed by a heading
        // Start from outermost (last in array) and work inward
        let targetList = null;
        for (let i = listsInAncestry.length - 1; i >= 0; i--) {
          const list = listsInAncestry[i];
          if (list.end >= state.doc.content.size) {
            continue;
          }
          const afterList = state.doc.resolve(list.end);
          const nextNode = afterList.nodeAfter;
          if (nextNode && nextNode.type.name === "heading") {
            targetList = list;
            break;
          }
        }

        if (!targetList) {
          return false;
        }

        // Check if this is a single-item list
        const isSingleItemList = targetList.node.childCount === 1;

        // Check if selection covers most of the list's text content
        const listTextContent = targetList.node.textContent || "";
        const selectedText = state.doc.textBetween(selection.from, selection.to);

        // If selection covers significant portion of the single-item list content
        // we need to handle this specially to prevent heading merge
        if (isSingleItemList && selectedText.length >= listTextContent.length * 0.5) {
          event.preventDefault();

          // Delete the entire list to prevent partial content merging with heading
          const tr = state.tr;
          tr.delete(targetList.start, targetList.end);
          view.dispatch(tr);
          return true;
        }

        // For multi-item lists or partial selections, let ProseMirror handle normally
        return false;
      },
    },
  });
}

// Diagram viewer management
class DiagramViewer {
  private backdrop: HTMLElement;
  private container: HTMLElement;
  private content: HTMLPreElement;
  private zoomLabel: HTMLElement;
  private currentZoom = 100;
  private initialPinchDistance = 0;
  private initialPinchZoom = 100;

  constructor() {
    // Create backdrop
    this.backdrop = document.createElement("div");
    this.backdrop.className = "diagram-viewer-backdrop";

    // Create container
    this.container = document.createElement("div");
    this.container.className = "diagram-viewer-container";

    // Create content
    this.content = document.createElement("pre");
    this.content.className = "diagram-viewer-content";

    this.container.appendChild(this.content);
    this.backdrop.appendChild(this.container);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "diagram-viewer-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    this.backdrop.appendChild(closeBtn);

    // Zoom controls
    const zoomControls = document.createElement("div");
    zoomControls.className = "diagram-viewer-zoom";

    const zoomOut = document.createElement("button");
    zoomOut.textContent = "−";
    zoomOut.addEventListener("click", () => this.zoom(-25));

    this.zoomLabel = document.createElement("div");
    this.zoomLabel.className = "diagram-viewer-zoom-label";
    this.zoomLabel.textContent = "100%";

    const zoomIn = document.createElement("button");
    zoomIn.textContent = "+";
    zoomIn.addEventListener("click", () => this.zoom(25));

    zoomControls.appendChild(zoomOut);
    zoomControls.appendChild(this.zoomLabel);
    zoomControls.appendChild(zoomIn);
    this.backdrop.appendChild(zoomControls);

    // Click backdrop to close
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });

    // Escape key to close
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.backdrop.classList.contains("open")) {
        this.close();
      }
    });

    // Pinch to zoom
    this.container.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          this.initialPinchDistance = this.getTouchDistance(e.touches);
          this.initialPinchZoom = this.currentZoom;
        }
      },
      { passive: true },
    );

    this.container.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && this.initialPinchDistance > 0) {
          e.preventDefault();
          const dist = this.getTouchDistance(e.touches);
          const scale = dist / this.initialPinchDistance;
          this.currentZoom = Math.max(25, Math.min(300, Math.round(this.initialPinchZoom * scale)));
          this.updateZoom();
        }
      },
      { passive: false },
    );

    this.container.addEventListener(
      "touchend",
      () => {
        this.initialPinchDistance = 0;
      },
      { passive: true },
    );

    document.body.appendChild(this.backdrop);
  }

  private getTouchDistance(touches: TouchList): number {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private updateZoom(): void {
    this.content.style.transform = `scale(${this.currentZoom / 100})`;
    this.zoomLabel.textContent = `${this.currentZoom}%`;
  }

  private zoom(delta: number): void {
    this.currentZoom = Math.max(25, Math.min(300, this.currentZoom + delta));
    this.updateZoom();
  }

  open(text: string): void {
    this.content.textContent = text;
    this.currentZoom = 100;
    this.updateZoom();
    this.backdrop.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  close(): void {
    this.backdrop.classList.remove("open");
    document.body.style.overflow = "";
  }

  destroy(): void {
    this.backdrop.remove();
  }
}

// Diagram NodeView
class DiagramNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;
  private _content: string;

  constructor(
    node: Node,
    private diagramViewer: DiagramViewer,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "diagram-wrapper";
    this.dom.contentEditable = "false";

    // Expand button
    const expandBtn = document.createElement("button");
    expandBtn.className = "diagram-expand-btn";
    expandBtn.textContent = "⤢";
    expandBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.diagramViewer.open(this._content);
    });

    const pre = document.createElement("pre");
    pre.className = "diagram-block";

    const code = document.createElement("code");
    code.textContent = node.textContent;

    pre.appendChild(code);
    this.dom.appendChild(expandBtn);
    this.dom.appendChild(pre);

    this._content = node.textContent;
  }

  stopEvent(): boolean {
    return false;
  }

  ignoreMutation(): boolean {
    return true;
  }

  update(node: Node): boolean {
    if (node.type.name !== "diagram") return false;
    const code = this.dom.querySelector("code");
    if (code) code.textContent = node.textContent;
    this._content = node.textContent;
    return true;
  }
}

// Table NodeView - editable HTML table for GFM tables
class TableNodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement | null = null;

  private headers: string[];
  private rows: string[][];
  private view: EditorView;
  private getPos: () => number | undefined;
  private tableEl: HTMLTableElement;
  private getBaseline: () => { headers: string[]; rows: string[][] } | null;
  private separatorLine: string | null;

  constructor(
    node: Node,
    view: EditorView,
    getPos: () => number | undefined,
    getBaseline: () => { headers: string[]; rows: string[][] } | null,
  ) {
    this.view = view;
    this.getPos = getPos;
    this.getBaseline = getBaseline;
    this.headers = [...(node.attrs.headers as string[])];
    this.rows = (node.attrs.rows as string[][]).map((r) => [...r]);
    this.separatorLine = (node.attrs.separator as string | null) ?? null;

    this.dom = document.createElement("div");
    this.dom.className = "table-widget";

    this.tableEl = document.createElement("table");
    this.dom.appendChild(this.tableEl);

    this.render();
  }

  // Render cell content with character-level diff highlighting
  private renderCellDiff(
    cell: HTMLElement,
    currentValue: string,
    baselineValue: string | undefined,
  ): void {
    cell.innerHTML = "";

    if (baselineValue === undefined) {
      // New cell - highlight entire content
      const span = document.createElement("span");
      span.className = "diff-added";
      span.textContent = currentValue;
      cell.appendChild(span);
      return;
    }

    if (currentValue === baselineValue) {
      // No change
      cell.textContent = currentValue;
      return;
    }

    // Character-level diff
    const changes = Diff.diffChars(baselineValue, currentValue);

    for (const change of changes) {
      if (change.added) {
        const span = document.createElement("span");
        span.className = "diff-added";
        span.textContent = change.value;
        cell.appendChild(span);
      } else if (change.removed) {
        const span = document.createElement("span");
        span.className = "diff-removed";
        span.textContent = change.value;
        cell.appendChild(span);
      } else {
        cell.appendChild(document.createTextNode(change.value));
      }
    }
  }

  // Switch cell to edit mode (plain text, no diff spans)
  private enterEditMode(cell: HTMLElement, rowIdx: number, colIdx: number): void {
    const value = rowIdx === -1 ? this.headers[colIdx] : this.rows[rowIdx][colIdx];
    cell.textContent = value;
  }

  // Switch cell back to display mode (with diff spans)
  private exitEditMode(cell: HTMLElement, rowIdx: number, colIdx: number): void {
    const baseline = this.getBaseline();
    const currentValue = rowIdx === -1 ? this.headers[colIdx] : this.rows[rowIdx][colIdx];

    if (!baseline) {
      cell.textContent = currentValue;
      return;
    }

    let baselineValue: string | undefined;
    if (rowIdx === -1) {
      baselineValue = baseline.headers[colIdx];
    } else if (rowIdx < baseline.rows.length && colIdx < baseline.headers.length) {
      baselineValue = baseline.rows[rowIdx]?.[colIdx];
    }

    this.renderCellDiff(cell, currentValue, baselineValue);
  }

  private render(): void {
    this.tableEl.innerHTML = "";

    // Get baseline for diff comparison
    const baseline = this.getBaseline();

    // Header row
    const thead = document.createElement("thead");
    const headerRow = document.createElement("tr");

    for (let i = 0; i < this.headers.length; i++) {
      const th = document.createElement("th");
      th.contentEditable = "true";
      th.dataset.col = String(i);

      // Render with diff highlighting
      const baselineHeader = baseline?.headers[i];
      this.renderCellDiff(th, this.headers[i], baselineHeader);

      th.addEventListener("focus", () => this.enterEditMode(th, -1, i));
      th.addEventListener("blur", () => {
        this.handleCellBlur(th, -1, i);
        this.exitEditMode(th, -1, i);
      });
      th.addEventListener("keydown", (e) => this.handleKeyDown(e, -1, i));

      headerRow.appendChild(th);
    }

    // Add column button in header
    const addColTh = document.createElement("th");
    addColTh.className = "table-add-col";
    const addColBtn = document.createElement("button");
    addColBtn.className = "table-add-btn";
    addColBtn.textContent = "+";
    addColBtn.title = "Add column";
    addColBtn.addEventListener("click", () => this.addColumn());
    addColTh.appendChild(addColBtn);
    headerRow.appendChild(addColTh);

    thead.appendChild(headerRow);
    this.tableEl.appendChild(thead);

    // Body rows
    const tbody = document.createElement("tbody");
    for (let rowIdx = 0; rowIdx < this.rows.length; rowIdx++) {
      const row = this.rows[rowIdx];
      const tr = document.createElement("tr");

      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        const td = document.createElement("td");
        td.contentEditable = "true";
        td.dataset.row = String(rowIdx);
        td.dataset.col = String(colIdx);

        // Determine baseline value for this cell
        let baselineValue: string | undefined;
        if (baseline) {
          if (rowIdx < baseline.rows.length && colIdx < baseline.headers.length) {
            baselineValue = baseline.rows[rowIdx]?.[colIdx];
          }
          // undefined means new row or new column
        }

        // Render with diff highlighting
        this.renderCellDiff(td, row[colIdx], baselineValue);

        td.addEventListener("focus", () => this.enterEditMode(td, rowIdx, colIdx));
        td.addEventListener("blur", () => {
          this.handleCellBlur(td, rowIdx, colIdx);
          this.exitEditMode(td, rowIdx, colIdx);
        });
        td.addEventListener("keydown", (e) => this.handleKeyDown(e, rowIdx, colIdx));

        tr.appendChild(td);
      }

      // Delete row button
      const deleteTd = document.createElement("td");
      deleteTd.className = "table-row-actions";
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "table-delete-btn";
      deleteBtn.textContent = "×";
      deleteBtn.title = "Delete row";
      deleteBtn.addEventListener("click", () => this.deleteRow(rowIdx));
      deleteTd.appendChild(deleteBtn);
      tr.appendChild(deleteTd);

      tbody.appendChild(tr);
    }
    this.tableEl.appendChild(tbody);

    // Add row button
    const tfoot = document.createElement("tfoot");
    const addRowTr = document.createElement("tr");
    const addRowTd = document.createElement("td");
    addRowTd.colSpan = this.headers.length + 1;
    addRowTd.className = "table-add-row";
    const addRowBtn = document.createElement("button");
    addRowBtn.className = "table-add-btn";
    addRowBtn.textContent = "+ Add row";
    addRowBtn.addEventListener("click", () => this.addRow());
    addRowTd.appendChild(addRowBtn);
    addRowTr.appendChild(addRowTd);
    tfoot.appendChild(addRowTr);
    this.tableEl.appendChild(tfoot);
  }

  private handleCellBlur(cell: HTMLElement, rowIdx: number, colIdx: number): void {
    const newValue = cell.textContent || "";

    if (rowIdx === -1) {
      // Header cell
      if (this.headers[colIdx] !== newValue) {
        this.headers[colIdx] = newValue;
        this.updateNode();
      }
    } else {
      // Body cell
      if (this.rows[rowIdx][colIdx] !== newValue) {
        this.rows[rowIdx][colIdx] = newValue;
        this.updateNode();
      }
    }
  }

  private handleKeyDown(e: KeyboardEvent, _rowIdx: number, _colIdx: number): void {
    if (e.key === "Tab") {
      e.preventDefault();
      const cells = this.tableEl.querySelectorAll("th[contenteditable], td[contenteditable]");
      const cellArray = Array.from(cells);
      const currentIdx = cellArray.indexOf(e.target as Element);

      let nextIdx: number;
      if (e.shiftKey) {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : cellArray.length - 1;
      } else {
        nextIdx = currentIdx < cellArray.length - 1 ? currentIdx + 1 : 0;
      }

      const nextCell = cellArray[nextIdx] as HTMLElement;
      nextCell?.focus();

      // Select all text in the cell
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(nextCell);
      selection?.removeAllRanges();
      selection?.addRange(range);
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      (e.target as HTMLElement).blur();
    }
  }

  private addRow(): void {
    const newRow = this.headers.map(() => "");
    this.rows.push(newRow);
    this.updateNode();
    this.render();

    // Focus first cell of new row
    requestAnimationFrame(() => {
      const lastRow = this.tableEl.querySelector(
        "tbody tr:last-child td[contenteditable]",
      ) as HTMLElement;
      lastRow?.focus();
    });
  }

  private addColumn(): void {
    this.headers.push("");
    for (const row of this.rows) {
      row.push("");
    }
    this.updateNode();
    this.render();

    // Focus new header cell
    requestAnimationFrame(() => {
      const headers = this.tableEl.querySelectorAll("thead th[contenteditable]");
      const lastHeader = headers[headers.length - 1] as HTMLElement;
      lastHeader?.focus();
    });
  }

  private deleteRow(rowIdx: number): void {
    if (this.rows.length <= 1) {
      return; // Keep at least one row
    }
    this.rows.splice(rowIdx, 1);
    this.updateNode();
    this.render();
  }

  private updateNode(): void {
    const pos = this.getPos();
    if (pos === undefined) return;

    const tr = this.view.state.tr.setNodeMarkup(pos, undefined, {
      headers: this.headers,
      rows: this.rows,
      separator: this.separatorLine,
    });
    this.view.dispatch(tr);
  }

  stopEvent(_event: Event): boolean {
    // Allow all events in the table (editing, clicking buttons)
    return true;
  }

  ignoreMutation(): boolean {
    // We manage our own mutations
    return true;
  }

  update(node: Node): boolean {
    if (node.type.name !== "table") return false;

    // Check if data actually changed (avoid re-render loops)
    const newHeaders = node.attrs.headers as string[];
    const newRows = node.attrs.rows as string[][];
    const newSeparatorLine = (node.attrs.separator as string | null) ?? null;

    const headersMatch =
      newHeaders.length === this.headers.length &&
      newHeaders.every((h, i) => h === this.headers[i]);

    const rowsMatch =
      newRows.length === this.rows.length &&
      newRows.every(
        (row, i) =>
          row.length === this.rows[i].length && row.every((cell, j) => cell === this.rows[i][j]),
      );

    if (newSeparatorLine !== this.separatorLine) {
      this.separatorLine = newSeparatorLine;
    }

    if (!headersMatch || !rowsMatch) {
      this.headers = [...newHeaders];
      this.rows = newRows.map((r) => [...r]);
      this.render();
    }

    return true;
  }
}

export class PlanEditor {
  private container: HTMLElement;
  private editorHost: HTMLElement;
  private view: EditorView;
  private baseline: string = "";
  private options: PlanEditorOptions;
  private diagramViewer: DiagramViewer;
  private lineNumbers: HTMLElement;
  private lineNumbersFrame: number | null = null;
  private resizeHandler: (() => void) | null = null;
  private scrollHandler: (() => void) | null = null;

  constructor(parent: HTMLElement, options: PlanEditorOptions = {}) {
    this.options = options;
    this.baseline = options.baseline ?? options.value ?? "";

    // Create viewers
    this.diagramViewer = new DiagramViewer();

    // Create container
    this.container = document.createElement("div");
    this.container.className = "plan-editor-container";

    this.lineNumbers = document.createElement("div");
    this.lineNumbers.className = "plan-editor-gutter";
    const gutterInner = document.createElement("div");
    gutterInner.className = "plan-editor-gutter-inner";
    const gutterToggles = document.createElement("div");
    gutterToggles.className = "plan-editor-gutter-col plan-editor-gutter-toggles";
    const gutterLines = document.createElement("div");
    gutterLines.className = "plan-editor-gutter-col plan-editor-gutter-lines";
    gutterInner.appendChild(gutterToggles);
    gutterInner.appendChild(gutterLines);
    this.lineNumbers.appendChild(gutterInner);

    this.editorHost = document.createElement("div");
    this.editorHost.className = "plan-editor-host-inner";

    this.container.appendChild(this.lineNumbers);
    this.container.appendChild(this.editorHost);
    parent.appendChild(this.container);

    // Parse initial content
    const doc = parseMarkdown(options.value ?? "");

    // Set initial baseline
    baselineDoc = parseMarkdown(this.baseline);

    // Create editor state
    const state = EditorState.create({
      doc,
      plugins: [
        history(),
        inputRules({
          rules: [
            textblockTypeInputRule(/^(#{1,6})\s$/, schema.nodes.heading, (match) => ({
              level: match[1].length,
            })),
            wrappingInputRule(/^(\s*)([-*+])\s$/, schema.nodes.bullet_list),
            wrappingInputRule(/^(\s*)(\d+)\.\s$/, schema.nodes.ordered_list, (match) => ({
              order: Number(match[2]),
            })),
          ],
        }),
        // listEditPlugin and headingEditPlugin need to be before baseKeymap to intercept
        // Backspace/Delete before ProseMirror's default handling (joinBackward)
        listEditPlugin(),
        headingEditPlugin(),
        keymap({
          "Mod-b": toggleMark(schema.marks.strong),
          "Mod-i": toggleMark(schema.marks.em),
          "Mod-Shift-x": toggleMark(schema.marks.strike),
          Enter: splitListItem(schema.nodes.list_item),
          Tab: sinkListItem(schema.nodes.list_item),
          "Shift-Tab": liftListItem(schema.nodes.list_item),
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
        }),
        keymap(baseKeymap),
        diffPlugin(),
        sectionFoldPlugin(),
      ],
    });

    // Create editor view
    this.view = new EditorView(this.editorHost, {
      state,
      editable: () => !options.readOnly,
      nodeViews: {
        diagram: (node) => new DiagramNodeView(node, this.diagramViewer),
        table: (node, view, getPos) => {
          // Find table index in current document to match with baseline
          const pos = getPos();
          let tableIndex = 0;
          if (pos !== undefined) {
            view.state.doc.nodesBetween(0, pos, (n) => {
              if (n.type.name === "table") tableIndex++;
            });
          }

          // Create baseline getter that finds matching table by index
          const getBaseline = (): { headers: string[]; rows: string[][] } | null => {
            if (!baselineDoc) return null;

            let currentIndex = 0;
            let baselineTable: { headers: string[]; rows: string[][] } | null = null;

            baselineDoc.forEach((n) => {
              if (n.type.name === "table") {
                if (currentIndex === tableIndex) {
                  baselineTable = {
                    headers: n.attrs.headers as string[],
                    rows: n.attrs.rows as string[][],
                  };
                }
                currentIndex++;
              }
            });

            return baselineTable;
          };

          return new TableNodeView(node, view, getPos, getBaseline);
        },
      },
      dispatchTransaction: (tr: Transaction) => {
        const newState = this.view.state.apply(tr);
        this.view.updateState(newState);

        if (tr.docChanged) {
          const markdown = serializeMarkdown(newState.doc);
          this.options.onChange?.(markdown);
        }
        this.scheduleLineNumberUpdate();
      },
      attributes: {
        class: "plan-editor",
        spellcheck: "true",
      },
    });

    this.scrollHandler = () => this.scheduleLineNumberUpdate();
    this.container.addEventListener("scroll", this.scrollHandler);

    this.scheduleLineNumberUpdate();
    this.resizeHandler = () => this.scheduleLineNumberUpdate();
    window.addEventListener("resize", this.resizeHandler);
  }

  /** Get current content as markdown */
  getValue(): string {
    return serializeMarkdown(this.view.state.doc);
  }

  /** Set content from markdown */
  setValue(value: string, options: { addToHistory?: boolean } = {}): void {
    const doc = parseMarkdown(value);
    const tr = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content);
    if (options.addToHistory === false) {
      tr.setMeta("addToHistory", false);
    }
    this.view.dispatch(tr);
    this.scheduleLineNumberUpdate();
  }

  /** Set baseline for diff comparison */
  setBaseline(baseline: string): void {
    this.baseline = baseline;
    baselineDoc = parseMarkdown(baseline);
    // Trigger a transaction to recalculate decorations
    this.view.dispatch(this.view.state.tr);
    this.scheduleLineNumberUpdate();
  }

  /** Set read-only state */
  setReadOnly(readOnly: boolean): void {
    this.options.readOnly = readOnly;
    this.view.setProps({
      editable: () => !readOnly,
    });
  }

  /** Check if content differs from baseline */
  isDirty(): boolean {
    return this.getValue() !== this.baseline;
  }

  /** Focus the editor */
  focus(): void {
    this.view.focus();
  }

  /** Undo last change */
  undo(): boolean {
    return undo(this.view.state, this.view.dispatch);
  }

  /** Redo last undone change */
  redo(): boolean {
    return redo(this.view.state, this.view.dispatch);
  }

  /** Check if there's anything to undo */
  canUndo(): boolean {
    return undoDepth(this.view.state) > 0;
  }

  /** Check if there's anything to redo */
  canRedo(): boolean {
    return redoDepth(this.view.state) > 0;
  }

  /** Destroy and clean up */
  destroy(): void {
    if (this.lineNumbersFrame !== null) {
      if (typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.lineNumbersFrame);
      } else {
        clearTimeout(this.lineNumbersFrame);
      }
      this.lineNumbersFrame = null;
    }
    if (this.resizeHandler) {
      window.removeEventListener("resize", this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.scrollHandler) {
      this.container.removeEventListener("scroll", this.scrollHandler);
      this.scrollHandler = null;
    }
    this.view.destroy();
    this.container.remove();
    this.diagramViewer.destroy();
  }

  private scheduleLineNumberUpdate(): void {
    if (this.lineNumbersFrame !== null) {
      return;
    }
    const schedule =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame
        : (callback: FrameRequestCallback) => window.setTimeout(callback, 16);
    this.lineNumbersFrame = schedule(() => {
      this.lineNumbersFrame = null;
      this.updateLineNumbers();
    });
  }

  private getHeadingPosFromDom(el: Element): number | null {
    try {
      const pos = this.view.posAtDOM(el, 0);
      const resolved = this.view.state.doc.resolve(pos);
      for (let depth = resolved.depth; depth > 0; depth--) {
        const node = resolved.node(depth);
        if (node.type.name === "heading") {
          return resolved.before(depth);
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  private collectLineEntries(): Array<{ top: number; headingPos?: number; hidden: boolean }> {
    const root = this.view.dom as HTMLElement | null;
    if (!root) {
      return [];
    }

    const lineEntries: Array<{ top: number; headingPos?: number; hidden: boolean }> = [];
    const selector = [
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "li",
      "pre",
      ".table-widget thead tr",
      ".table-widget tbody tr",
    ].join(", ");

    const elements = Array.from(root.querySelectorAll(selector));
    const pushTop = (top: number, hidden: boolean, headingPos?: number) => {
      lineEntries.push({ top, headingPos, hidden });
    };

    for (const el of elements) {
      const hidden = Boolean(el.closest(".pm-collapsed"));
      const tag = el.tagName.toLowerCase();
      if (tag === "p" && el.closest("li")) {
        continue;
      }
      if (tag === "pre") {
        const text = el.textContent ?? "";
        const lineCount = Math.max(1, text.split("\n").length);
        const rect = el.getBoundingClientRect();
        const computed = window.getComputedStyle(el);
        const lineHeight = parseFloat(computed.lineHeight);
        const fallbackHeight = lineCount > 0 ? rect.height / lineCount : 16;
        const step =
          Number.isFinite(lineHeight) && lineHeight > 0
            ? lineHeight
            : Number.isFinite(fallbackHeight) && fallbackHeight > 0
              ? fallbackHeight
              : 16;
        for (let i = 0; i < lineCount; i++) {
          pushTop(rect.top + step * i, hidden);
        }
        continue;
      }

      const rect = el.getBoundingClientRect();
      const headingPos = tag.startsWith("h")
        ? (this.getHeadingPosFromDom(el) ?? undefined)
        : undefined;
      pushTop(rect.top, hidden, headingPos);
    }

    return lineEntries;
  }

  private updateLineNumbers(): void {
    const gutterInner = this.lineNumbers.querySelector(
      ".plan-editor-gutter-inner",
    ) as HTMLElement | null;
    if (!gutterInner) {
      return;
    }

    const gutterToggles = gutterInner.querySelector(
      ".plan-editor-gutter-toggles",
    ) as HTMLElement | null;
    const gutterLines = gutterInner.querySelector(
      ".plan-editor-gutter-lines",
    ) as HTMLElement | null;
    if (!gutterToggles || !gutterLines) {
      return;
    }

    gutterToggles.innerHTML = "";
    gutterLines.innerHTML = "";

    const gutterRect = gutterInner.getBoundingClientRect();
    const lineEntries = this.collectLineEntries();
    if (lineEntries.length === 0) {
      return;
    }

    const foldState = sectionFoldKey.getState(this.view.state);
    const collapsed = foldState?.collapsed ?? new Set<number>();

    for (let i = 0; i < lineEntries.length; i++) {
      const entry = lineEntries[i];
      if (entry.hidden) {
        continue;
      }
      const top = Math.round(entry.top - gutterRect.top);
      if (entry.headingPos !== undefined) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "plan-editor-line-toggle";
        const isCollapsed = collapsed.has(entry.headingPos);
        toggle.textContent = isCollapsed ? ">" : "v";
        toggle.setAttribute("aria-label", isCollapsed ? "Expand section" : "Collapse section");
        toggle.dataset.headingPos = String(entry.headingPos);
        toggle.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.view.dispatch(
            this.view.state.tr.setMeta(sectionFoldKey, { type: "toggle", pos: entry.headingPos! }),
          );
        });
        toggle.style.top = `${top}px`;
        gutterToggles.appendChild(toggle);
      }
      const el = document.createElement("div");
      el.className = "plan-editor-line-number";
      el.textContent = String(i + 1);
      el.style.top = `${top}px`;
      gutterLines.appendChild(el);
    }
  }
}
