import { promises as fs, type Dirent } from "fs";
import path from "path";
import { EventEmitter } from "events";
import crypto from "crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { load as loadYaml } from "js-yaml";

import { Phase } from "../models";
import { isRecord } from "../utils/types";
import { SessionManager } from "../session";
import { createProjectId } from "./project-id";

export type ProjectInfo = {
  id: string;
  name: string;
  root: string;
  pl4nDir: string;
  manager: SessionManager;
};

export type ActivityEvent = {
  id: string;
  timestamp: string;
  project_id: string;
  project_name: string;
  session_id: string;
  phase: string;
  action: "review_needed" | "approved" | "error";
};

type ProjectRegistryOptions = {
  workspaces: string[];
  depth?: number;
  ignored?: string[];
  now?: () => Date;
};

type SessionStateSummary = {
  phase?: string;
  archived?: boolean;
};

const DEFAULT_IGNORES = [".git", "node_modules", "dist", "build", "coverage", "vendor"];
const MAX_ACTIVITY = 50;

function actionForPhase(phase: string): ActivityEvent["action"] | null {
  if (phase === Phase.UserReview) {
    return "review_needed";
  }
  if (phase === Phase.Approved) {
    return "approved";
  }
  if (phase === Phase.Error) {
    return "error";
  }
  return null;
}

async function readStatePhase(filePath: string): Promise<SessionStateSummary | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = loadYaml(raw);
    if (!isRecord(parsed)) {
      return null;
    }
    const phase = typeof parsed.phase === "string" ? parsed.phase : undefined;
    const archived = typeof parsed.archived === "boolean" ? parsed.archived : undefined;
    return { phase, archived };
  } catch {
    return null;
  }
}

export class ProjectRegistry extends EventEmitter {
  private workspaces: string[];
  private depth: number;
  private ignored: Set<string>;
  private projects = new Map<string, ProjectInfo>();
  private projectsByDir = new Map<string, string>();
  private watcher: FSWatcher | null = null;
  private stateWatchers = new Map<string, FSWatcher>();
  private sessionPhases = new Map<string, string>();
  private activity: ActivityEvent[] = [];
  private now: () => Date;

  constructor(options: ProjectRegistryOptions) {
    super();
    this.workspaces = options.workspaces;
    this.depth = options.depth ?? 3;
    this.ignored = new Set(options.ignored ?? DEFAULT_IGNORES);
    this.now = options.now ?? (() => new Date());
  }

  listProjects(): ProjectInfo[] {
    return Array.from(this.projects.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getProject(id: string): ProjectInfo | null {
    return this.projects.get(id) ?? null;
  }

  getActivity(): ActivityEvent[] {
    return [...this.activity];
  }

  async start(): Promise<void> {
    await this.discoverProjects();
    this.watcher = chokidar.watch(this.workspaces, {
      ignoreInitial: true,
      depth: this.depth,
      ignored: (targetPath) => this.isIgnoredPath(targetPath),
    });
    this.watcher.on("addDir", (dir) => {
      if (path.basename(dir) === ".pl4n") {
        void this.addProject(dir);
      }
    });
    this.watcher.on("unlinkDir", (dir) => {
      if (path.basename(dir) === ".pl4n") {
        void this.removeProject(dir);
      }
    });
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (watcher) {
      await watcher.close();
    }
    const closers = Array.from(this.stateWatchers.values()).map((watcher) => watcher.close());
    await Promise.allSettled(closers);
    this.stateWatchers.clear();
    this.projects.clear();
    this.projectsByDir.clear();
    this.sessionPhases.clear();
  }

  private isIgnoredPath(targetPath: string): boolean {
    const parts = targetPath.split(path.sep);
    return parts.some((part) => this.ignored.has(part));
  }

  private async discoverProjects(): Promise<void> {
    const queue: Array<{ dir: string; depth: number }> = this.workspaces.map((dir) => ({
      dir,
      depth: 0,
    }));

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }
      if (this.isIgnoredPath(current.dir)) {
        continue;
      }

      let entries: Dirent[];
      try {
        entries = await fs.readdir(current.dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (this.ignored.has(entry.name)) {
          continue;
        }
        const fullPath = path.join(current.dir, entry.name);
        if (entry.name === ".pl4n") {
          await this.addProject(fullPath);
          continue;
        }
        if (current.depth < this.depth) {
          queue.push({ dir: fullPath, depth: current.depth + 1 });
        }
      }
    }
  }

  private resolveUniqueId(projectRoot: string): string {
    const base = createProjectId(projectRoot);
    if (!this.projects.has(base)) {
      return base;
    }
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base}-${i}`;
      if (!this.projects.has(candidate)) {
        return candidate;
      }
    }
    return `${base}-${Date.now()}`;
  }

  private async addProject(pl4nDir: string): Promise<void> {
    const projectRoot = path.dirname(pl4nDir);
    const existingId = this.projectsByDir.get(pl4nDir);
    if (existingId) {
      return;
    }
    const id = this.resolveUniqueId(projectRoot);
    const manager = new SessionManager(pl4nDir);
    const info: ProjectInfo = {
      id,
      name: path.basename(projectRoot),
      root: projectRoot,
      pl4nDir,
      manager,
    };
    this.projects.set(id, info);
    this.projectsByDir.set(pl4nDir, id);
    await this.watchProjectStates(info);
    this.emit("project_added", info);
  }

  private async removeProject(pl4nDir: string): Promise<void> {
    const id = this.projectsByDir.get(pl4nDir);
    if (!id) {
      return;
    }
    this.projectsByDir.delete(pl4nDir);
    const info = this.projects.get(id);
    if (info) {
      this.projects.delete(id);
      const watcher = this.stateWatchers.get(id);
      if (watcher) {
        await watcher.close();
        this.stateWatchers.delete(id);
      }
      this.emit("project_removed", info);
    }
  }

  private async watchProjectStates(project: ProjectInfo): Promise<void> {
    const watcher = chokidar.watch(path.join(project.pl4nDir, "sessions", "**", "state.yaml"), {
      ignoreInitial: false,
    });
    watcher.on("add", (filePath) => {
      void this.handleStateFile(project, filePath, false);
    });
    watcher.on("change", (filePath) => {
      void this.handleStateFile(project, filePath, true);
    });
    watcher.on("unlink", (filePath) => {
      this.handleStateRemove(project, filePath);
    });
    this.stateWatchers.set(project.id, watcher);
  }

  private handleStateRemove(project: ProjectInfo, filePath: string): void {
    const sessionId = path.basename(path.dirname(filePath));
    const key = `${project.id}:${sessionId}`;
    this.sessionPhases.delete(key);
  }

  private async handleStateFile(
    project: ProjectInfo,
    filePath: string,
    emit: boolean,
  ): Promise<void> {
    const sessionId = path.basename(path.dirname(filePath));
    const summary = await readStatePhase(filePath);
    if (!summary?.phase) {
      return;
    }
    if (summary.archived) {
      const key = `${project.id}:${sessionId}`;
      this.sessionPhases.delete(key);
      return;
    }
    const key = `${project.id}:${sessionId}`;
    const previous = this.sessionPhases.get(key);
    this.sessionPhases.set(key, summary.phase);
    if (!emit || !previous || previous === summary.phase) {
      return;
    }
    const action = actionForPhase(summary.phase);
    if (!action) {
      return;
    }
    const event: ActivityEvent = {
      id: crypto.randomUUID(),
      timestamp: this.now().toISOString(),
      project_id: project.id,
      project_name: project.name,
      session_id: sessionId,
      phase: summary.phase,
      action,
    };
    this.activity.unshift(event);
    if (this.activity.length > MAX_ACTIVITY) {
      this.activity.length = MAX_ACTIVITY;
    }
    this.emit("activity", event);
  }
}
