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
  archived: boolean;
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

type ListFilter = "active" | "archived" | "all";

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

function parseFilterFromLocation(): ListFilter {
  const url = new URL(window.location.href);
  const value = url.searchParams.get("archived");
  if (!value) {
    return "active";
  }
  const normalized = value.toLowerCase();
  if (normalized === "all") {
    return "all";
  }
  if (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "only" ||
    normalized === "archived"
  ) {
    return "archived";
  }
  return "active";
}

function filterParam(filter: ListFilter): string | null {
  if (filter === "archived") {
    return "1";
  }
  if (filter === "all") {
    return "all";
  }
  return null;
}

class Pl4nList extends LitElement {
  private activity: ActivityEvent[] = [];
  private token: string | null = null;
  private eventSource: EventSource | null = null;
  private sessionsData: SessionItem[] = [];
  private projectData: ListPayload["project"] | null = null;
  private filter: ListFilter = "active";
  private loading = false;
  private filterBound = false;
  private archiveBusy = new Set<string>();
  private activeSessions: SessionItem[] = [];

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.token = getTokenFromLocation();
    const payload = (window as ListWindow).__PL4N_LIST__;
    this.sessionsData = payload?.sessions ?? [];
    this.projectData = payload?.project ?? null;
    this.filter = parseFilterFromLocation();
    this.activeSessions = this.sessionsData.filter((session) => !session.archived);
    if (this.filter === "archived") {
      void this.refreshActiveStats();
    }
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
    return this.projectData ?? undefined;
  }

  private get sessions(): SessionItem[] {
    return this.sessionsData;
  }

  private get visibleSessions(): SessionItem[] {
    if (this.filter === "all") {
      return this.sessions;
    }
    if (this.filter === "archived") {
      return this.sessions.filter((session) => session.archived);
    }
    return this.sessions.filter((session) => !session.archived);
  }

  firstUpdated() {
    this.updateTuiChrome();
    this.bindFilterButtons();
  }

  updated() {
    this.updateTuiChrome();
  }

  private updateTuiChrome() {
    const project = this.project;
    const sessions = this.activeSessions;
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

    const buttons = document.querySelectorAll<HTMLButtonElement>(".tui-filter-btn");
    buttons.forEach((button) => {
      const filter = button.dataset.filter as ListFilter | undefined;
      button.classList.toggle("active", filter === this.filter);
    });

    const projectsLink = document.getElementById("nav-projects") as HTMLAnchorElement | null;
    if (projectsLink) {
      projectsLink.href = this.token ? `/projects?t=${this.token}` : "/projects";
    }
    const sessionsLink = document.getElementById("nav-sessions") as HTMLAnchorElement | null;
    if (sessionsLink && project) {
      const filterValue = filterParam(this.filter);
      const url = new URL(
        this.token
          ? `/projects/${project.project_id}/sessions?t=${this.token}`
          : `/projects/${project.project_id}/sessions`,
        window.location.origin,
      );
      if (filterValue) {
        url.searchParams.set("archived", filterValue);
      }
      sessionsLink.href = url.pathname + url.search;
    }
  }

  render() {
    const sessions = this.visibleSessions;
    return html`
      ${this.renderActivityBar()}
      <div class="tui-cards">
        ${
          this.loading
            ? html`<div class="tui-cards-empty">Loading sessions…</div>`
            : sessions.length === 0
              ? html`<div class="tui-cards-empty">No sessions found.</div>`
              : sessions.map((session) => {
                  const approved = session.phase === "approved";
                  const canEdit = !!session.edit_path;
                  const updated = formatRelativeTime(session.updated_at);
                  const phaseLabel = formatPhase(session.phase);

                  const cardContent = html`
                  <div class="tui-card-header">
                    <span class="tui-card-title">${session.session_id}</span>
                    <span class="tui-card-actions">
                      ${this.renderArchiveButton(session)}
                      ${
                        session.archived
                          ? html`<span class="tui-card-badge archived">archived</span>`
                          : null
                      }
                      <span class="tui-card-badge ${approved ? "approved" : ""}">
                        ${phaseLabel}
                      </span>
                    </span>
                  </div>
                  <div class="tui-card-task">${truncateTask(session.task)}</div>
                  <div class="tui-card-meta">
                    <span>Turn ${session.turn}</span>
                    <span class="tui-card-dot"></span>
                    <span>${updated}</span>
                  </div>
                `;

                  return canEdit
                    ? html`<a class="tui-card ${session.archived ? "archived" : ""}" href=${session.edit_path}>
                      ${cardContent}
                    </a>`
                    : html`<div class="tui-card ${session.archived ? "archived" : ""} disabled">
                      ${cardContent}
                    </div>`;
                })
        }
      </div>
    `;
  }

  private bindFilterButtons() {
    if (this.filterBound) {
      return;
    }
    const buttons = document.querySelectorAll<HTMLButtonElement>(".tui-filter-btn");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const filter = button.dataset.filter as ListFilter | undefined;
        if (!filter) {
          return;
        }
        void this.setFilter(filter);
      });
    });
    this.filterBound = true;
  }

  private async setFilter(filter: ListFilter) {
    if (this.filter === filter) {
      return;
    }
    this.filter = filter;
    this.updateUrlFilter();
    await this.fetchSessions();
  }

  private updateUrlFilter() {
    const url = new URL(window.location.href);
    const value = filterParam(this.filter);
    if (value) {
      url.searchParams.set("archived", value);
    } else {
      url.searchParams.delete("archived");
    }
    window.history.replaceState(null, "", url.toString());
    this.updateTuiChrome();
  }

  private async fetchSessions() {
    const project = this.project;
    if (!project) {
      return;
    }
    this.loading = true;
    this.requestUpdate();
    try {
      const url = new URL(`/api/projects/${project.project_id}/sessions`, window.location.origin);
      if (this.token) {
        url.searchParams.set("t", this.token);
      }
      const value = filterParam(this.filter);
      if (value) {
        url.searchParams.set("archived", value);
      }
      const response = await fetch(url.toString());
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { sessions: SessionItem[] };
      this.sessionsData = payload.sessions ?? [];
      if (this.filter === "active") {
        this.activeSessions = this.sessionsData;
      } else if (this.filter === "all") {
        this.activeSessions = this.sessionsData.filter((session) => !session.archived);
      } else {
        await this.refreshActiveStats();
      }
    } finally {
      this.loading = false;
      this.requestUpdate();
    }
  }

  private async refreshActiveStats() {
    const project = this.project;
    if (!project) {
      return;
    }
    try {
      const url = new URL(`/api/projects/${project.project_id}/sessions`, window.location.origin);
      if (this.token) {
        url.searchParams.set("t", this.token);
      }
      const response = await fetch(url.toString());
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { sessions: SessionItem[] };
      this.activeSessions = payload.sessions ?? [];
    } catch {
      // ignore stats refresh errors
    }
  }

  private async toggleArchive(session: SessionItem, event: Event) {
    event.preventDefault();
    event.stopPropagation();
    if (this.archiveBusy.has(session.session_id)) {
      return;
    }
    const project = this.project;
    if (!project) {
      return;
    }
    this.archiveBusy.add(session.session_id);
    this.requestUpdate();
    try {
      const url = new URL(
        `/api/projects/${project.project_id}/archive/${session.session_id}`,
        window.location.origin,
      );
      if (this.token) {
        url.searchParams.set("t", this.token);
      }
      const response = await fetch(url.toString(), { method: "POST" });
      if (!response.ok) {
        return;
      }
      const payload = (await response.json()) as { archived?: boolean };
      const archived = Boolean(payload.archived);
      this.sessionsData = this.sessionsData.map((item) =>
        item.session_id === session.session_id ? { ...item, archived } : item,
      );
      await this.fetchSessions();
    } finally {
      this.archiveBusy.delete(session.session_id);
      this.requestUpdate();
    }
  }

  private renderArchiveButton(session: SessionItem) {
    const label = session.archived ? "Unarchive" : "Archive";
    const busy = this.archiveBusy.has(session.session_id);
    return html`
      <button
        class="tui-card-action"
        ?disabled=${busy}
        @click=${(event: Event) => this.toggleArchive(session, event)}
      >
        ${busy ? "..." : label}
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
