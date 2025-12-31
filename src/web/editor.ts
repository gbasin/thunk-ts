import { LitElement, html } from "lit";
import { diffLines, type Change } from "diff";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
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

class ThunkEditor extends LitElement {
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

  session = "";
  token = "";
  turn = 1;
  phase = "user_review";
  readOnly = false;

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
    });

    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void this.save();
    });
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      void this.continueRun();
    });

    this.editor.onDidChangeModelContent(() => {
      if (this.suppressChange) {
        return;
      }
      this.dirty = true;
      this.statusMessage = "Unsaved changes";
      this.scheduleDraftSave();
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
    const diff = diffLines(this.lastLoadedContent, this.draftContent);
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
      ${this.renderDiffModal()}
    `;
  }
}

customElements.define("thunk-editor", ThunkEditor);
