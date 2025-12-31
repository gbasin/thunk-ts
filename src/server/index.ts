import { promises as fs } from "fs";
import path from "path";

import { SessionManager } from "../session";
import { createHandlers } from "./handlers";
import { findAvailablePort } from "./network";

type ServerStart = {
  thunkDir: string;
  port: number;
};

const IDLE_CHECK_MS = 60 * 60 * 1000;

function parsePortArg(argv: string[]): number | null {
  const index = argv.findIndex((arg) => arg === "--port");
  if (index >= 0 && argv[index + 1]) {
    const parsed = Number(argv[index + 1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const envPort = process.env.THUNK_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

async function resolveThunkDir(): Promise<string> {
  const envDir = process.env.THUNK_DIR;
  if (envDir) {
    return envDir;
  }

  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, ".thunk");
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // continue
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return path.join(process.cwd(), ".thunk");
}

async function ensureServerInfo(thunkDir: string, port: number): Promise<void> {
  const infoPath = path.join(thunkDir, "server.json");
  const now = new Date().toISOString();
  const info = {
    pid: process.pid,
    port,
    started_at: now,
    last_activity: now,
  };
  await fs.mkdir(thunkDir, { recursive: true });
  await fs.writeFile(infoPath, `${JSON.stringify(info)}\n`, "utf8");
}

export async function startServer(opts?: Partial<ServerStart>): Promise<void> {
  const thunkDir = opts?.thunkDir ?? (await resolveThunkDir());
  const port = opts?.port ?? (await findAvailablePort(3456));

  await ensureServerInfo(thunkDir, port);

  const manager = new SessionManager(thunkDir);
  const handlers = createHandlers({ thunkDir, manager });

  const server = Bun.serve({
    port,
    hostname: "0.0.0.0",
    fetch: async (req) => {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (pathname === "/list") {
        return await handlers.handleList(req);
      }

      if (pathname.startsWith("/edit/")) {
        const sessionId = pathname.split("/")[2];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleEdit(req, sessionId);
      }

      if (pathname.startsWith("/api/content/")) {
        const sessionId = pathname.split("/")[3];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleGetContent(req, sessionId);
      }

      if (pathname.startsWith("/api/save/")) {
        if (req.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const sessionId = pathname.split("/")[3];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleSave(req, sessionId);
      }

      if (pathname.startsWith("/api/draft/")) {
        if (req.method !== "POST" && req.method !== "DELETE") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const sessionId = pathname.split("/")[3];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleDraft(req, sessionId);
      }

      if (pathname.startsWith("/api/continue/")) {
        if (req.method !== "POST") {
          return new Response("Method Not Allowed", { status: 405 });
        }
        const sessionId = pathname.split("/")[3];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleContinue(req, sessionId);
      }

      if (pathname.startsWith("/api/status/")) {
        const sessionId = pathname.split("/")[3];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleStatus(req, sessionId);
      }

      if (pathname.startsWith("/assets/")) {
        const assetPath = pathname.replace("/assets/", "");
        return await handlers.handleAssets(req, assetPath);
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  let resolveStop: (() => void) | null = null;
  const stopPromise = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });

  const shutdown = async () => {
    await server.stop(true);
    await fs.rm(path.join(thunkDir, "server.json"), { force: true });
    resolveStop?.();
  };

  const timer = setInterval(async () => {
    if (await handlers.handleIdleCheck()) {
      clearInterval(timer);
      await shutdown();
    }
  }, IDLE_CHECK_MS);
  timer.unref?.();

  const handleSignal = async () => {
    clearInterval(timer);
    await shutdown();
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  await stopPromise;
}

async function main(): Promise<void> {
  const port = parsePortArg(process.argv) ?? (await findAvailablePort(3456));
  const thunkDir = await resolveThunkDir();
  await startServer({ thunkDir, port });
}

if (import.meta.main) {
  void main();
}
