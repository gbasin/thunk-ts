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

import { EditorState, Transaction, Plugin } from "prosemirror-state";
import { EditorView, Decoration, DecorationSet } from "prosemirror-view";
import { keymap } from "prosemirror-keymap";
import { baseKeymap } from "prosemirror-commands";
import { history, undo, redo } from "prosemirror-history";
import { Node } from "prosemirror-model";
import * as Diff from "diff";
import { parseMarkdown, serializeMarkdown } from "./prosemirror-schema.js";

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

// Extract plain text with position mapping from a doc
function extractTextWithPositions(doc: Node): { text: string; positions: number[] } {
  const text: string[] = [];
  const positions: number[] = [];

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      for (let i = 0; i < node.text.length; i++) {
        text.push(node.text[i]);
        positions.push(pos + i);
      }
    }
    return true;
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
  const changes = Diff.diffChars(base.text, current.text);

  let currentIdx = 0;
  let _baseIdx = 0;

  for (const change of changes) {
    const len = change.value.length;

    if (change.added) {
      // Added text - highlight in current doc
      const startPos = current.positions[currentIdx];
      const endPos = current.positions[currentIdx + len - 1];

      if (startPos !== undefined && endPos !== undefined) {
        decorations.push(Decoration.inline(startPos, endPos + 1, { class: "diff-added" }));
      }
      currentIdx += len;
    } else if (change.removed) {
      // Removed text - just track position, no inline marker
      // Users can see deletions via "Show Diff" button
      _baseIdx += len;
    } else {
      // Unchanged
      currentIdx += len;
      _baseIdx += len;
    }
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

// Diff viewer management
class DiffViewer {
  private backdrop: HTMLElement;
  private content: HTMLElement;

  constructor() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "diff-viewer-backdrop";

    const container = document.createElement("div");
    container.className = "diff-viewer-container";

    const header = document.createElement("div");
    header.className = "diff-viewer-header";

    const title = document.createElement("h2");
    title.textContent = "Changes";

    const closeBtn = document.createElement("button");
    closeBtn.className = "diff-viewer-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());

    header.appendChild(title);
    header.appendChild(closeBtn);

    this.content = document.createElement("div");
    this.content.className = "diff-viewer-content";

    container.appendChild(header);
    container.appendChild(this.content);
    this.backdrop.appendChild(container);

    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) this.close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.backdrop.classList.contains("open")) {
        this.close();
      }
    });

    document.body.appendChild(this.backdrop);
  }

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  show(baseText: string, currentText: string): void {
    if (baseText === currentText) {
      this.content.innerHTML = '<div class="diff-no-changes">No changes</div>';
    } else {
      const changes = Diff.diffLines(baseText, currentText);
      let html = "";

      for (const change of changes) {
        const lines = change.value.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (i === lines.length - 1 && line === "") continue;

          if (change.added) {
            html += `<div class="diff-line-add">+ ${this.escapeHtml(line)}</div>`;
          } else if (change.removed) {
            html += `<div class="diff-line-remove">- ${this.escapeHtml(line)}</div>`;
          } else {
            html += `<div class="diff-line-context">  ${this.escapeHtml(line)}</div>`;
          }
        }
      }

      this.content.innerHTML = html;
    }

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

export class PlanEditor {
  private container: HTMLElement;
  private view: EditorView;
  private baseline: string = "";
  private options: PlanEditorOptions;
  private diagramViewer: DiagramViewer;
  private diffViewer: DiffViewer;

  constructor(parent: HTMLElement, options: PlanEditorOptions = {}) {
    this.options = options;
    this.baseline = options.baseline ?? options.value ?? "";

    // Create viewers
    this.diagramViewer = new DiagramViewer();
    this.diffViewer = new DiffViewer();

    // Create container
    this.container = document.createElement("div");
    this.container.className = "plan-editor-container";
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
        keymap({
          "Mod-z": undo,
          "Mod-Shift-z": redo,
          "Mod-y": redo,
        }),
        keymap(baseKeymap),
        diffPlugin(),
      ],
    });

    // Create editor view
    this.view = new EditorView(this.container, {
      state,
      editable: () => !options.readOnly,
      nodeViews: {
        diagram: (node) => new DiagramNodeView(node, this.diagramViewer),
      },
      dispatchTransaction: (tr: Transaction) => {
        const newState = this.view.state.apply(tr);
        this.view.updateState(newState);

        if (tr.docChanged) {
          const markdown = serializeMarkdown(newState.doc);
          this.options.onChange?.(markdown);
        }
      },
      attributes: {
        class: "plan-editor",
        spellcheck: "true",
      },
    });
  }

  /** Get current content as markdown */
  getValue(): string {
    return serializeMarkdown(this.view.state.doc);
  }

  /** Set content from markdown */
  setValue(value: string): void {
    const doc = parseMarkdown(value);
    const tr = this.view.state.tr.replaceWith(0, this.view.state.doc.content.size, doc.content);
    this.view.dispatch(tr);
  }

  /** Set baseline for diff comparison */
  setBaseline(baseline: string): void {
    this.baseline = baseline;
    baselineDoc = parseMarkdown(baseline);
    // Trigger a transaction to recalculate decorations
    this.view.dispatch(this.view.state.tr);
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

  /** Show diff viewer modal against a specific baseline */
  showDiffAgainst(baseline: string): void {
    const currentText = this.getValue();
    this.diffViewer.show(baseline, currentText);
  }

  /** Show diff viewer modal against the editor baseline */
  showDiff(): void {
    this.showDiffAgainst(this.baseline);
  }

  /** Destroy and clean up */
  destroy(): void {
    this.view.destroy();
    this.container.remove();
    this.diagramViewer.destroy();
    this.diffViewer.destroy();
  }
}
