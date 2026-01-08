import { LitElement, html } from "lit";
import {
  type ActivityEvent,
  formatActivity,
  getTokenFromLocation,
  openActivityStream,
} from "./notifications.js";

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
    const latestLabel = latest ? new Date(latest).toLocaleString() : "--";

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
      <div class="tui-list">
        <div class="tui-list-header">
          <div class="tui-list-cell">Project</div>
          <div class="tui-list-cell">Sessions</div>
          <div class="tui-list-cell">Updated</div>
          <div class="tui-list-cell">Path</div>
        </div>
        ${
          projects.length === 0
            ? html`<div class="tui-list-empty">No projects found.</div>`
            : projects.map((project) => {
                const sessions =
                  project.session_count === undefined ? "—" : String(project.session_count);
                const updated = project.updated_at
                  ? new Date(project.updated_at).toLocaleString()
                  : "No sessions yet";
                const link = this.token
                  ? `/projects/${project.project_id}/sessions?t=${this.token}`
                  : `/projects/${project.project_id}/sessions`;
                return html`
                  <a class="tui-list-row" href=${link}>
                    <div class="tui-list-cell">
                      <strong>${project.name}</strong>
                    </div>
                    <div class="tui-list-cell">${sessions}</div>
                    <div class="tui-list-cell">${updated}</div>
                    <div class="tui-list-cell wrap">${project.path}</div>
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
