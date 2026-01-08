import { LitElement, html } from "lit";
import {
  type ActivityEvent,
  formatActivity,
  getTokenFromLocation,
  openActivityStream,
} from "./notifications.js";

type SessionItem = {
  session_id: string;
  task: string;
  turn: number;
  phase: string;
  updated_at: string;
  edit_path: string | null;
};

type ListPayload = {
  project: {
    project_id: string;
    name: string;
    path: string;
  };
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
  private activity: ActivityEvent[] = [];
  private token: string | null = null;
  private eventSource: EventSource | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.token = getTokenFromLocation();
    this.eventSource = openActivityStream(
      this.token,
      (events) => {
        this.activity = events;
        this.requestUpdate();
      },
      (event) => {
        this.activity = [event, ...this.activity].slice(0, 5);
        this.requestUpdate();
      },
    );
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.eventSource?.close();
    this.eventSource = null;
  }

  private get project() {
    const payload = (window as ListWindow).__PL4N_LIST__;
    return payload?.project;
  }

  private get sessions(): SessionItem[] {
    const payload = (window as ListWindow).__PL4N_LIST__;
    return payload?.sessions ?? [];
  }

  firstUpdated() {
    this.updateTuiChrome();
  }

  updated() {
    this.updateTuiChrome();
  }

  private updateTuiChrome() {
    const project = this.project;
    const sessions = this.sessions;
    const projectName = project?.name ?? "--";
    const latest = sessions[0]?.updated_at
      ? new Date(sessions[0].updated_at).toLocaleString()
      : "--";

    const sessionNameEl = document.getElementById("tui-session-name");
    if (sessionNameEl) {
      sessionNameEl.textContent = projectName;
    }
    const projectEl = document.getElementById("info-project");
    if (projectEl) {
      projectEl.textContent = projectName;
    }
    const countEl = document.getElementById("info-count");
    if (countEl) {
      countEl.textContent = String(sessions.length);
    }
    const updatedEl = document.getElementById("info-updated");
    if (updatedEl) {
      updatedEl.textContent = latest;
    }

    const projectsLink = document.getElementById("nav-projects") as HTMLAnchorElement | null;
    if (projectsLink) {
      projectsLink.href = this.token ? `/projects?t=${this.token}` : "/projects";
    }
    const sessionsLink = document.getElementById("nav-sessions") as HTMLAnchorElement | null;
    if (sessionsLink && project) {
      sessionsLink.href = this.token
        ? `/projects/${project.project_id}/sessions?t=${this.token}`
        : `/projects/${project.project_id}/sessions`;
    }
  }

  render() {
    const sessions = this.sessions;
    return html`
      ${this.renderActivityBar()}
      <div class="tui-list">
        <div class="tui-list-header">
          <div class="tui-list-cell">Session</div>
          <div class="tui-list-cell">Phase</div>
          <div class="tui-list-cell">Updated</div>
          <div class="tui-list-cell">Action</div>
        </div>
        ${
          sessions.length === 0
            ? html`<div class="tui-list-empty">No sessions found.</div>`
            : sessions.map((session) => {
                const approved = session.phase === "approved";
                return html`
                  <div class="tui-list-row">
                    <div class="tui-list-cell wrap">
                      <strong>${session.session_id}</strong>
                      <div class="tui-list-sub">${truncateTask(session.task)}</div>
                    </div>
                    <div class="tui-list-cell">${formatPhase(session.phase)}</div>
                    <div class="tui-list-cell">
                      ${new Date(session.updated_at).toLocaleString()}
                    </div>
                    <div class="tui-list-cell">
                      ${
                        session.edit_path
                          ? html`<a class="list-link" href=${session.edit_path}>Open</a>`
                          : approved
                            ? html`<span class="tui-list-sub">Locked</span>`
                            : html`<span class="tui-list-sub">Pending</span>`
                      }
                    </div>
                  </div>
                `;
              })
        }
      </div>
    `;
  }

  private renderActivityBar() {
    if (this.activity.length === 0) {
      return null;
    }
    return html`
      <div class="tui-activity">
        <div class="tui-activity-title">Live activity</div>
        ${this.activity.slice(0, 4).map(
          (event) => html`
            <a
              class="tui-activity-item"
              href=${
                this.token ? `/projects/${event.project_id}/sessions?t=${this.token}` : "/projects"
              }
            >
              <span class="tui-activity-dot ${event.action}"></span>
              <span>${formatActivity(event)}</span>
            </a>
          `,
        )}
      </div>
    `;
  }
}

customElements.define("pl4n-list", Pl4nList);
