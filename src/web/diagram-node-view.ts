/**
 * Custom NodeView for diagram blocks
 *
 * Renders as a non-editable, horizontally scrollable container
 * for ASCII diagrams. Optimized for touch scrolling on iOS.
 */

import { Node } from "prosemirror-model";
import { EditorView, NodeView } from "prosemirror-view";

export class DiagramNodeView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: Node, _view: EditorView, _getPos: () => number | undefined) {
    // Outer wrapper for scroll
    this.dom = document.createElement("div");
    this.dom.className = "diagram-wrapper";
    this.dom.contentEditable = "false";

    // Inner pre for content
    const pre = document.createElement("pre");
    pre.className = "diagram-block";

    const code = document.createElement("code");
    code.textContent = node.textContent;

    pre.appendChild(code);
    this.dom.appendChild(pre);

    // contentDOM is null since diagram is not editable
    this.contentDOM = code;
  }

  // Prevent editing
  stopEvent(): boolean {
    return false; // Allow scroll events to pass through
  }

  // Don't allow mutation from user input
  ignoreMutation(): boolean {
    return true;
  }

  // Update when node content changes
  update(node: Node): boolean {
    if (node.type.name !== "diagram") return false;
    const code = this.dom.querySelector("code");
    if (code) {
      code.textContent = node.textContent;
    }
    return true;
  }

  destroy(): void {
    // Cleanup if needed
  }
}

/**
 * Factory function for creating DiagramNodeView instances
 */
export function diagramNodeView(
  node: Node,
  view: EditorView,
  getPos: () => number | undefined,
): DiagramNodeView {
  return new DiagramNodeView(node, view, getPos);
}
