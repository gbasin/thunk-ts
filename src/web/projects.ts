import { LitElement, html } from "lit";
import {
  type ActivityEvent,
  formatActivity,
  getTokenFromLocation,
  openActivityStream,
} from "./notifications.js";

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

type ProjectItem = {
  project_id: string;
  name: string;
  path: string;
  session_count?: number;
  updated_at?: string | null;
};

type ProjectsPayload = {
  projects: ProjectItem[];
};

type ProjectsWindow = Window & { __PL4N_PROJECTS__?: ProjectsPayload };

class Pl4nProjects extends LitElement {
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

  private get projects(): ProjectItem[] {
    const payload = (window as ProjectsWindow).__PL4N_PROJECTS__;
    return payload?.projects ?? [];
  }

  firstUpdated() {
    this.updateTuiChrome();
  }

  updated() {
    this.updateTuiChrome();
  }

  private updateTuiChrome() {
    const projects = this.projects;
    const latest = projects
      .map((project) => project.updated_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .slice(-1)[0];
    const latestLabel = formatRelativeTime(latest);

    const sessionNameEl = document.getElementById("tui-session-name");
    if (sessionNameEl) {
      sessionNameEl.textContent = "projects";
    }
    const countEl = document.getElementById("info-count");
    if (countEl) {
      countEl.textContent = String(projects.length);
    }
    const updatedEl = document.getElementById("info-updated");
    if (updatedEl) {
      updatedEl.textContent = latestLabel;
    }

    const projectsLink = document.getElementById("nav-projects") as HTMLAnchorElement | null;
    if (projectsLink) {
      projectsLink.href = this.token ? `/projects?t=${this.token}` : "/projects";
    }
  }

  render() {
    const projects = this.projects;
    return html`
      ${this.renderActivityBar()}
      <div class="tui-cards">
        ${
          projects.length === 0
            ? html`<div class="tui-cards-empty">No projects found.</div>`
            : projects.map((project) => {
                const sessionCount = project.session_count ?? 0;
                const sessionLabel = sessionCount === 1 ? "session" : "sessions";
                const updated = formatRelativeTime(project.updated_at);
                const link = this.token
                  ? `/projects/${project.project_id}/sessions?t=${this.token}`
                  : `/projects/${project.project_id}/sessions`;
                return html`
                  <a class="tui-card" href=${link}>
                    <div class="tui-card-header">
                      <span class="tui-card-title">${project.name}</span>
                      <span class="tui-card-badge">${sessionCount}</span>
                    </div>
                    <div class="tui-card-meta">
                      <span>${sessionCount} ${sessionLabel}</span>
                      <span class="tui-card-dot"></span>
                      <span>${updated}</span>
                    </div>
                  </a>
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

customElements.define("pl4n-projects", Pl4nProjects);
