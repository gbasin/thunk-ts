import { promises as fs } from "fs";
import path from "path";

import { SessionManager } from "../session";
import { createHandlers } from "./handlers";
import { findAvailablePort } from "./network";

type ServerStart = {
  pl4nDir: string;
  port: number;
};

const IDLE_CHECK_MS = 60 * 60 * 1000;

export function parsePortArg(argv: string[]): number | null {
  const index = argv.findIndex((arg) => arg === "--port");
  if (index >= 0 && argv[index + 1]) {
    const parsed = Number(argv[index + 1]);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  const envPort = process.env.PL4N_PORT;
  if (envPort) {
    const parsed = Number(envPort);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  return null;
}

export async function resolvePl4nDir(): Promise<string> {
  const envDir = process.env.PL4N_DIR;
  if (envDir) {
    return envDir;
  }

  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, ".pl4n");
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

  return path.join(process.cwd(), ".pl4n");
}

async function ensureServerInfo(pl4nDir: string, port: number): Promise<void> {
  const infoPath = path.join(pl4nDir, "server.json");
  const now = new Date().toISOString();
  const info = {
    pid: process.pid,
    port,
    started_at: now,
    last_activity: now,
  };
  await fs.mkdir(pl4nDir, { recursive: true });
  await fs.writeFile(infoPath, `${JSON.stringify(info)}\n`, "utf8");
}

export async function startServer(opts?: Partial<ServerStart>): Promise<void> {
  const pl4nDir = opts?.pl4nDir ?? (await resolvePl4nDir());
  const port = opts?.port ?? (await findAvailablePort(3456));

  await ensureServerInfo(pl4nDir, port);

  const manager = new SessionManager(pl4nDir);
  const handlers = createHandlers({ pl4nDir, manager });

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

      if (pathname.startsWith("/api/approve/")) {
        const sessionId = pathname.split("/")[3];
        if (!sessionId) {
          return new Response("Not Found", { status: 404 });
        }
        return await handlers.handleApprove(req, sessionId);
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
    await fs.rm(path.join(pl4nDir, "server.json"), { force: true });
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
  const pl4nDir = await resolvePl4nDir();
  await startServer({ pl4nDir, port });
}

if (import.meta.main) {
  void main();
}
