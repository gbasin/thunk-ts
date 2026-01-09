import { promises as fs } from "fs";
import path from "path";

import { Phase } from "../models";
import type { SessionManager } from "../session";
import { ensureGlobalToken, validateGlobalToken, validateSessionToken } from "./auth";
import { updateServerActivity } from "./daemon";
import type { ProjectInfo, ProjectRegistry } from "./projects";
import type { SseManager } from "./sse";

type SpawnOptions = {
  cmd: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: "ignore" | "pipe" | "inherit" | null;
  stdout?: "ignore" | "pipe" | "inherit" | number | null;
  stderr?: "ignore" | "pipe" | "inherit" | number | null;
  detached?: boolean;
};
type SpawnLike = (options: SpawnOptions) => { pid: number };

type HandlerContext = {
  globalDir: string;
  registry: ProjectRegistry;
  sse: SseManager;
  authMode: "strict" | "trusted";
  isTrustedRequest?: (req: Request) => boolean;
  spawn?: SpawnLike;
  now?: () => Date;
};

type ContentPayload = {
  content: string;
  mtime: number;
};

type AutosavePayload = {
  content: string;
};

type ArchivedFilter = "exclude" | "only" | "all";

function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status: number, body: string, contentType: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

function templateReplace(template: string, replacements: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(key, value);
  }
  return result;
}

function autosaveFilePath(turnFile: string): string {
  const dir = path.dirname(turnFile);
  const base = path.basename(turnFile, ".md");
  return path.join(dir, `${base}-autosave.md`);
}

function parseToken(req: Request): string | null {
  const url = new URL(req.url);
  return url.searchParams.get("t");
}

function parseArchivedFilter(req: Request, fallback: ArchivedFilter = "exclude"): ArchivedFilter {
  const url = new URL(req.url);
  const value = url.searchParams.get("archived");
  if (!value) {
    return fallback;
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
    return "only";
  }
  return "exclude";
}

async function resolveTemplate(fileName: string): Promise<string | null> {
  const srcPath = path.resolve(import.meta.dir, "..", "web", fileName);
  const distPath = path.resolve(import.meta.dir, "..", "..", "dist", "web", fileName);
  // Prefer src/ for live development, fall back to dist/ for packaged builds
  try {
    return await fs.readFile(srcPath, "utf8");
  } catch {
    try {
      return await fs.readFile(distPath, "utf8");
    } catch {
      return null;
    }
  }
}

async function resolveAssetPath(assetPath: string): Promise<string | null> {
  const normalized = path.normalize(assetPath).replace(/^([/\\])/, "");
  if (normalized.includes("..")) {
    return null;
  }
  const srcRoot = path.resolve(import.meta.dir, "..", "web");
  const distRoot = path.resolve(import.meta.dir, "..", "..", "dist", "web");
  const srcPath = path.join(srcRoot, normalized);
  const distPath = path.join(distRoot, normalized);

  // Prefer src/ for live development, fall back to dist/ for packaged builds
  try {
    await fs.access(srcPath);
    return srcPath;
  } catch {
    try {
      await fs.access(distPath);
      return distPath;
    } catch {
      return null;
    }
  }
}

async function parseJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

async function loadContentFile(
  manager: SessionManager,
  sessionId: string,
): Promise<{ filePath: string; content: string; mtime: number } | null> {
  const session = await manager.loadSession(sessionId);
  if (!session) {
    return null;
  }
  const paths = manager.getPaths(sessionId);
  const turnFile = paths.turnFile(session.turn);
  const planFile = path.join(paths.root, "PLAN.md");
  const target = session.phase === Phase.Approved ? planFile : turnFile;

  try {
    const content = await fs.readFile(target, "utf8");
    const stat = await fs.stat(target);
    return { filePath: target, content, mtime: stat.mtimeMs };
  } catch {
    if (session.phase === Phase.Approved && target !== turnFile) {
      try {
        const content = await fs.readFile(turnFile, "utf8");
        const stat = await fs.stat(turnFile);
        return { filePath: turnFile, content, mtime: stat.mtimeMs };
      } catch {
        return null;
      }
    }
    return null;
  }
}

type PersistResult = { status: "ok"; mtime: number } | { status: "stale"; mtime: number };

async function persistContent(
  manager: SessionManager,
  sessionId: string,
  payload: ContentPayload,
): Promise<PersistResult | null> {
  const session = await manager.loadSession(sessionId);
  if (!session) {
    return null;
  }
  const paths = manager.getPaths(sessionId);
  const turnFile = paths.turnFile(session.turn);

  try {
    const stat = await fs.stat(turnFile);
    if (Math.round(stat.mtimeMs) !== Math.round(payload.mtime)) {
      return { status: "stale", mtime: stat.mtimeMs };
    }
  } catch {
    // allow write if file doesn't exist
  }

  await fs.mkdir(path.dirname(turnFile), { recursive: true });
  await fs.writeFile(turnFile, payload.content, "utf8");
  const newStat = await fs.stat(turnFile);
  const autosaveFile = autosaveFilePath(turnFile);
  await fs.rm(autosaveFile, { force: true });
  return { status: "ok", mtime: newStat.mtimeMs };
}

function resolveCliEntrypoint(): string {
  return path.resolve(import.meta.dir, "..", "index.ts");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function spawnContinue(
  sessionId: string,
  projectPl4nDir: string,
  spawn: SpawnLike,
): Promise<void> {
  const entrypoint = resolveCliEntrypoint();
  const bun = shellEscape(process.execPath);
  const entry = shellEscape(entrypoint);
  const sessionArg = shellEscape(sessionId);
  const pl4nArg = shellEscape(projectPl4nDir);
  const cmd = [
    "sh",
    "-c",
    `${bun} ${entry} continue --session ${sessionArg} --pl4n-dir ${pl4nArg}`,
  ];
  spawn({
    cmd,
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

function escapeJsonForHtml(payload: Record<string, unknown>): string {
  return JSON.stringify(payload).replace(/</g, "\\u003c");
}

function projectNotFound(projectId: string): Response {
  return jsonResponse(404, { error: `project ${projectId} not found` });
}

function sessionNotFound(): Response {
  return jsonResponse(404, { error: "session not found" });
}

export function createHandlers(context: HandlerContext) {
  const spawn = context.spawn ?? Bun.spawn;
  const now = context.now ?? (() => new Date());
  const isTrusted = (req: Request): boolean =>
    context.authMode === "trusted" && (context.isTrustedRequest?.(req) ?? false);

  const requireGlobalAuth = async (req: Request): Promise<Response | null> => {
    if (isTrusted(req)) {
      return null;
    }
    const token = parseToken(req);
    if (!(await validateGlobalToken(token, context.globalDir))) {
      return jsonResponse(401, { error: "invalid token" });
    }
    return null;
  };

  const requireSessionAuth = async (
    req: Request,
    sessionId: string,
    manager: SessionManager,
  ): Promise<Response | null> => {
    if (isTrusted(req)) {
      return null;
    }
    const token = parseToken(req);
    if (!(await validateSessionToken(sessionId, token, manager))) {
      return jsonResponse(401, { error: "invalid token" });
    }
    return null;
  };

  const requireProject = (projectId: string): ProjectInfo | null =>
    context.registry.getProject(projectId);

  return {
    async handleProjectsPage(req: Request): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }

      const template = await resolveTemplate("projects.html");
      if (!template) {
        return jsonResponse(500, { error: "missing projects template" });
      }

      const projects = context.registry.listProjects();
      const items = [];
      for (const project of projects) {
        const sessions = await project.manager.listSessions();
        const latest = sessions[0]?.updatedAt?.toISOString() ?? null;
        items.push({
          project_id: project.id,
          name: project.name,
          path: project.root,
          session_count: sessions.length,
          updated_at: latest,
        });
      }
      const payload = escapeJsonForHtml({ projects: items });
      const html = templateReplace(template, {
        __PROJECTS_DATA__: payload,
      });
      return textResponse(200, html, "text/html; charset=utf-8");
    },

    async handleProjects(req: Request): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }

      const projects = context.registry.listProjects();
      const payload = [];
      for (const project of projects) {
        const sessions = await project.manager.listSessions();
        const latest = sessions[0]?.updatedAt?.toISOString() ?? null;
        payload.push({
          project_id: project.id,
          name: project.name,
          path: project.root,
          session_count: sessions.length,
          updated_at: latest,
        });
      }
      return jsonResponse(200, { projects: payload });
    },

    async handleProjectSessionsPage(req: Request, projectId: string): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }

      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }

      const sessions = await project.manager.listSessions({
        archived: parseArchivedFilter(req, "all"),
      });
      const items = [] as Record<string, unknown>[];
      for (const session of sessions) {
        const canEdit = session.phase === Phase.UserReview;
        const sessionToken = canEdit
          ? await project.manager.ensureSessionToken(session.sessionId)
          : null;
        items.push({
          session_id: session.sessionId,
          task: session.task,
          turn: session.turn,
          phase: session.phase,
          archived: session.archived,
          updated_at: session.updatedAt.toISOString(),
          edit_path:
            canEdit && sessionToken
              ? `/projects/${projectId}/edit/${session.sessionId}?t=${sessionToken}`
              : null,
        });
      }

      const template = await resolveTemplate("list.html");
      if (!template) {
        return jsonResponse(500, { error: "missing list template" });
      }

      const payload = escapeJsonForHtml({
        project: {
          project_id: project.id,
          name: project.name,
          path: project.root,
        },
        sessions: items,
      });
      const html = templateReplace(template, {
        __LIST_DATA__: payload,
      });
      return textResponse(200, html, "text/html; charset=utf-8");
    },

    async handleProjectSessions(req: Request, projectId: string): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }

      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }

      const sessions = await project.manager.listSessions({ archived: parseArchivedFilter(req) });
      const payload = [];
      for (const session of sessions) {
        const canEdit = session.phase === Phase.UserReview;
        const sessionToken = canEdit
          ? await project.manager.ensureSessionToken(session.sessionId)
          : null;
        payload.push({
          session_id: session.sessionId,
          task: session.task,
          turn: session.turn,
          phase: session.phase,
          archived: session.archived,
          updated_at: session.updatedAt.toISOString(),
          edit_path:
            canEdit && sessionToken
              ? `/projects/${projectId}/edit/${session.sessionId}?t=${sessionToken}`
              : null,
        });
      }
      return jsonResponse(200, { sessions: payload });
    },

    async handleEdit(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }
      const token = parseToken(req);

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }

      const template = await resolveTemplate("index.html");
      if (!template) {
        return jsonResponse(500, { error: "missing editor template" });
      }

      const paths = project.manager.getPaths(sessionId);
      const turnFile = paths.turnFile(session.turn);
      const globalToken = await ensureGlobalToken(context.globalDir, project.pl4nDir);
      const html = templateReplace(template, {
        __SESSION_ID__: session.sessionId,
        __TOKEN__: token ?? "",
        __TURN__: String(session.turn),
        __PHASE__: session.phase,
        __READ_ONLY__: session.phase === Phase.UserReview ? "false" : "true",
        __PROJECT_ID__: project.id,
        __PROJECT_NAME__: project.name,
        __GLOBAL_TOKEN__: globalToken,
        __FILE_PATH__: turnFile,
      });

      return textResponse(200, html, "text/html; charset=utf-8");
    },

    async handleGetContent(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }

      const loaded = await loadContentFile(project.manager, sessionId);
      if (!loaded) {
        return jsonResponse(404, { error: "content not found" });
      }

      const paths = project.manager.getPaths(sessionId);
      const turnFile = paths.turnFile(session.turn);
      const autosaveFile = autosaveFilePath(turnFile);
      let autosaveContent: string | null = null;
      let hasAutosave = false;
      try {
        autosaveContent = await fs.readFile(autosaveFile, "utf8");
        hasAutosave = true;
      } catch {
        autosaveContent = null;
      }

      const snapshotFile = turnFile.replace(/\.md$/, ".snapshot.md");
      let snapshotContent: string | null = null;
      try {
        snapshotContent = await fs.readFile(snapshotFile, "utf8");
      } catch {
        snapshotContent = null;
      }

      return jsonResponse(200, {
        content: loaded.content,
        mtime: loaded.mtime,
        turn: session.turn,
        phase: session.phase,
        archived: session.archived,
        readOnly: session.phase !== Phase.UserReview,
        hasAutosave,
        autosave: autosaveContent,
        snapshot: snapshotContent,
        agents: session.agents,
      });
    },

    async handleArchive(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }

      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }

      const nextArchived = !session.archived;
      const updated = await project.manager.setArchived(sessionId, nextArchived);
      if (!updated) {
        return sessionNotFound();
      }

      return jsonResponse(200, { session_id: sessionId, archived: nextArchived });
    },

    async handleSave(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      const payload = await parseJson<ContentPayload>(req);
      if (!payload || typeof payload.content !== "string" || typeof payload.mtime !== "number") {
        return jsonResponse(400, { error: "invalid payload" });
      }

      const result = await persistContent(project.manager, sessionId, payload);
      if (!result) {
        return sessionNotFound();
      }
      if (result.status === "stale") {
        return jsonResponse(409, { error: "stale content", mtime: result.mtime });
      }

      await updateServerActivity(context.globalDir, now());

      return jsonResponse(200, { mtime: result.mtime });
    },

    async handleAutosave(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      const paths = project.manager.getPaths(sessionId);
      const turnFile = paths.turnFile(session.turn);
      const autosaveFile = autosaveFilePath(turnFile);

      if (req.method === "DELETE") {
        await fs.rm(autosaveFile, { force: true });
        await updateServerActivity(context.globalDir, now());
        return jsonResponse(200, { discarded: true });
      }

      const payload = await parseJson<AutosavePayload>(req);
      if (!payload || typeof payload.content !== "string") {
        return jsonResponse(400, { error: "invalid payload" });
      }

      await fs.mkdir(path.dirname(turnFile), { recursive: true });
      await fs.writeFile(autosaveFile, payload.content, "utf8");
      await updateServerActivity(context.globalDir, now());

      return jsonResponse(200, { saved: true });
    },

    async handleContinue(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      const payload = await parseJson<ContentPayload>(req);
      if (!payload || typeof payload.content !== "string" || typeof payload.mtime !== "number") {
        return jsonResponse(400, { error: "invalid payload" });
      }

      const result = await persistContent(project.manager, sessionId, payload);
      if (!result) {
        return sessionNotFound();
      }
      if (result.status === "stale") {
        return jsonResponse(409, { error: "stale content", mtime: result.mtime });
      }

      await updateServerActivity(context.globalDir, now());
      await spawnContinue(sessionId, project.pl4nDir, spawn);

      return jsonResponse(202, { accepted: true });
    },

    async handleApprove(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      if (await project.manager.hasQuestions(sessionId)) {
        return jsonResponse(400, { error: "unanswered questions" });
      }

      const paths = project.manager.getPaths(sessionId);
      const turnFile = paths.turnFile(session.turn);
      const planLink = path.join(paths.root, "PLAN.md");

      try {
        await fs.rm(planLink, { force: true });
      } catch {
        // ignore
      }

      const relativeTarget = path.relative(paths.root, turnFile);
      await fs.symlink(relativeTarget, planLink);

      session.phase = Phase.Approved;
      await project.manager.saveState(session);

      return jsonResponse(200, {
        phase: session.phase,
        final_turn: session.turn,
        plan_path: planLink,
      });
    },

    async handleStatus(req: Request, projectId: string, sessionId: string): Promise<Response> {
      const project = requireProject(projectId);
      if (!project) {
        return projectNotFound(projectId);
      }
      const authError = await requireSessionAuth(req, sessionId, project.manager);
      if (authError) {
        return authError;
      }

      const session = await project.manager.loadSession(sessionId);
      if (!session) {
        return sessionNotFound();
      }

      return jsonResponse(200, {
        turn: session.turn,
        phase: session.phase,
        agents: session.agents,
      });
    },

    async handleActivity(req: Request): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }
      await updateServerActivity(context.globalDir, now());
      return jsonResponse(200, { events: context.registry.getActivity() });
    },

    async handleEvents(req: Request): Promise<Response> {
      const authError = await requireGlobalAuth(req);
      if (authError) {
        return authError;
      }
      await updateServerActivity(context.globalDir, now());
      return context.sse.handleEvents(context.registry.getActivity());
    },

    async handleAssets(_: Request, assetPath: string): Promise<Response> {
      const normalized = path.normalize(assetPath).replace(/^([/\\])/, "");
      if (normalized.includes("..")) {
        return jsonResponse(404, { error: "asset not found" });
      }

      if (normalized.endsWith(".js")) {
        const srcRoot = path.resolve(import.meta.dir, "..", "web");
        const sourcePath = path.join(srcRoot, normalized.replace(/\.js$/, ".ts"));
        try {
          await fs.access(sourcePath);
          const result = await Bun.build({
            entrypoints: [sourcePath],
            target: "browser",
            format: "esm",
            splitting: false,
          });
          if (!result.success || result.outputs.length === 0) {
            return jsonResponse(500, { error: "asset build failed" });
          }
          return new Response(result.outputs[0], {
            headers: { "Content-Type": "text/javascript" },
          });
        } catch {
          // Fall back to dist assets if source is missing.
        }
      }

      const resolved = await resolveAssetPath(normalized);
      if (resolved) {
        return new Response(Bun.file(resolved));
      }

      if (normalized === "monaco.css") {
        const monacoPath = path.resolve(
          import.meta.dir,
          "..",
          "..",
          "node_modules",
          "monaco-editor",
          "min",
          "vs",
          "editor",
          "editor.main.css",
        );
        try {
          await fs.access(monacoPath);
          return new Response(Bun.file(monacoPath));
        } catch {
          return jsonResponse(404, { error: "asset not found" });
        }
      }

      return jsonResponse(404, { error: "asset not found" });
    },
  };
}
