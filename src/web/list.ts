import { LitElement, html } from "lit";

type SessionItem = {
  session_id: string;
  task: string;
  turn: number;
  phase: string;
  updated_at: string;
  edit_path: string | null;
};

type ListPayload = {
  sessions: SessionItem[];
};

type ListWindow = Window & { __THUNK_LIST__?: ListPayload };

function formatPhase(phase: string): string {
  return phase.replace(/_/g, " ");
}

class ThunkList extends LitElement {
  createRenderRoot() {
    return this;
  }

  private get sessions(): SessionItem[] {
    const payload = (window as ListWindow).__THUNK_LIST__;
    return payload?.sessions ?? [];
  }

  render() {
    const sessions = this.sessions;
    return html`
      <div class="card">
        <div class="header">
          <div class="header-title">
            <h1>Sessions</h1>
            <div class="header-meta">${sessions.length} total</div>
          </div>
        </div>
        <div class="list-grid">
          ${sessions.map((session) => {
            const approved = session.phase === "approved";
            return html`
              <div class="list-item">
                <div class="header">
                  <h3>${session.session_id}</h3>
                  ${approved ? html`<span class="badge approved">Approved</span>` : html``}
                </div>
                <p>${session.task}</p>
                <div class="list-meta">
                  <span>Turn ${session.turn}</span>
                  <span>${formatPhase(session.phase)}</span>
                  <span>${new Date(session.updated_at).toLocaleString()}</span>
                  ${
                    session.edit_path
                      ? html`<a class="list-link" href=${session.edit_path}>Open editor</a>`
                      : html``
                  }
                </div>
              </div>
            `;
          })}
        </div>
      </div>
    `;
  }
}

customElements.define("thunk-list", ThunkList);
