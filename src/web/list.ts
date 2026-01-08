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

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "No activity";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString();
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
    const latest = formatRelativeTime(sessions[0]?.updated_at);

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
      <div class="tui-cards">
        ${
          sessions.length === 0
            ? html`<div class="tui-cards-empty">No sessions found.</div>`
            : sessions.map((session) => {
                const approved = session.phase === "approved";
                const canEdit = !!session.edit_path;
                const updated = formatRelativeTime(session.updated_at);
                const phaseLabel = formatPhase(session.phase);

                const cardContent = html`
                  <div class="tui-card-header">
                    <span class="tui-card-title">${session.session_id}</span>
                    <span class="tui-card-badge ${approved ? "approved" : ""}">${phaseLabel}</span>
                  </div>
                  <div class="tui-card-task">${truncateTask(session.task)}</div>
                  <div class="tui-card-meta">
                    <span>Turn ${session.turn}</span>
                    <span class="tui-card-dot"></span>
                    <span>${updated}</span>
                  </div>
                `;

                return canEdit
                  ? html`<a class="tui-card" href=${session.edit_path}>${cardContent}</a>`
                  : html`<div class="tui-card disabled">${cardContent}</div>`;
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
