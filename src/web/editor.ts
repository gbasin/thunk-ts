import { LitElement, html } from "lit";
import * as Diff from "diff";
import { PlanEditor } from "./plan-editor.js";

type Change = Diff.Change;

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

  private editor: PlanEditor | null = null;
  private mtime = 0;
  private dirty = false;
  private saving = false;
  private continuing = false;
  private statusMessage = "Loading plan...";
  private autosaveTimer: number | null = null;
  private pollTimer: number | null = null;
  private autosaveContent: string | null = null;
  private hasAutosave = false;
  private showAutosaveDiff = false;
  private lastLoadedContent = "";
  private snapshotContent: string | null = null;
  private showContinueConfirm = false;
  private continueConfirmExpanded = false;

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
    this.editor?.destroy();
  }

  firstUpdated() {
    const container = this.querySelector("#editor") as HTMLElement | null;
    if (!container) {
      return;
    }

    this.editor = new PlanEditor(container, {
      value: "",
      baseline: "",
      readOnly: this.readOnly,
      onChange: () => {
        this.dirty = true;
        this.statusMessage = "Unsaved changes";
        this.scheduleAutosave();
        this.requestUpdate();
      },
    });

    void this.loadContent();
  }

  updated(changed: Map<string, unknown>) {
    if (changed.has("readOnly") && this.editor) {
      this.editor.setReadOnly(this.readOnly);
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
    if (event.key === "Escape" && this.showAutosaveDiff) {
      this.showAutosaveDiff = false;
      this.requestUpdate();
      return;
    }

    // Cmd/Ctrl+S to save
    if ((event.metaKey || event.ctrlKey) && event.key === "s") {
      event.preventDefault();
      void this.save();
      return;
    }

    // Cmd/Ctrl+Enter to continue
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void this.continueRun();
      return;
    }

    // Note: Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z are handled by ProseMirror internally
  };

  private scheduleAutosave() {
    if (this.readOnly) {
      return;
    }
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
    }
    this.autosaveTimer = window.setTimeout(() => {
      void this.saveAutosave();
    }, 2000);
  }

  private async saveAutosave() {
    if (!this.editor || this.readOnly) {
      return;
    }
    const content = this.editor.getValue();
    try {
      const response = await fetch(`/api/autosave/${this.session}?t=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
      });
      if (!response.ok) {
        throw new Error("Autosave failed");
      }
      this.hasAutosave = true;
      this.autosaveContent = content;
      this.statusMessage = "Autosaved";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Autosave failed";
      this.requestUpdate();
    }
  }

  private async discardAutosave() {
    try {
      const response = await fetch(`/api/autosave/${this.session}?t=${this.token}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        throw new Error("Autosave discard failed");
      }
      this.hasAutosave = false;
      this.autosaveContent = null;
      this.statusMessage = "Autosave discarded";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Autosave discard failed";
      this.requestUpdate();
    }
  }

  private async restoreAutosave() {
    if (!this.editor || !this.autosaveContent) {
      return;
    }
    this.editor.setValue(this.autosaveContent);
    this.dirty = true;
    await this.discardAutosave();
    this.statusMessage = "Autosave restored";
    this.requestUpdate();
  }

  private async loadContent() {
    try {
      const response = await fetch(`/api/content/${this.session}?t=${this.token}`);
      if (!response.ok) {
        // Use test content for development/testing when API unavailable
        if (this.session === "test-session") {
          this.loadTestContent();
          return;
        }
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
        hasAutosave: boolean;
        autosave: string | null;
        snapshot: string | null;
      };
      this.mtime = data.mtime;
      this.turn = data.turn;
      this.phase = data.phase;
      this.readOnly = data.readOnly;
      this.hasAutosave = data.hasAutosave;
      this.autosaveContent = data.autosave;
      this.snapshotContent = data.snapshot;
      this.lastLoadedContent = data.content;

      if (this.editor) {
        this.editor.setBaseline(data.content);
        this.editor.setValue(data.content);
        this.editor.setReadOnly(data.readOnly);
      }

      this.dirty = false;
      this.statusMessage = data.readOnly ? "Read-only" : "Ready";
      this.requestUpdate();
    } catch {
      // Use test content for development/testing when API unavailable
      if (this.session === "test-session") {
        this.loadTestContent();
        return;
      }
      this.statusMessage = "Load failed";
      this.requestUpdate();
    }
  }

  private loadTestContent() {
    const testContent = `# Implementation Plan

## Overview
This is a test document to verify the PlanEditor component works correctly.

## Architecture

\`\`\`
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Client    │───▶│   Server    │───▶│  Database   │
│  (React)    │    │  (Node.js)  │    │ (Postgres)  │
└─────────────┘    └─────────────┘    └─────────────┘
       │                  │
       │                  ▼
       │           ┌─────────────┐
       └──────────▶│   Cache     │
                   │  (Redis)    │
                   └─────────────┘
\`\`\`

## Tasks
1. First task - implement the feature
2. Second task - write tests
3. Third task - update documentation

## Code Example

\`\`\`typescript
function hello() {
  console.log("Hello, world!");
}
\`\`\`

## Notes
- The editor should support iOS autocomplete
- ASCII diagrams scroll horizontally on mobile
- Character-level diff highlighting shows additions
- Click "Show Diff" to see all changes including deletions

Try editing this text to see the diff highlighting in action!`;

    this.lastLoadedContent = testContent;
    this.snapshotContent = testContent;

    if (this.editor) {
      this.editor.setBaseline(testContent);
      this.editor.setValue(testContent);
      this.editor.setReadOnly(this.readOnly);
    }

    this.dirty = false;
    this.statusMessage = "Test mode - Ready";
    this.requestUpdate();
  }

  private async save() {
    if (this.readOnly || !this.editor || this.saving) {
      return;
    }
    this.saving = true;
    this.statusMessage = "Saving...";
    this.requestUpdate();
    try {
      const content = this.editor.getValue();
      const response = await fetch(`/api/save/${this.session}?t=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mtime: this.mtime }),
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
        this.hasAutosave = false;
        this.autosaveContent = null;
        // Clear any pending autosave timer to prevent it from firing after save
        if (this.autosaveTimer !== null) {
          window.clearTimeout(this.autosaveTimer);
          this.autosaveTimer = null;
        }
        this.lastLoadedContent = content;
        this.editor.setBaseline(content);
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

    const currentContent = this.editor.getValue();
    // If no changes, approve instead of running another turn
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

    // Show confirmation panel instead of immediately continuing
    this.showContinueConfirm = true;
    this.continueConfirmExpanded = false;
    this.requestUpdate();
  }

  private cancelContinue() {
    this.showContinueConfirm = false;
    this.continueConfirmExpanded = false;
    this.requestUpdate();
  }

  private async confirmContinue() {
    if (!this.editor) {
      return;
    }

    this.showContinueConfirm = false;
    this.continueConfirmExpanded = false;
    this.continuing = true;
    this.statusMessage = "Saving & running agents...";
    this.requestUpdate();

    try {
      const content = this.editor.getValue();
      const response = await fetch(`/api/continue/${this.session}?t=${this.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, mtime: this.mtime }),
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

  private undo() {
    this.editor?.undo();
  }

  private redo() {
    this.editor?.redo();
  }

  private showDiff() {
    if (!this.editor) {
      return;
    }
    const baseline = this.snapshotContent ?? this.lastLoadedContent;
    this.editor.showDiffAgainst(baseline);
  }

  private renderAutosaveDiffModal() {
    if (!this.showAutosaveDiff || !this.autosaveContent) {
      return null;
    }
    const diff = Diff.diffLines(this.lastLoadedContent, this.autosaveContent);
    return html`
      <div class="modal-backdrop" @click=${() => (this.showAutosaveDiff = false)}>
        <div class="modal" @click=${(event: Event) => event.stopPropagation()}>
          <div class="header">
            <h2>Autosave Diff</h2>
            <button class="button secondary" @click=${() => (this.showAutosaveDiff = false)}>
              Close
            </button>
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

  private renderContinueConfirmPanel() {
    if (!this.showContinueConfirm || !this.editor) {
      return null;
    }

    const currentContent = this.editor.getValue();
    const diff = Diff.diffLines(this.lastLoadedContent, currentContent);

    let additions = 0;
    let deletions = 0;
    for (const part of diff) {
      const lines = part.value.split("\n").length - 1 || 1;
      if (part.added) {
        additions += lines;
      } else if (part.removed) {
        deletions += lines;
      }
    }

    const summary = `${additions} addition${additions !== 1 ? "s" : ""}, ${deletions} deletion${deletions !== 1 ? "s" : ""}`;

    // Collapse unchanged sections - show only 2 context lines around changes
    const contextLines = 2;
    const collapsedDiff: Array<{
      type: "add" | "remove" | "context" | "collapsed";
      value: string;
      count?: number;
    }> = [];

    for (let i = 0; i < diff.length; i++) {
      const part = diff[i];
      if (part.added || part.removed) {
        collapsedDiff.push({
          type: part.added ? "add" : "remove",
          value: part.value,
        });
      } else {
        // Unchanged section - collapse if large
        const lines = part.value.split("\n");
        // Remove trailing empty from split
        if (lines[lines.length - 1] === "") lines.pop();

        if (lines.length <= contextLines * 2 + 1) {
          // Small enough to show fully
          collapsedDiff.push({ type: "context", value: part.value });
        } else {
          // Show first N lines, collapse middle, show last N lines
          const isFirst = i === 0;
          const isLast = i === diff.length - 1;

          if (!isFirst) {
            const leadingLines = lines.slice(0, contextLines).join("\n") + "\n";
            collapsedDiff.push({ type: "context", value: leadingLines });
          }

          const collapsedCount =
            lines.length - (isFirst ? 0 : contextLines) - (isLast ? 0 : contextLines);
          if (collapsedCount > 0) {
            collapsedDiff.push({ type: "collapsed", value: "", count: collapsedCount });
          }

          if (!isLast) {
            const trailingLines = lines.slice(-contextLines).join("\n") + "\n";
            collapsedDiff.push({ type: "context", value: trailingLines });
          }
        }
      }
    }

    return html`
      <div class="continue-confirm-panel">
        <div
          class="continue-confirm-header"
          @click=${() => {
            this.continueConfirmExpanded = !this.continueConfirmExpanded;
            this.requestUpdate();
          }}
        >
          <span class="continue-confirm-arrow">${this.continueConfirmExpanded ? "▼" : "▶"}</span>
          <span class="continue-confirm-summary">Review changes (${summary})</span>
        </div>
        ${
          this.continueConfirmExpanded
            ? html`
              <div class="continue-confirm-diff">
                ${collapsedDiff.map((part) => {
                  if (part.type === "collapsed") {
                    return html`<div class="diff-line diff-collapsed">··· ${part.count} unchanged lines ···</div>`;
                  }
                  const cls =
                    part.type === "add"
                      ? "diff-line diff-add"
                      : part.type === "remove"
                        ? "diff-line diff-remove"
                        : "diff-line";
                  return html`<div class=${cls}>${part.value}</div>`;
                })}
              </div>
            `
            : null
        }
        <div class="continue-confirm-message">
          This will save your edits and start a new agent turn.
        </div>
        <div class="continue-confirm-actions">
          <button class="button secondary" @click=${() => this.cancelContinue()}>Cancel</button>
          <button class="button primary" @click=${() => this.confirmContinue()}>Run Agents</button>
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
          <div class="header-actions">
            ${this.renderUndoRedoButtons()}
            ${approved ? html`<span class="badge approved">Approved</span>` : html``}
          </div>
        </div>

        ${
          this.hasAutosave
            ? html`
              <div class="editor-banner">
                <span>Autosave recovery available.</span>
                <div class="banner-actions">
                  <button class="button secondary" @click=${() => (this.showAutosaveDiff = true)}>
                    View diff
                  </button>
                  <button class="button" @click=${() => this.restoreAutosave()}>Restore</button>
                  <button class="button" @click=${() => this.discardAutosave()}>Discard</button>
                </div>
              </div>
            `
            : html``
        }

        <div class="editor-container">
          <div id="editor" class="plan-editor-host"></div>
        </div>

        <div class="footer">
          ${
            this.showContinueConfirm
              ? this.renderContinueConfirmPanel()
              : html`
                <div class="status">${this.statusMessage}</div>
                ${
                  this.readOnly
                    ? html``
                    : html`<div class="button-row">
                      <button class="button secondary" @click=${() => this.showDiff()}>
                        Show Diff
                      </button>
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
              `
          }
        </div>
      </div>
      ${this.renderAutosaveDiffModal()}
    `;
  }

  private renderUndoRedoButtons() {
    if (this.readOnly) return null;
    return html`
      <div class="undo-redo-float">
        <button class="undo-redo-btn" @click=${() => this.undo()} title="Undo (Cmd+Z)">↶</button>
        <button class="undo-redo-btn" @click=${() => this.redo()} title="Redo (Cmd+Shift+Z)">
          ↷
        </button>
      </div>
    `;
  }
}

customElements.define("pl4n-editor", Pl4nEditor);
