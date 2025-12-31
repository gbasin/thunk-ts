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

type ListWindow = Window & { __PL4N_LIST__?: ListPayload };

function formatPhase(phase: string): string {
  return phase.replace(/_/g, " ");
}

function truncateTask(task: string): string {
  // Extract first meaningful paragraph (skip headings)
  const lines = task.split("\n");
  const paragraphs: string[] = [];
  let currentPara = "";

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip headings and empty lines when building paragraphs
    if (trimmed.startsWith("#") || trimmed === "") {
      if (currentPara) {
        paragraphs.push(currentPara.trim());
        currentPara = "";
      }
      continue;
    }
    currentPara += (currentPara ? " " : "") + trimmed;
  }
  if (currentPara) {
    paragraphs.push(currentPara.trim());
  }

  // Return first paragraph, truncated if needed
  const first = paragraphs[0] || task.slice(0, 200);
  return first.length > 200 ? first.slice(0, 200) + "…" : first;
}

class Pl4nList extends LitElement {
  createRenderRoot() {
    return this;
  }

  private get sessions(): SessionItem[] {
    const payload = (window as ListWindow).__PL4N_LIST__;
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
                <p>${truncateTask(session.task)}</p>
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

customElements.define("pl4n-list", Pl4nList);
