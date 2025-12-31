import { LitElement, html } from "lit";
import * as Diff from "diff";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";

type Change = Diff.Change;
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";

function ensureMonacoWorkers(): void {
  const globalScope = window as typeof window & {
    MonacoEnvironment?: { getWorker: () => Worker };
  };
  if (globalScope.MonacoEnvironment) {
    return;
  }
  globalScope.MonacoEnvironment = {
    getWorker: () =>
      ({
        postMessage() {},
        terminate() {},
        addEventListener() {},
        removeEventListener() {},
        onmessage: null,
      }) as unknown as Worker,
  };
}

function formatPhase(phase: string): string {
  return phase.replace(/_/g, " ");
}

class Pl4nEditor extends LitElement {
  static properties = {
    session: { type: String, attribute: "data-session" },
    token: { type: String, attribute: "data-token" },
    turn: { type: Number, attribute: "data-turn" },
    phase: { type: String, attribute: "data-phase" },
    readOnly: {
      type: Boolean,
      attribute: "data-read-only",
      converter: (value: string | null) => value === "true",
    },
  };

  declare session: string;
  declare token: string;
  declare turn: number;
  declare phase: string;
  declare readOnly: boolean;

  private editor: monaco.editor.IStandaloneCodeEditor | null = null;
  private mtime = 0;
  private dirty = false;
  private saving = false;
  private continuing = false;
  private statusMessage = "Loading plan...";
  private draftTimer: number | null = null;
  private pollTimer: number | null = null;
  private draftContent: string | null = null;
  private hasDraft = false;
  private showDiff = false;
  private lastLoadedContent = "";
  private suppressChange = false;
  private decorationIds: string[] = [];

  // Undo/redo history
  private undoStack: Array<{ text: string; selectionStart: number; selectionEnd: number }> = [];
  private redoStack: Array<{ text: string; selectionStart: number; selectionEnd: number }> = [];
  private historyTimer: number | null = null;
  private lastHistoryText = "";

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.handleBeforeUnload);
    window.addEventListener("keydown", this.handleKeyDown);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("beforeunload", this.handleBeforeUnload);
    window.removeEventListener("keydown", this.handleKeyDown);
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  firstUpdated() {
    ensureMonacoWorkers();
    const container = this.querySelector("#editor") as HTMLElement | null;
    if (!container) {
      return;
    }
    const theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "vs-dark" : "vs";
    this.editor = monaco.editor.create(container, {
      value: "",
      language: "markdown",
      wordWrap: "on",
      minimap: { enabled: false },
      lineNumbers: "on",
      renderWhitespace: "selection",
      scrollBeyondLastLine: false,
      readOnly: this.readOnly,
      theme,
      fontSize: 16,
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: false,
      lineDecorationsWidth: 4,
      padding: { top: 8, bottom: 8 },
    });

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.save();
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void this.continueRun();
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ, () => {
      this.undo();
    });
    this.editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
      () => {
        this.redo();
      },
    );

    this.editor.onDidChangeModelContent(() => {
      if (this.suppressChange) {
        return;
      }
      this.dirty = true;
      this.statusMessage = "Unsaved changes";
      this.scheduleDraftSave();
      this.scheduleHistoryCapture();
      this.updateChangeDecorations();
      this.requestUpdate();
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (event) => {
      monaco.editor.setTheme(event.matches ? "vs-dark" : "vs");
    });

    void this.loadContent();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("readOnly") && this.editor) {
      this.editor.updateOptions({ readOnly: this.readOnly });
    }
  }

  private handleBeforeUnload = (event: BeforeUnloadEvent) => {
    if (!this.dirty || this.readOnly) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  };

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.showDiff) {
      this.showDiff = false;
      this.requestUpdate();
    }
  };

  private scheduleDraftSave() {
    if (this.readOnly) {
      return;
    }
    if (this.draftTimer !== null) {
      window.clearTimeout(this.draftTimer);
    }
    this.draftTimer = window.setTimeout(() => {
      void this.saveDraft();
    }, 2000);
  }

  private scheduleHistoryCapture() {
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
    }
    this.historyTimer = window.setTimeout(() => {
      this.captureHistory();
    }, 250);
  }

  private captureHistory() {
    if (!this.editor) return;
    const text = this.editor.getValue();
    if (text === this.lastHistoryText) return;

    const selection = this.editor.getSelection();
    const model = this.editor.getModel();
    if (!selection || !model) return;

    // Push current state before the change
    if (this.lastHistoryText !== "") {
      this.undoStack.push({
        text: this.lastHistoryText,
        selectionStart: model.getOffsetAt(selection.getStartPosition()),
        selectionEnd: model.getOffsetAt(selection.getEndPosition()),
      });
    }
    this.lastHistoryText = text;
    this.redoStack = []; // Clear redo on new changes
    this.requestUpdate();
  }

  private undo() {
    if (!this.editor || this.undoStack.length === 0) return;

    const current = this.editor.getValue();
    const selection = this.editor.getSelection();
    const model = this.editor.getModel();
    if (!selection || !model) return;

    // Save current state to redo stack
    this.redoStack.push({
      text: current,
      selectionStart: model.getOffsetAt(selection.getStartPosition()),
      selectionEnd: model.getOffsetAt(selection.getEndPosition()),
    });

    // Pop and restore from undo stack
    const state = this.undoStack.pop()!;
    this.suppressChange = true;
    this.editor.setValue(state.text);
    this.lastHistoryText = state.text;
    this.suppressChange = false;

    // Restore cursor position
    const newModel = this.editor.getModel();
    if (newModel) {
      const startPos = newModel.getPositionAt(state.selectionStart);
      const endPos = newModel.getPositionAt(state.selectionEnd);
      this.editor.setSelection(
        new monaco.Selection(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        ),
      );
    }

    this.dirty = true;
    this.updateChangeDecorations();
    this.requestUpdate();
  }

  private redo() {
    if (!this.editor || this.redoStack.length === 0) return;

    const current = this.editor.getValue();
    const selection = this.editor.getSelection();
    const model = this.editor.getModel();
    if (!selection || !model) return;

    // Save current state to undo stack
    this.undoStack.push({
      text: current,
      selectionStart: model.getOffsetAt(selection.getStartPosition()),
      selectionEnd: model.getOffsetAt(selection.getEndPosition()),
    });

    // Pop and restore from redo stack
    const state = this.redoStack.pop()!;
    this.suppressChange = true;
    this.editor.setValue(state.text);
    this.lastHistoryText = state.text;
    this.suppressChange = false;

    // Restore cursor position
    const newModel = this.editor.getModel();
    if (newModel) {
      const startPos = newModel.getPositionAt(state.selectionStart);
      const endPos = newModel.getPositionAt(state.selectionEnd);
      this.editor.setSelection(
        new monaco.Selection(
          startPos.lineNumber,
          startPos.column,
          endPos.lineNumber,
          endPos.column,
        ),
      );
    }

    this.dirty = true;
    this.updateChangeDecorations();
    this.requestUpdate();
  }

  private updateChangeDecorations() {
    if (!this.editor) {
      return;
    }
    const currentContent = this.editor.getValue();
    const lineChanges = Diff.diffLines(this.lastLoadedContent, currentContent);

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];
    let _origLine = 1;
    let currLine = 1;
    let i = 0;

    while (i < lineChanges.length) {
      const change = lineChanges[i];
      const lines = change.value.split("\n");
      const lineCount = lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;

      if (change.removed && lineChanges[i + 1]?.added) {
        // Modification: removed followed by added - do char-level diff
        const removed = change;
        const added = lineChanges[i + 1];
        const removedLines = removed.value.split("\n");
        const removedLineCount =
          removedLines[removedLines.length - 1] === ""
            ? removedLines.length - 1
            : removedLines.length;
        const addedLines = added.value.split("\n");
        const addedLineCount =
          addedLines[addedLines.length - 1] === "" ? addedLines.length - 1 : addedLines.length;

        // Char-level diff on the modified content
        const charChanges = (Diff as unknown as { diffChars: typeof Diff.diffLines }).diffChars(
          removed.value,
          added.value,
        );
        let line = currLine;
        let col = 1;

        for (const charChange of charChanges) {
          if (charChange.added) {
            // Calculate end position
            const text = charChange.value;
            let endLine = line;
            let endCol = col;
            for (const ch of text) {
              if (ch === "\n") {
                endLine++;
                endCol = 1;
              } else {
                endCol++;
              }
            }
            // Add inline decoration for added chars
            if (endLine > line || endCol > col) {
              decorations.push({
                range: new monaco.Range(line, col, endLine, endCol),
                options: {
                  inlineClassName: "char-added",
                },
              });
            }
            line = endLine;
            col = endCol;
          } else if (charChange.removed) {
            // Deleted chars - mark deletion point between lines or at position
            // We'll show a subtle marker at deletion point
          } else {
            // Unchanged - advance position
            for (const ch of charChange.value) {
              if (ch === "\n") {
                line++;
                col = 1;
              } else {
                col++;
              }
            }
          }
        }

        // Add line-level background for modified lines
        if (addedLineCount > 0) {
          decorations.push({
            range: new monaco.Range(currLine, 1, currLine + addedLineCount - 1, 1),
            options: {
              isWholeLine: true,
              className: "line-modified",
              linesDecorationsClassName: "line-modified-margin",
            },
          });
        }

        _origLine += removedLineCount;
        currLine += addedLineCount;
        i += 2;
      } else if (change.added) {
        // Pure addition
        if (lineCount > 0) {
          decorations.push({
            range: new monaco.Range(currLine, 1, currLine + lineCount - 1, 1),
            options: {
              isWholeLine: true,
              className: "line-added",
              linesDecorationsClassName: "line-added-margin",
            },
          });
        }
        currLine += lineCount;
        i++;
      } else if (change.removed) {
        // Pure deletion - show marker on next line
        if (currLine <= this.editor.getModel()!.getLineCount()) {
          decorations.push({
            range: new monaco.Range(currLine, 1, currLine, 1),
            options: {
              linesDecorationsClassName: "line-deleted-marker",
            },
          });
        }
        _origLine += lineCount;
        i++;
      } else {
        // Unchanged
        _origLine += lineCount;
        currLine += lineCount;
        i++;
      }
    }

    this.decorationIds = this.editor.deltaDecorations(this.decorationIds, decorations);
  }

  private async saveDraft() {
    if (!this.editor || this.readOnly) {
      return;
    }
    const content = this.editor.getValue();
    try {
      const response = await fetch(`/api/draft/${this.session}?t=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        throw new Error("Draft save failed");
      }
      this.hasDraft = true;
      this.draftContent = content;
      this.statusMessage = "Draft saved";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Draft save failed";
      this.requestUpdate();
    }
  }

  private async discardDraft() {
    try {
      const response = await fetch(`/api/draft/${this.session}?t=${this.token}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Draft discard failed");
      }
      this.hasDraft = false;
      this.draftContent = null;
      this.statusMessage = "Draft discarded";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Draft discard failed";
      this.requestUpdate();
    }
  }

  private async restoreDraft() {
    if (!this.editor || !this.draftContent) {
      return;
    }
    this.suppressChange = true;
    this.editor.setValue(this.draftContent);
    this.suppressChange = false;
    this.dirty = true;
    await this.discardDraft();
    this.statusMessage = "Draft restored";
    this.requestUpdate();
  }

  private async loadContent() {
    try {
      const response = await fetch(`/api/content/${this.session}?t=${this.token}`);
      if (!response.ok) {
        this.statusMessage = `Load failed (${response.status})`;
        this.requestUpdate();
        return;
      }
      const data = (await response.json()) as {
        content: string;
        mtime: number;
        turn: number;
        phase: string;
        readOnly: boolean;
        hasDraft: boolean;
        draft?: string | null;
      };
      this.mtime = data.mtime;
      this.turn = data.turn;
      this.phase = data.phase;
      this.readOnly = data.readOnly;
      this.hasDraft = data.hasDraft;
      this.draftContent = data.draft ?? null;
      this.lastLoadedContent = data.content;
      this.suppressChange = true;
      this.editor?.setValue(data.content);
      this.suppressChange = false;
      this.dirty = false;
      // Initialize undo/redo history
      this.lastHistoryText = data.content;
      this.undoStack = [];
      this.redoStack = [];
      this.statusMessage = data.readOnly ? "Read-only" : "Ready";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Load failed";
      this.requestUpdate();
    }
  }

  private async save() {
    if (this.readOnly || !this.editor || this.saving) {
      return;
    }
    this.saving = true;
    this.statusMessage = "Saving...";
    this.requestUpdate();
    try {
      const response = await fetch(`/api/save/${this.session}?t=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: this.editor.getValue(), mtime: this.mtime }),
      });
      if (response.status === 409) {
        const payload = (await response.json()) as { mtime?: number };
        if (payload.mtime) {
          this.mtime = payload.mtime;
        }
        this.statusMessage = "Stale copy. Reload to continue.";
      } else if (response.status === 423) {
        this.statusMessage = "Plan locked.";
        this.readOnly = true;
      } else if (response.ok) {
        const payload = (await response.json()) as { mtime: number };
        this.mtime = payload.mtime;
        this.dirty = false;
        this.hasDraft = false;
        this.draftContent = null;
        this.lastLoadedContent = this.editor.getValue();
        this.updateChangeDecorations();
        this.statusMessage = "Saved";
      } else {
        this.statusMessage = `Save failed (${response.status})`;
      }
    } catch {
      this.statusMessage = "Save failed";
    } finally {
      this.saving = false;
      this.requestUpdate();
    }
  }

  private async continueRun() {
    if (this.readOnly || !this.editor || this.continuing) {
      return;
    }

    // If no changes, approve instead of running another turn
    const currentContent = this.editor.getValue();
    if (currentContent === this.lastLoadedContent) {
      const confirmed = window.confirm(
        "No changes detected. This will approve the plan as final.\n\nApprove?",
      );
      if (!confirmed) {
        return;
      }
      await this.approve();
      return;
    }

    this.continuing = true;
    this.statusMessage = "Saving & running agents...";
    this.requestUpdate();
    try {
      const response = await fetch(`/api/continue/${this.session}?t=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: this.editor.getValue(), mtime: this.mtime }),
      });
      if (response.status === 409) {
        const payload = (await response.json()) as { mtime?: number };
        if (payload.mtime) {
          this.mtime = payload.mtime;
        }
        this.statusMessage = "Stale copy. Reload to continue.";
        this.continuing = false;
        this.requestUpdate();
        return;
      }
      if (response.status === 423) {
        this.statusMessage = "Plan locked.";
        this.continuing = false;
        this.readOnly = true;
        this.requestUpdate();
        return;
      }
      if (!response.ok) {
        this.statusMessage = `Continue failed (${response.status})`;
        this.continuing = false;
        this.requestUpdate();
        return;
      }
      this.pollStatus();
    } catch {
      this.statusMessage = "Continue failed";
      this.continuing = false;
      this.requestUpdate();
    }
  }

  private async approve() {
    if (this.readOnly || !this.editor) {
      return;
    }
    this.statusMessage = "Approving plan...";
    this.requestUpdate();
    try {
      const response = await fetch(`/api/approve/${this.session}?t=${this.token}`, {
        method: "POST",
      });
      if (response.status === 400) {
        this.statusMessage = "Cannot approve: unanswered questions";
        this.requestUpdate();
        return;
      }
      if (response.status === 423) {
        this.statusMessage = "Plan already locked.";
        this.readOnly = true;
        this.requestUpdate();
        return;
      }
      if (!response.ok) {
        this.statusMessage = `Approve failed (${response.status})`;
        this.requestUpdate();
        return;
      }
      this.phase = "approved";
      this.readOnly = true;
      this.statusMessage = "Plan approved!";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Approve failed";
      this.requestUpdate();
    }
  }

  private pollStatus() {
    if (this.pollTimer !== null) {
      return;
    }
    this.pollTimer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/status/${this.session}?t=${this.token}`);
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as { turn: number; phase: string };
        if (data.phase === "user_review" && data.turn !== this.turn) {
          if (this.pollTimer !== null) {
            window.clearInterval(this.pollTimer);
            this.pollTimer = null;
          }
          this.continuing = false;
          this.turn = data.turn;
          this.phase = data.phase;
          this.statusMessage = "New turn ready";
          await this.loadContent();
        } else {
          this.statusMessage = `Working (${formatPhase(data.phase)})`;
          this.requestUpdate();
        }
      } catch {
        // ignore polling errors
      }
    }, 2500);
  }

  private renderDiffModal() {
    if (!this.showDiff || !this.draftContent) {
      return null;
    }
    const diff = Diff.diffLines(this.lastLoadedContent, this.draftContent);
    return html`
      <div class="modal-backdrop" @click=${() => (this.showDiff = false)}>
        <div class="modal" @click=${(event: Event) => event.stopPropagation()}>
          <div class="header">
            <h2>Draft Diff</h2>
            <button class="button secondary" @click=${() => (this.showDiff = false)}>Close</button>
          </div>
          ${diff.map((part: Change) => {
            const cls = part.added
              ? "diff-line diff-add"
              : part.removed
                ? "diff-line diff-remove"
                : "diff-line";
            return html`<div class=${cls}>${part.value}</div>`;
          })}
        </div>
      </div>
    `;
  }

  render() {
    const approved = this.phase === "approved";
    return html`
      <div class="card editor-shell">
        <div class="header">
          <div class="header-title">
            <h1>${this.session}</h1>
            <div class="header-meta">Turn ${this.turn} - ${formatPhase(this.phase)}</div>
          </div>
          ${approved ? html`<span class="badge approved">Approved</span>` : html``}
        </div>

        ${
          this.hasDraft
            ? html`
              <div class="editor-banner">
                <span>Draft recovery available from your last autosave.</span>
                <div class="banner-actions">
                  <button class="button secondary" @click=${() => (this.showDiff = true)}>
                    View diff
                  </button>
                  <button class="button" @click=${() => this.restoreDraft()}>Restore</button>
                  <button class="button" @click=${() => this.discardDraft()}>Discard</button>
                </div>
              </div>
            `
            : html``
        }

        <div class="editor-container">
          <div id="editor" class="monaco-host"></div>
        </div>

        <div class="footer">
          <div class="status">${this.statusMessage}</div>
          ${
            this.readOnly
              ? html``
              : html`<div class="button-row">
                <button class="button" ?disabled=${this.saving} @click=${() => this.save()}>
                  Save
                </button>
                <button
                  class="button primary"
                  ?disabled=${this.continuing}
                  @click=${() => this.continueRun()}
                >
                  ${this.continuing ? "Working..." : "Save & Continue"}
                </button>
              </div>`
          }
        </div>
      </div>
      ${this.renderUndoRedoButtons()}
      ${this.renderDiffModal()}
    `;
  }

  private renderUndoRedoButtons() {
    if (this.readOnly) return null;
    const canUndo = this.undoStack.length > 0;
    const canRedo = this.redoStack.length > 0;
    return html`
      <div class="undo-redo-float">
        <button
          class="undo-redo-btn"
          ?disabled=${!canUndo}
          @click=${() => this.undo()}
          title="Undo (Cmd+Z)"
        >↶</button>
        <button
          class="undo-redo-btn"
          ?disabled=${!canRedo}
          @click=${() => this.redo()}
          title="Redo (Cmd+Shift+Z)"
        >↷</button>
      </div>
    `;
  }
}

customElements.define("pl4n-editor", Pl4nEditor);
