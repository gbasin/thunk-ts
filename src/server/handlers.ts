import { promises as fs } from "fs";
import path from "path";

import { Phase } from "../models";
import type { SessionManager } from "../session";
import { validateGlobalToken, validateSessionToken } from "./auth";
import { updateServerActivity } from "./daemon";

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
  pl4nDir: string;
  manager: SessionManager;
  spawn?: SpawnLike;
  now?: () => Date;
};

type ContentPayload = {
  content: string;
  mtime: number;
};

type DraftPayload = {
  content: string;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

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

function draftFilePath(turnFile: string): string {
  const dir = path.dirname(turnFile);
  const base = path.basename(turnFile, ".md");
  return path.join(dir, `${base}-draft.md`);
}

function parseToken(req: Request): string | null {
  const url = new URL(req.url);
  return url.searchParams.get("t");
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
  const draftFile = draftFilePath(turnFile);
  await fs.rm(draftFile, { force: true });
  return { status: "ok", mtime: newStat.mtimeMs };
}

function resolveCliEntrypoint(): string {
  return path.resolve(import.meta.dir, "..", "index.ts");
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function spawnContinue(sessionId: string, pl4nDir: string, spawn: SpawnLike): Promise<void> {
  const entrypoint = resolveCliEntrypoint();
  const bun = shellEscape(process.execPath);
  const entry = shellEscape(entrypoint);
  const sessionArg = shellEscape(sessionId);
  const pl4nArg = shellEscape(pl4nDir);
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

export function createHandlers(context: HandlerContext) {
  const spawn = context.spawn ?? Bun.spawn;
  const now = context.now ?? (() => new Date());

  return {
    async handleEdit(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }

      const template = await resolveTemplate("index.html");
      if (!template) {
        return jsonResponse(500, { error: "missing editor template" });
      }

      const html = templateReplace(template, {
        __SESSION_ID__: session.sessionId,
        __TOKEN__: token ?? "",
        __TURN__: String(session.turn),
        __PHASE__: session.phase,
        __READ_ONLY__: session.phase === Phase.UserReview ? "false" : "true",
      });

      return textResponse(200, html, "text/html; charset=utf-8");
    },

    async handleList(req: Request): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateGlobalToken(token, context.pl4nDir))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const sessions = await context.manager.listSessions();
      const items = [] as Record<string, unknown>[];
      for (const session of sessions) {
        const canEdit = session.phase === Phase.UserReview;
        const sessionToken = canEdit
          ? await context.manager.ensureSessionToken(session.sessionId)
          : null;
        items.push({
          session_id: session.sessionId,
          task: session.task,
          turn: session.turn,
          phase: session.phase,
          updated_at: session.updatedAt.toISOString(),
          edit_path:
            canEdit && sessionToken ? `/edit/${session.sessionId}?t=${sessionToken}` : null,
        });
      }

      const template = await resolveTemplate("list.html");
      if (!template) {
        return jsonResponse(500, { error: "missing list template" });
      }

      const payload = JSON.stringify({ sessions: items }).replace(/</g, "\\u003c");
      const html = templateReplace(template, {
        __LIST_DATA__: payload,
      });
      return textResponse(200, html, "text/html; charset=utf-8");
    },

    async handleGetContent(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }

      const loaded = await loadContentFile(context.manager, sessionId);
      if (!loaded) {
        return jsonResponse(404, { error: "content not found" });
      }

      const draftFile = draftFilePath(loaded.filePath);
      let draftContent: string | null = null;
      let hasDraft = false;
      try {
        draftContent = await fs.readFile(draftFile, "utf8");
        hasDraft = true;
      } catch {
        draftContent = null;
      }

      return jsonResponse(200, {
        content: loaded.content,
        mtime: loaded.mtime,
        turn: session.turn,
        phase: session.phase,
        readOnly: session.phase !== Phase.UserReview,
        hasDraft,
        draft: draftContent,
      });
    },

    async handleSave(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      const payload = await parseJson<ContentPayload>(req);
      if (!payload || typeof payload.content !== "string" || typeof payload.mtime !== "number") {
        return jsonResponse(400, { error: "invalid payload" });
      }

      const result = await persistContent(context.manager, sessionId, payload);
      if (!result) {
        return jsonResponse(404, { error: "session not found" });
      }
      if (result.status === "stale") {
        return jsonResponse(409, { error: "stale content", mtime: result.mtime });
      }

      await updateServerActivity(context.pl4nDir, now());

      return jsonResponse(200, { mtime: result.mtime });
    },

    async handleDraft(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      const paths = context.manager.getPaths(sessionId);
      const turnFile = paths.turnFile(session.turn);
      const draftFile = draftFilePath(turnFile);

      if (req.method === "DELETE") {
        await fs.rm(draftFile, { force: true });
        await updateServerActivity(context.pl4nDir, now());
        return jsonResponse(200, { discarded: true });
      }

      const payload = await parseJson<DraftPayload>(req);
      if (!payload || typeof payload.content !== "string") {
        return jsonResponse(400, { error: "invalid payload" });
      }

      await fs.mkdir(path.dirname(turnFile), { recursive: true });
      await fs.writeFile(draftFile, payload.content, "utf8");
      await updateServerActivity(context.pl4nDir, now());

      return jsonResponse(200, { saved: true });
    },

    async handleContinue(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      const payload = await parseJson<ContentPayload>(req);
      if (!payload || typeof payload.content !== "string" || typeof payload.mtime !== "number") {
        return jsonResponse(400, { error: "invalid payload" });
      }

      const result = await persistContent(context.manager, sessionId, payload);
      if (!result) {
        return jsonResponse(404, { error: "session not found" });
      }
      if (result.status === "stale") {
        return jsonResponse(409, { error: "stale content", mtime: result.mtime });
      }

      await updateServerActivity(context.pl4nDir, now());
      await spawnContinue(sessionId, context.pl4nDir, spawn);

      return jsonResponse(202, { accepted: true });
    },

    async handleApprove(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }
      if (session.phase !== Phase.UserReview) {
        return jsonResponse(423, { error: "session locked" });
      }

      if (await context.manager.hasQuestions(sessionId)) {
        return jsonResponse(400, { error: "unanswered questions" });
      }

      const paths = context.manager.getPaths(sessionId);
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
      await context.manager.saveState(session);

      return jsonResponse(200, {
        phase: session.phase,
        final_turn: session.turn,
        plan_path: planLink,
      });
    },

    async handleStatus(req: Request, sessionId: string): Promise<Response> {
      const token = parseToken(req);
      if (!(await validateSessionToken(sessionId, token, context.manager))) {
        return jsonResponse(401, { error: "invalid token" });
      }

      const session = await context.manager.loadSession(sessionId);
      if (!session) {
        return jsonResponse(404, { error: "session not found" });
      }

      return jsonResponse(200, { turn: session.turn, phase: session.phase });
    },

    async handleAssets(_: Request, assetPath: string): Promise<Response> {
      const resolved = await resolveAssetPath(assetPath);
      if (resolved) {
        return new Response(Bun.file(resolved));
      }

      if (assetPath === "monaco.css") {
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

      if (assetPath.endsWith(".js")) {
        const srcRoot = path.resolve(import.meta.dir, "..", "web");
        const sourcePath = path.join(srcRoot, assetPath.replace(/\.js$/, ".ts"));
        try {
          await fs.access(sourcePath);
        } catch {
          return jsonResponse(404, { error: "asset not found" });
        }

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
      }

      return jsonResponse(404, { error: "asset not found" });
    },

    async handleIdleCheck(): Promise<boolean> {
      const infoPath = path.join(context.pl4nDir, "server.json");
      try {
        const raw = await fs.readFile(infoPath, "utf8");
        const info = JSON.parse(raw) as { last_activity?: string };
        if (!info.last_activity) {
          return false;
        }
        const last = new Date(info.last_activity).getTime();
        if (Number.isNaN(last) || Date.now() - last < ONE_DAY_MS) {
          return false;
        }
      } catch {
        return false;
      }

      const sessions = await context.manager.listSessions();
      if (sessions.some((session) => session.phase === Phase.UserReview)) {
        return false;
      }

      return true;
    },
  };
}
