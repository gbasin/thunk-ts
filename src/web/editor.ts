import { LitElement, html } from "lit";
import * as Diff from "diff";
import { PlanEditor } from "./plan-editor.js";
import { buildLineDiff, type LineChange } from "./diff-render.js";
import { type ActivityEvent, formatActionLabel, openActivityStream } from "./notifications.js";
import { parseMarkdown, serializeMarkdown } from "./prosemirror-schema.js";

function formatPhase(phase: string): string {
  return phase.replace(/_/g, " ");
}

function normalizeMarkdown(content: string): string {
  return serializeMarkdown(parseMarkdown(content));
}

type AgentStatusMap = Record<string, string>;
type DiffDisplayLine = LineChange | { type: "collapsed"; count: number };

function getAgentStatusInfo(status: string): { icon: string; label: string; className: string } {
  switch (status) {
    case "working":
      return {
        icon: "●",
        label: "Working - Agent is currently processing",
        className: "agent-working",
      };
    case "done":
      return { icon: "✓", label: "Done - Agent completed successfully", className: "agent-done" };
    case "error":
      return { icon: "✗", label: "Error - Agent encountered a problem", className: "agent-error" };
    default:
      return { icon: "○", label: "Idle - Agent is waiting", className: "agent-idle" };
  }
}

function renderAgentStatusNodes(agents: AgentStatusMap | undefined): DocumentFragment {
  const fragment = document.createDocumentFragment();
  if (!agents || Object.keys(agents).length === 0) {
    return fragment;
  }
  let first = true;
  for (const [id, status] of Object.entries(agents)) {
    if (!first) {
      fragment.append(" ");
    }
    first = false;
    const info = getAgentStatusInfo(status);
    const span = document.createElement("span");
    span.className = `agent-status-item ${info.className}`;
    span.title = info.label;
    span.textContent = `${info.icon} ${id}`;
    fragment.append(span);
  }
  return fragment;
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
    projectId: { type: String, attribute: "data-project-id" },
    projectName: { type: String, attribute: "data-project-name" },
    globalToken: { type: String, attribute: "data-global-token" },
  };

  declare session: string;
  declare token: string;
  declare turn: number;
  declare phase: string;
  declare readOnly: boolean;
  declare projectId: string;
  declare projectName: string;
  declare globalToken: string;

  private editor: PlanEditor | null = null;
  private mtime = 0;
  private dirty = false;
  private canUndo = false;
  private canRedo = false;
  private suppressChange = false;
  private saving = false;
  private continuing = false;
  private statusMessage = "Loading plan...";
  private showSavedFlash = false;
  private autosaveTimer: number | null = null;
  private pollTimer: number | null = null;
  private autosaveContent: string | null = null;
  private showAutosaveBanner = false;
  private showAutosaveDiff = false;
  private lastLoadedContent = "";
  private snapshotContent: string | null = null;
  private showContinueConfirm = false;
  private continueConfirmExpanded = false;
  private showChangesDiff = false;
  private showCompareTurns = false;
  private compareTurnsFrom = 1;
  private compareTurnsTo = 1;
  private compareTurnsDiff: string | null = null;
  private compareTurnsLoading = false;
  private activity: ActivityEvent[] = [];
  private eventSource: EventSource | null = null;
  private agents: AgentStatusMap = {};
  private archived = false;
  private archiving = false;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("beforeunload", this.handleBeforeUnload);
    window.addEventListener("keydown", this.handleKeyDown);
    this.eventSource = openActivityStream(
      this.globalToken,
      (events) => {
        this.activity = events;
        this.requestUpdate();
      },
      (event) => {
        this.activity = [event, ...this.activity].slice(0, 4);
        this.requestUpdate();
      },
    );
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
    this.eventSource?.close();
    this.eventSource = null;
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
        if (this.suppressChange) {
          return;
        }
        const currentContent = this.editor?.getValue() ?? "";
        this.dirty = currentContent !== this.lastLoadedContent;
        this.statusMessage = this.dirty ? "Unsaved changes" : "Ready";
        this.updateUndoRedoState();
        if (this.dirty) {
          this.scheduleAutosave();
        }
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

  private updateAgentStatusDisplay() {
    const el = document.getElementById("agent-status");
    if (el) {
      el.textContent = "";
      el.append(renderAgentStatusNodes(this.agents));
    }
  }

  private handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.showAutosaveDiff) {
      this.closeAutosaveDiff();
      return;
    }

    if (event.key === "Escape" && this.showChangesDiff) {
      this.closeChangesDiff();
      return;
    }

    if (event.key === "Escape" && this.showCompareTurns) {
      this.closeCompareTurns();
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
    if (!this.editor || this.readOnly || this.saving) {
      return;
    }
    const content = this.editor.getValue();
    try {
      const response = await fetch(
        `/api/projects/${this.projectId}/autosave/${this.session}?t=${this.token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content }),
        },
      );
      if (!response.ok) {
        throw new Error("Autosave failed");
      }
      this.autosaveContent = content;
      this.statusMessage = "Autosaved";
      this.requestUpdate();
    } catch {
      this.statusMessage = "Autosave failed";
      this.requestUpdate();
    }
  }

  private async discardAutosave(options: { clearSnapshot?: boolean } = {}) {
    try {
      const response = await fetch(
        `/api/projects/${this.projectId}/autosave/${this.session}?t=${this.token}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) {
        throw new Error("Autosave discard failed");
      }
      this.showAutosaveBanner = false;
      this.autosaveContent = null;
      if (options.clearSnapshot) {
        this.snapshotContent = null;
      }
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
    await this.discardAutosave({ clearSnapshot: false });
    this.statusMessage = "Autosave restored";
    this.requestUpdate();
  }

  private async loadContent() {
    try {
      const response = await fetch(
        `/api/projects/${this.projectId}/content/${this.session}?t=${this.token}`,
      );
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
        archived: boolean;
        readOnly: boolean;
        hasAutosave: boolean;
        autosave: string | null;
        snapshot: string | null;
        agents?: AgentStatusMap;
      };
      this.mtime = data.mtime;
      this.turn = data.turn;
      this.phase = data.phase;
      this.readOnly = data.readOnly;
      this.archived = data.archived;
      const normalizedContent = normalizeMarkdown(data.content);
      const normalizedSnapshot = data.snapshot ? normalizeMarkdown(data.snapshot) : null;
      const normalizedAutosave = data.autosave ? normalizeMarkdown(data.autosave) : null;
      this.snapshotContent = normalizedSnapshot;
      this.lastLoadedContent = normalizedContent;
      // Only show autosave banner if the autosave content differs from the loaded content
      // (handles race condition where autosave fires after save, creating identical file)
      const autosaveDiffers = data.hasAutosave && normalizedAutosave !== normalizedContent;
      this.showAutosaveBanner = autosaveDiffers;
      this.autosaveContent = autosaveDiffers ? normalizedAutosave : null;
      this.agents = data.agents ?? {};
      this.updateAgentStatusDisplay();
      this.updateArchivedIndicator();

      if (this.editor) {
        this.suppressChange = true;
        // Set baseline BEFORE setValue so TableNodeView has correct baseline during render
        this.editor.setBaseline(normalizedContent);
        this.editor.setValue(normalizedContent, { addToHistory: false });
        this.editor.setReadOnly(data.readOnly);
        this.suppressChange = false;
      }

      this.dirty = false;
      this.statusMessage = data.readOnly ? "Read-only" : "Ready";
      this.requestUpdate();

      // Auto-open compare turns modal if ?diff=1 is in URL
      const url = new URL(window.location.href);
      if (url.searchParams.get("diff") === "1" && this.turn >= 2) {
        void this.openCompareTurns();
        // Remove the param from URL to avoid re-opening on refresh
        url.searchParams.delete("diff");
        window.history.replaceState({}, "", url.toString());
      }
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

    const normalizedContent = normalizeMarkdown(testContent);
    this.lastLoadedContent = normalizedContent;
    this.snapshotContent = normalizedContent;

    if (this.editor) {
      this.suppressChange = true;
      // Set baseline BEFORE setValue so TableNodeView has correct baseline during render
      this.editor.setBaseline(normalizedContent);
      this.editor.setValue(normalizedContent, { addToHistory: false });
      this.editor.setReadOnly(this.readOnly);
      this.suppressChange = false;
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
      const response = await fetch(
        `/api/projects/${this.projectId}/save/${this.session}?t=${this.token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, mtime: this.mtime }),
        },
      );
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
        this.showAutosaveBanner = false;
        this.autosaveContent = null;
        // Clear any pending autosave timer to prevent it from firing after save
        if (this.autosaveTimer !== null) {
          window.clearTimeout(this.autosaveTimer);
          this.autosaveTimer = null;
        }
        this.lastLoadedContent = content;
        this.editor.setBaseline(content);
        this.statusMessage = "Saved";
        // Trigger save flash animation
        this.showSavedFlash = true;
        window.setTimeout(() => {
          this.showSavedFlash = false;
          this.requestUpdate();
        }, 600);
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

    // If no changes from snapshot, approve instead of running another turn
    // Use snapshotContent (original AI output) as baseline, not lastLoadedContent
    // (which updates on save and would incorrectly show "no changes" after saving)
    if (!this.hasChanges()) {
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
      const response = await fetch(
        `/api/projects/${this.projectId}/continue/${this.session}?t=${this.token}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, mtime: this.mtime }),
        },
      );
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
      // Clear dirty state since content was successfully saved
      this.dirty = false;
      this.showAutosaveBanner = false;
      this.autosaveContent = null;
      if (this.autosaveTimer !== null) {
        window.clearTimeout(this.autosaveTimer);
        this.autosaveTimer = null;
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
      const response = await fetch(
        `/api/projects/${this.projectId}/approve/${this.session}?t=${this.token}`,
        {
          method: "POST",
        },
      );
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

  private async toggleArchive() {
    if (this.archiving) {
      return;
    }
    this.archiving = true;
    this.statusMessage = this.archived ? "Unarchiving..." : "Archiving...";
    this.requestUpdate();
    try {
      const url = new URL(
        `/api/projects/${this.projectId}/archive/${this.session}`,
        window.location.origin,
      );
      if (this.globalToken) {
        url.searchParams.set("t", this.globalToken);
      }
      const response = await fetch(url.toString(), { method: "POST" });
      if (!response.ok) {
        this.statusMessage = `Archive failed (${response.status})`;
        this.requestUpdate();
        return;
      }
      const payload = (await response.json()) as { archived?: boolean };
      this.archived = Boolean(payload.archived);
      this.updateArchivedIndicator();
      this.statusMessage = this.archived ? "Archived" : "Unarchived";
    } catch {
      this.statusMessage = "Archive failed";
    } finally {
      this.archiving = false;
      this.requestUpdate();
    }
  }

  private pollStatus() {
    if (this.pollTimer !== null) {
      return;
    }
    this.pollTimer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `/api/projects/${this.projectId}/status/${this.session}?t=${this.token}`,
        );
        if (!response.ok) {
          return;
        }
        const data = (await response.json()) as {
          turn: number;
          phase: string;
          agents?: AgentStatusMap;
        };
        this.agents = data.agents ?? {};
        this.updateAgentStatusDisplay();
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

  private updateUndoRedoState() {
    if (this.editor) {
      this.canUndo = this.editor.canUndo();
      this.canRedo = this.editor.canRedo();
    }
  }

  private undo() {
    this.editor?.undo();
    this.updateUndoRedoState();
    this.requestUpdate();
  }

  private redo() {
    this.editor?.redo();
    this.updateUndoRedoState();
    this.requestUpdate();
  }

  private openAutosaveDiff() {
    this.showAutosaveDiff = true;
    this.requestUpdate();
  }

  private closeAutosaveDiff() {
    this.showAutosaveDiff = false;
    this.requestUpdate();
  }

  private showDiff() {
    if (!this.editor || !this.hasChanges()) {
      return;
    }
    this.showChangesDiff = true;
    this.requestUpdate();
  }

  private closeChangesDiff() {
    this.showChangesDiff = false;
    this.requestUpdate();
  }

  private async openCompareTurns() {
    if (this.turn < 2) {
      return;
    }
    this.compareTurnsFrom = this.turn - 1;
    this.compareTurnsTo = this.turn;
    this.showCompareTurns = true;
    this.requestUpdate();
    await this.loadTurnDiff();
  }

  private closeCompareTurns() {
    this.showCompareTurns = false;
    this.compareTurnsDiff = null;
    this.requestUpdate();
  }

  private async loadTurnDiff() {
    this.compareTurnsLoading = true;
    this.requestUpdate();
    try {
      const res = await fetch(
        `/api/projects/${this.projectId}/diff/${this.session}?from=${this.compareTurnsFrom}&to=${this.compareTurnsTo}&t=${this.token}`,
      );
      const data = (await res.json()) as { diff: string };
      this.compareTurnsDiff = data.diff;
    } catch {
      this.compareTurnsDiff = null;
    }
    this.compareTurnsLoading = false;
    this.requestUpdate();
  }

  private async handleCompareTurnsFromChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    this.compareTurnsFrom = Number.parseInt(select.value, 10);
    await this.loadTurnDiff();
  }

  private async handleCompareTurnsToChange(event: Event) {
    const select = event.target as HTMLSelectElement;
    this.compareTurnsTo = Number.parseInt(select.value, 10);
    await this.loadTurnDiff();
  }

  private hasChanges(): boolean {
    if (!this.editor) {
      return false;
    }
    const baseline = this.snapshotContent ?? this.lastLoadedContent;
    return this.editor.getValue() !== baseline;
  }

  private renderAutosaveDiffModal() {
    if (!this.showAutosaveDiff || !this.autosaveContent) {
      return null;
    }
    const diff = buildLineDiff(this.lastLoadedContent, this.autosaveContent);
    return html`
      <div class="modal-backdrop" @click=${() => this.closeAutosaveDiff()}>
        <div class="modal" @click=${(event: Event) => event.stopPropagation()}>
          <div class="modal-header">
            <h2>Autosave Diff</h2>
            <button class="button secondary" @click=${() => this.closeAutosaveDiff()}>
              Close
            </button>
          </div>
          <div class="modal-content">${this.renderDiffLines(diff)}</div>
        </div>
      </div>
    `;
  }

  private renderChangesDiffModal() {
    if (!this.showChangesDiff || !this.editor) {
      return null;
    }
    const baseline = this.snapshotContent ?? this.lastLoadedContent;
    const current = this.editor.getValue();
    const diff = buildLineDiff(baseline, current);
    return html`
      <div class="modal-backdrop" @click=${() => this.closeChangesDiff()}>
        <div class="modal" @click=${(event: Event) => event.stopPropagation()}>
          <div class="modal-header">
            <h2>Changes</h2>
            <button class="button secondary" @click=${() => this.closeChangesDiff()}>
              Close
            </button>
          </div>
          <div class="modal-content">${this.renderDiffLines(diff)}</div>
        </div>
      </div>
    `;
  }

  private renderCompareTurnsModal() {
    if (!this.showCompareTurns) {
      return null;
    }
    const turnOptions = [];
    for (let i = 1; i <= this.turn; i++) {
      turnOptions.push(i);
    }
    return html`
      <div class="modal-backdrop" @click=${() => this.closeCompareTurns()}>
        <div class="modal modal-wide" @click=${(event: Event) => event.stopPropagation()}>
          <div class="modal-header">
            <h2>Compare Turns</h2>
            <div class="compare-turns-selects">
              <label>
                From:
                <select @change=${(e: Event) => this.handleCompareTurnsFromChange(e)}>
                  ${turnOptions.map(
                    (t) =>
                      html`<option value=${t} ?selected=${t === this.compareTurnsFrom}>
                        Turn ${t}
                      </option>`,
                  )}
                </select>
              </label>
              <span class="compare-turns-arrow">→</span>
              <label>
                To:
                <select @change=${(e: Event) => this.handleCompareTurnsToChange(e)}>
                  ${turnOptions.map(
                    (t) =>
                      html`<option value=${t} ?selected=${t === this.compareTurnsTo}>
                        Turn ${t}
                      </option>`,
                  )}
                </select>
              </label>
            </div>
            <button class="button secondary" @click=${() => this.closeCompareTurns()}>
              Close
            </button>
          </div>
          <div class="modal-content">
            ${
              this.compareTurnsLoading
                ? html`<div class="diff-loading">Loading...</div>`
                : this.compareTurnsDiff
                  ? this.renderUnifiedDiff(this.compareTurnsDiff)
                  : html`<div class="diff-no-changes">No diff available</div>`
            }
          </div>
        </div>
      </div>
    `;
  }

  private renderUnifiedDiff(diffText: string) {
    const lines = diffText.split("\n");
    const rendered: Array<unknown> = [];
    for (const line of lines) {
      let cls = "diff-line";
      if (line.startsWith("+") && !line.startsWith("+++")) {
        cls = "diff-line diff-add";
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        cls = "diff-line diff-remove";
      } else if (line.startsWith("@@")) {
        cls = "diff-line diff-hunk";
      } else if (line.startsWith("diff") || line.startsWith("index")) {
        cls = "diff-line diff-header";
      }
      rendered.push(html`<div class=${cls}><span class="diff-line-text">${line}</span></div>`);
    }
    return rendered;
  }

  private renderDiffLine(content: unknown, cls: string, lineNumber: number | null) {
    const displayNumber = lineNumber === null ? "" : String(lineNumber);
    return html`
      <div class=${cls}>
        <span class="diff-line-number">${displayNumber}</span>
        <span class="diff-line-text">${content}</span>
      </div>
    `;
  }

  private renderDiffLines(diff: LineChange[]) {
    const collapsed = this.collapseDiffLines(diff, 2);
    if (collapsed.length === 0) {
      return html`<div class="diff-no-changes">No changes</div>`;
    }
    const rendered: Array<unknown> = [];
    let lineNumber = 1;
    for (const part of collapsed) {
      if (part.type === "collapsed") {
        rendered.push(
          html`<div class="diff-line diff-collapsed">··· ${part.count} unchanged lines ···</div>`,
        );
        lineNumber += part.count ?? 0;
        continue;
      }
      const cls =
        part.type === "add"
          ? "diff-line diff-add"
          : part.type === "remove"
            ? "diff-line diff-remove"
            : "diff-line";
      if (part.type === "modify" && part.chars) {
        const lines: Array<Array<unknown>> = [[]];
        const pushText = (value: string, type: "add" | "remove" | "context") => {
          const parts = value.split("\n");
          for (let i = 0; i < parts.length; i++) {
            if (i > 0) {
              lines.push([]);
            }
            if (!parts[i]) {
              continue;
            }
            if (type === "add") {
              lines[lines.length - 1].push(html`<span class="diff-added">${parts[i]}</span>`);
            } else if (type === "remove") {
              lines[lines.length - 1].push(
                html`<span class="diff-inline-removed">${parts[i]}</span>`,
              );
            } else {
              lines[lines.length - 1].push(parts[i]);
            }
          }
        };

        for (const charChange of part.chars) {
          pushText(charChange.value, charChange.type);
        }

        if (lines.length > 1 && lines[lines.length - 1].length === 0) {
          lines.pop();
        }

        for (const line of lines) {
          rendered.push(this.renderDiffLine(line, cls, lineNumber));
          lineNumber += 1;
        }
        continue;
      }
      const lines = part.value.split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }
      for (const line of lines) {
        const number = part.type === "remove" ? null : lineNumber;
        rendered.push(this.renderDiffLine(line, cls, number));
        if (part.type !== "remove") {
          lineNumber += 1;
        }
      }
    }
    return rendered;
  }

  private collapseDiffLines(diff: LineChange[], contextLines: number): DiffDisplayLine[] {
    const hasChanges = diff.some((part) => part.type !== "context");
    if (!hasChanges) {
      return [];
    }

    const collapsed: DiffDisplayLine[] = [];

    for (let i = 0; i < diff.length; i++) {
      const part = diff[i];
      if (part.type !== "context") {
        collapsed.push(part);
        continue;
      }

      const lines = part.value.split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }

      if (lines.length === 0) {
        continue;
      }

      if (lines.length <= contextLines * 2 + 1) {
        collapsed.push({ type: "context", value: lines.join("\n") });
        continue;
      }

      const isFirst = i === 0;
      const isLast = i === diff.length - 1;

      if (!isFirst && contextLines > 0) {
        collapsed.push({
          type: "context",
          value: lines.slice(0, contextLines).join("\n"),
        });
      }

      const collapsedCount =
        lines.length - (isFirst ? 0 : contextLines) - (isLast ? 0 : contextLines);
      if (collapsedCount > 0) {
        collapsed.push({ type: "collapsed", count: collapsedCount });
      }

      if (!isLast && contextLines > 0) {
        collapsed.push({
          type: "context",
          value: lines.slice(-contextLines).join("\n"),
        });
      }
    }

    return collapsed;
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

    const diffLines: Array<unknown> = [];
    let lineNumber = 1;
    for (const part of collapsedDiff) {
      if (part.type === "collapsed") {
        diffLines.push(
          html`<div class="diff-line diff-collapsed">··· ${part.count} unchanged lines ···</div>`,
        );
        lineNumber += part.count ?? 0;
        continue;
      }
      const cls =
        part.type === "add"
          ? "diff-line diff-add"
          : part.type === "remove"
            ? "diff-line diff-remove"
            : "diff-line";
      const lines = part.value.split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }
      for (const line of lines) {
        const number = part.type === "remove" ? null : lineNumber;
        diffLines.push(this.renderDiffLine(line, cls, number));
        if (part.type !== "remove") {
          lineNumber += 1;
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
                ${diffLines}
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
    const sessionsLink = this.globalToken
      ? `/projects/${this.projectId}/sessions?t=${this.globalToken}`
      : `/projects/${this.projectId}/sessions`;
    const hasChanges = this.hasChanges();
    return html`
      <div class="card editor-shell">
        <div class="header">
          <div class="header-title">
            <div class="breadcrumb">
              <a href=${sessionsLink}>${this.projectName}</a>
              <span>›</span>
              <span>${this.session}</span>
            </div>
            <h1>${this.session}</h1>
            <div class="header-meta">Turn ${this.turn} - ${formatPhase(this.phase)}</div>
          </div>
          <div class="header-actions">
            ${this.renderArchiveToggle()}
            ${this.archived ? html`<span class="badge archived">Archived</span>` : html``}
            ${approved ? html`<span class="badge approved">Approved</span>` : html``}
          </div>
        </div>
        ${this.renderActivityBar()}

        ${
          this.showAutosaveBanner
            ? html`
              <div class="editor-banner">
                <span>Autosave recovery available. Discard resets the recovery snapshot.</span>
                <div class="banner-actions">
                  <button class="button secondary" @click=${() => this.openAutosaveDiff()}>
                    View diff
                  </button>
                  <button class="button" @click=${() => this.restoreAutosave()}>Restore</button>
                  <button class="button" @click=${() => this.discardAutosave({ clearSnapshot: true })}>
                    Discard
                  </button>
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
                <div class="status ${this.statusMessage.toLowerCase().includes("failed") ? "error" : ""} ${this.showSavedFlash ? "saved-flash" : ""}" role="status" aria-live="polite">${this.statusMessage}</div>
                ${
                  this.readOnly
                    ? html``
                    : html`<div class="button-row">
                      ${this.renderUndoRedoButtons()}
                      <button
                        class="button secondary"
                        ?disabled=${!hasChanges || this.continuing}
                        title=${hasChanges ? "Show changes" : "No changes to show"}
                        @click=${() => this.showDiff()}
                      >
                        Show Diff
                      </button>
                      <button
                        class="button secondary"
                        ?disabled=${this.turn < 2 || this.continuing}
                        title=${this.turn < 2 ? "Need 2+ turns to compare" : "Compare between turns"}
                        @click=${() => this.openCompareTurns()}
                      >
                        Compare Turns
                      </button>
                      <button class="button" ?disabled=${this.saving || !this.dirty || this.continuing} @click=${() => this.save()}>
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
      ${this.renderChangesDiffModal()}
      ${this.renderCompareTurnsModal()}
    `;
  }

  private renderUndoRedoButtons() {
    if (this.readOnly) return null;
    return html`
      <button
        class="button secondary"
        ?disabled=${!this.canUndo || this.continuing}
        @click=${() => this.undo()}
        title="Undo (Cmd+Z)"
        aria-label="Undo"
      >
        Undo
      </button>
      <button
        class="button secondary"
        ?disabled=${!this.canRedo || this.continuing}
        @click=${() => this.redo()}
        title="Redo (Cmd+Shift+Z)"
        aria-label="Redo"
      >
        Redo
      </button>
    `;
  }

  private updateArchivedIndicator() {
    const archivedEl = document.getElementById("info-archived");
    if (!archivedEl) {
      return;
    }
    archivedEl.textContent = this.archived ? "YES" : "NO";
    archivedEl.classList.toggle("status-archived", this.archived);
  }

  private renderArchiveToggle() {
    return html`
      <button class="button secondary" ?disabled=${this.archiving} @click=${() => this.toggleArchive()}>
        ${this.archiving ? "..." : this.archived ? "Unarchive" : "Archive"}
      </button>
    `;
  }

  private renderActivityBar() {
    if (this.activity.length === 0) {
      return null;
    }
    return html`
      <div class="tui-activity">
        <div class="tui-activity-title">Live activity</div>
        ${this.activity.slice(0, 3).map(
          (event) => html`
            <a
              class="tui-activity-item"
              href=${
                this.globalToken
                  ? `/projects/${event.project_id}/sessions?t=${this.globalToken}`
                  : "/projects"
              }
            >
              <span class="tui-activity-dot ${event.action}"></span>
              <span class="tui-activity-project">${event.project_name}</span>
              <span class="tui-activity-session">${event.session_id}</span>
              <span class="tui-activity-action ${event.action}">${formatActionLabel(event.action)}</span>
            </a>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("pl4n-editor", Pl4nEditor);
