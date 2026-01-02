/**
 * DiffTextarea - A mobile-friendly textarea with character-level diff highlighting
 *
 * Uses a transparent textarea overlaid on a highlight layer for:
 * - Native iOS autocomplete/autocorrect support
 * - Character-level diff highlighting
 * - Smooth scroll sync via CSS transforms
 * - Tap-to-expand code block viewer for diagrams
 */

import * as Diff from "diff";

// Type augmentation for diffChars which exists but isn't in @types/diff
declare module "diff" {
  export function diffChars(
    oldStr: string,
    newStr: string,
  ): Array<{ value: string; added?: boolean; removed?: boolean }>;
}

export interface DiffTextareaOptions {
  /** Initial content */
  value?: string;
  /** Baseline content for diff comparison */
  baseline?: string;
  /** Whether the editor is read-only */
  readOnly?: boolean;
  /** Callback when content changes */
  onChange?: (value: string) => void;
  /** Callback when scroll position changes */
  onScroll?: () => void;
}

interface CodeBlock {
  start: number;
  end: number;
  lang: string;
  content: string;
  fullMatch: string;
}

export class DiffTextarea {
  private container: HTMLElement;
  private bgLayer: HTMLElement;
  private highlightLayer: HTMLElement;
  private highlightContent: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private baseline: string = "";
  private rafId: number | null = null;
  private options: DiffTextareaOptions;

  // Code block viewer
  private codeBlocks: string[] = [];
  private viewerBackdrop: HTMLElement | null = null;
  private viewerContent: HTMLElement | null = null;
  private viewerContainer: HTMLElement | null = null;
  private currentZoom = 100;
  private initialPinchDistance = 0;
  private initialPinchZoom = 100;

  constructor(parent: HTMLElement, options: DiffTextareaOptions = {}) {
    this.options = options;
    this.baseline = options.baseline ?? options.value ?? "";

    // Create container
    this.container = document.createElement("div");
    this.container.className = "diff-textarea-container";

    // Create background layer
    this.bgLayer = document.createElement("div");
    this.bgLayer.className = "diff-textarea-bg-layer";

    // Create textarea (between bg and highlight)
    this.textarea = document.createElement("textarea");
    this.textarea.className = "diff-textarea-input";
    this.textarea.spellcheck = true;
    this.textarea.autocomplete = "on";
    this.textarea.setAttribute("autocorrect", "on");
    this.textarea.setAttribute("autocapitalize", "on");

    if (options.readOnly) {
      this.textarea.readOnly = true;
    }

    if (options.value) {
      this.textarea.value = options.value;
    }

    // Create highlight layer (on top, but pointer-events: none)
    this.highlightLayer = document.createElement("div");
    this.highlightLayer.className = "diff-textarea-highlight-layer";

    this.highlightContent = document.createElement("div");
    this.highlightContent.className = "diff-textarea-highlight-content";
    this.highlightLayer.appendChild(this.highlightContent);

    // Assemble in correct z-order
    this.container.appendChild(this.bgLayer);
    this.container.appendChild(this.textarea);
    this.container.appendChild(this.highlightLayer);
    parent.appendChild(this.container);

    // Create code viewer modal
    this.createCodeViewer();

    // Event listeners
    this.textarea.addEventListener("input", this.handleInput);
    this.textarea.addEventListener("scroll", this.handleScroll, { passive: true });
    this.highlightContent.addEventListener("click", this.handleExpandClick);

    // Initial render
    this.updateHighlights();
  }

  private createCodeViewer() {
    // Backdrop
    this.viewerBackdrop = document.createElement("div");
    this.viewerBackdrop.className = "diff-textarea-viewer-backdrop";

    // Container with scroll
    this.viewerContainer = document.createElement("div");
    this.viewerContainer.className = "diff-textarea-viewer-container";

    // Content
    this.viewerContent = document.createElement("div");
    this.viewerContent.className = "diff-textarea-viewer-content";
    this.viewerContainer.appendChild(this.viewerContent);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "diff-textarea-viewer-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.closeCodeViewer());

    // Zoom controls
    const zoomControls = document.createElement("div");
    zoomControls.className = "diff-textarea-viewer-zoom";

    const zoomOut = document.createElement("button");
    zoomOut.textContent = "−";
    zoomOut.addEventListener("click", () => this.zoom(-25));

    const zoomLabel = document.createElement("div");
    zoomLabel.className = "diff-textarea-viewer-zoom-label";
    zoomLabel.textContent = "100%";

    const zoomIn = document.createElement("button");
    zoomIn.textContent = "+";
    zoomIn.addEventListener("click", () => this.zoom(25));

    zoomControls.appendChild(zoomOut);
    zoomControls.appendChild(zoomLabel);
    zoomControls.appendChild(zoomIn);

    this.viewerBackdrop.appendChild(this.viewerContainer);
    this.viewerBackdrop.appendChild(closeBtn);
    this.viewerBackdrop.appendChild(zoomControls);

    // Close on backdrop click
    this.viewerBackdrop.addEventListener("click", (e) => {
      if (e.target === this.viewerBackdrop) this.closeCodeViewer();
    });

    // Close on Escape
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.viewerBackdrop?.classList.contains("open")) {
        this.closeCodeViewer();
      }
    });

    // Pinch-to-zoom
    this.viewerContainer.addEventListener("touchstart", this.handleTouchStart, { passive: true });
    this.viewerContainer.addEventListener("touchmove", this.handleTouchMove, { passive: false });
    this.viewerContainer.addEventListener("touchend", this.handleTouchEnd, { passive: true });

    document.body.appendChild(this.viewerBackdrop);
  }

  private getTouchDistance(touches: TouchList): number {
    if (touches.length < 2) return 0;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private handleTouchStart = (e: TouchEvent) => {
    if (e.touches.length === 2) {
      this.initialPinchDistance = this.getTouchDistance(e.touches);
      this.initialPinchZoom = this.currentZoom;
    }
  };

  private handleTouchMove = (e: TouchEvent) => {
    if (e.touches.length === 2 && this.initialPinchDistance > 0) {
      e.preventDefault(); // Prevent scroll during pinch
      const currentDistance = this.getTouchDistance(e.touches);
      const scale = currentDistance / this.initialPinchDistance;
      this.currentZoom = Math.max(25, Math.min(300, Math.round(this.initialPinchZoom * scale)));
      this.updateZoom();
    }
  };

  private handleTouchEnd = () => {
    this.initialPinchDistance = 0;
  };

  private handleExpandClick = (e: Event) => {
    const target = e.target as HTMLElement;
    const expandBtn = target.closest(".diff-textarea-code-expand");
    if (expandBtn) {
      const blockIdx = parseInt(expandBtn.getAttribute("data-block") || "0", 10);
      if (this.codeBlocks[blockIdx] !== undefined) {
        this.openCodeViewer(this.codeBlocks[blockIdx]);
      }
    }
  };

  private openCodeViewer(content: string) {
    if (!this.viewerContent || !this.viewerBackdrop) return;
    this.viewerContent.textContent = content;
    this.currentZoom = 100;
    this.updateZoom();
    this.viewerBackdrop.classList.add("open");
    document.body.style.overflow = "hidden";
  }

  private closeCodeViewer() {
    if (!this.viewerBackdrop) return;
    this.viewerBackdrop.classList.remove("open");
    document.body.style.overflow = "";
  }

  private zoom(delta: number) {
    this.currentZoom = Math.max(25, Math.min(200, this.currentZoom + delta));
    this.updateZoom();
  }

  private updateZoom() {
    if (!this.viewerContent || !this.viewerBackdrop) return;
    this.viewerContent.style.transform = `scale(${this.currentZoom / 100})`;
    const label = this.viewerBackdrop.querySelector(".diff-textarea-viewer-zoom-label");
    if (label) label.textContent = `${this.currentZoom}%`;
  }

  private handleInput = () => {
    this.updateHighlights();
    this.options.onChange?.(this.textarea.value);
  };

  private handleScroll = () => {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      const scrollTop = this.textarea.scrollTop;
      const scrollLeft = this.textarea.scrollLeft;
      this.highlightContent.style.transform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;
    });
    this.options.onScroll?.();
  };

  private escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private parseCodeBlocks(text: string): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      blocks.push({
        start: match.index,
        end: match.index + match[0].length,
        lang: match[1],
        content: match[2],
        fullMatch: match[0],
      });
    }
    return blocks;
  }

  private renderWithCodeBlocks(text: string, diffClass: string = ""): string {
    const blocks = this.parseCodeBlocks(text);
    if (blocks.length === 0) {
      return diffClass
        ? `<span class="${diffClass}">${this.escapeHtml(text)}</span>`
        : this.escapeHtml(text);
    }

    let result = "";
    let lastEnd = 0;

    for (const block of blocks) {
      // Text before this code block
      const before = text.slice(lastEnd, block.start);
      if (before) {
        result += diffClass
          ? `<span class="${diffClass}">${this.escapeHtml(before)}</span>`
          : this.escapeHtml(before);
      }

      // The code block itself
      const blockIdx = this.codeBlocks.length;
      this.codeBlocks.push(block.content);

      result += `<span class="diff-textarea-code-wrapper ${diffClass}">`;
      result += `<span class="diff-textarea-code-expand" data-block="${blockIdx}">⤢</span>`;
      result += `<span class="diff-textarea-code-content">${this.escapeHtml(block.fullMatch)}</span>`;
      result += `</span>`;

      lastEnd = block.end;
    }

    // Text after last code block
    const after = text.slice(lastEnd);
    if (after) {
      result += diffClass
        ? `<span class="${diffClass}">${this.escapeHtml(after)}</span>`
        : this.escapeHtml(after);
    }

    return result;
  }

  private updateHighlights() {
    const currentContent = this.textarea.value;
    const lineChanges = Diff.diffLines(this.baseline, currentContent);

    // Reset code blocks
    this.codeBlocks = [];

    let html = "";
    let i = 0;

    while (i < lineChanges.length) {
      const change = lineChanges[i];

      if (change.removed && lineChanges[i + 1]?.added) {
        // Modification: do char-level diff
        const removed = change;
        const added = lineChanges[i + 1];

        const charChanges = Diff.diffChars(removed.value, added.value);
        let lineHtml = "";

        for (const charChange of charChanges) {
          if (charChange.added) {
            lineHtml += `<span class="diff-char-added">${this.escapeHtml(charChange.value)}</span>`;
          } else if (!charChange.removed) {
            lineHtml += this.escapeHtml(charChange.value);
          }
        }

        html += `<span class="diff-line-modified">${lineHtml}</span>`;
        i += 2;
      } else if (change.added) {
        // Pure addition - check for code blocks
        html += this.renderWithCodeBlocks(change.value, "diff-line-added");
        i++;
      } else if (change.removed) {
        html += `<span class="diff-line-deleted-marker"></span>`;
        i++;
      } else {
        // Unchanged - check for code blocks
        html += this.renderWithCodeBlocks(change.value);
        i++;
      }
    }

    this.highlightContent.innerHTML = html;
  }

  /** Get current content */
  getValue(): string {
    return this.textarea.value;
  }

  /** Set content */
  setValue(value: string) {
    this.textarea.value = value;
    this.updateHighlights();
    // Reset scroll
    this.textarea.scrollTop = 0;
    this.highlightContent.style.transform = "translate(0px, 0px)";
  }

  /** Set baseline for diff comparison */
  setBaseline(baseline: string) {
    this.baseline = baseline;
    this.updateHighlights();
  }

  /** Set read-only state */
  setReadOnly(readOnly: boolean) {
    this.textarea.readOnly = readOnly;
  }

  /** Check if content differs from baseline */
  isDirty(): boolean {
    return this.textarea.value !== this.baseline;
  }

  /** Focus the textarea */
  focus() {
    this.textarea.focus();
  }

  /** Get the textarea element for direct access */
  getTextarea(): HTMLTextAreaElement {
    return this.textarea;
  }

  /** Destroy and clean up */
  destroy() {
    this.textarea.removeEventListener("input", this.handleInput);
    this.textarea.removeEventListener("scroll", this.handleScroll);
    this.highlightContent.removeEventListener("click", this.handleExpandClick);
    this.viewerContainer?.removeEventListener("touchstart", this.handleTouchStart);
    this.viewerContainer?.removeEventListener("touchmove", this.handleTouchMove);
    this.viewerContainer?.removeEventListener("touchend", this.handleTouchEnd);
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
    }
    this.viewerBackdrop?.remove();
    this.container.remove();
  }
}

/** CSS styles for the DiffTextarea component */
export const diffTextareaStyles = `
  .diff-textarea-container {
    position: relative;
    width: 100%;
    height: 100%;
  }

  .diff-textarea-bg-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: var(--editor-bg, #fff);
    z-index: 0;
  }

  .diff-textarea-highlight-layer {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 10;
  }

  .diff-textarea-highlight-content {
    padding: var(--editor-padding, 12px);
    font-family: var(--editor-font, ui-monospace, "SF Mono", Menlo, Monaco, monospace);
    font-size: var(--editor-font-size, 16px);
    line-height: var(--editor-line-height, 1.5);
    white-space: pre-wrap;
    word-wrap: break-word;
    color: var(--editor-fg, #1a1a1a);
    will-change: transform;
  }

  .diff-textarea-input {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    padding: var(--editor-padding, 12px);
    font-family: var(--editor-font, ui-monospace, "SF Mono", Menlo, Monaco, monospace);
    font-size: var(--editor-font-size, 16px);
    line-height: var(--editor-line-height, 1.5);
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    color: transparent;
    -webkit-text-fill-color: transparent;
    caret-color: var(--editor-fg, #1a1a1a);
    z-index: 5;
  }

  .diff-textarea-input:read-only {
    cursor: default;
  }

  /* Diff highlighting */
  .diff-line-added {
    background: var(--diff-added-bg, rgba(80, 180, 80, 0.2));
    display: block;
  }

  .diff-line-modified {
    background: var(--diff-modified-bg, rgba(255, 180, 50, 0.15));
    display: block;
  }

  .diff-char-added {
    background: var(--diff-added-char, rgba(80, 200, 80, 0.4));
    border-radius: 2px;
  }

  .diff-line-deleted-marker::before {
    content: "";
    display: block;
    height: 2px;
    background: var(--diff-deleted-marker, rgba(220, 80, 80, 0.6));
    margin: -1px 0;
  }

  /* Code block styling */
  .diff-textarea-code-wrapper {
    position: relative;
    display: block;
    background: rgba(128, 128, 128, 0.1);
    border-radius: 4px;
    margin: 4px 0;
  }

  .diff-textarea-code-content {
    display: block;
    white-space: pre;
    overflow: hidden;
  }

  .diff-textarea-code-expand {
    position: absolute;
    top: 4px;
    right: 4px;
    width: 44px;
    height: 44px;
    background: var(--editor-bg, #fff);
    border: 1px solid var(--editor-border, #ccc);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 18px;
    cursor: pointer;
    pointer-events: auto;
    opacity: 0.95;
    transition: opacity 0.15s, transform 0.15s;
    z-index: 20;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    -webkit-tap-highlight-color: rgba(0,0,0,0.1);
  }

  .diff-textarea-code-expand:hover {
    opacity: 1;
    transform: scale(1.1);
  }

  .diff-textarea-code-expand:active {
    transform: scale(0.95);
  }

  /* Code viewer modal */
  .diff-textarea-viewer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
    opacity: 0;
    visibility: hidden;
    transition: opacity 0.2s, visibility 0.2s;
  }

  .diff-textarea-viewer-backdrop.open {
    opacity: 1;
    visibility: visible;
  }

  .diff-textarea-viewer-container {
    position: relative;
    width: 100%;
    height: 100%;
    max-width: 100%;
    max-height: 100%;
    overflow: auto;
    -webkit-overflow-scrolling: touch;
    background: var(--editor-bg, #fff);
    border-radius: 8px;
    touch-action: pan-x pan-y pinch-zoom;
  }

  .diff-textarea-viewer-content {
    padding: 16px;
    font-family: var(--editor-font, ui-monospace, "SF Mono", Menlo, Monaco, monospace);
    font-size: var(--editor-font-size, 16px);
    line-height: var(--editor-line-height, 1.5);
    white-space: pre;
    color: var(--editor-fg, #1a1a1a);
    min-width: min-content;
    transform-origin: 0 0;
    transition: transform 0.1s ease-out;
  }

  .diff-textarea-viewer-close {
    position: fixed;
    top: 16px;
    right: 16px;
    width: 44px;
    height: 44px;
    background: var(--editor-bg, #fff);
    border: 1px solid var(--editor-border, #ccc);
    border-radius: 50%;
    font-size: 24px;
    cursor: pointer;
    z-index: 1001;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .diff-textarea-viewer-zoom {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 8px;
    z-index: 1001;
  }

  .diff-textarea-viewer-zoom button {
    width: 44px;
    height: 44px;
    border-radius: 50%;
    font-size: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--editor-bg, #fff);
    border: 1px solid var(--editor-border, #ccc);
    cursor: pointer;
  }

  .diff-textarea-viewer-zoom-label {
    display: flex;
    align-items: center;
    padding: 0 12px;
    background: var(--editor-bg, #fff);
    border: 1px solid var(--editor-border, #ccc);
    border-radius: 22px;
    font-size: 14px;
    min-width: 60px;
    justify-content: center;
  }

  /* Dark mode */
  @media (prefers-color-scheme: dark) {
    .diff-textarea-bg-layer {
      background: var(--editor-bg, #1e1e1e);
    }

    .diff-textarea-highlight-content {
      color: var(--editor-fg, #d4d4d4);
    }

    .diff-textarea-input {
      caret-color: var(--editor-fg, #d4d4d4);
    }

    .diff-line-added {
      background: var(--diff-added-bg, rgba(80, 180, 80, 0.12));
    }

    .diff-line-modified {
      background: var(--diff-modified-bg, rgba(255, 180, 50, 0.1));
    }

    .diff-char-added {
      background: var(--diff-added-char, rgba(80, 200, 80, 0.3));
    }

    .diff-textarea-code-expand {
      background: var(--editor-bg, #1e1e1e);
      border-color: var(--editor-border, #444);
    }

    .diff-textarea-viewer-container {
      background: var(--editor-bg, #1e1e1e);
    }

    .diff-textarea-viewer-content {
      color: var(--editor-fg, #d4d4d4);
    }

    .diff-textarea-viewer-close,
    .diff-textarea-viewer-zoom button,
    .diff-textarea-viewer-zoom-label {
      background: var(--editor-bg, #1e1e1e);
      border-color: var(--editor-border, #444);
      color: var(--editor-fg, #d4d4d4);
    }
  }
`;
