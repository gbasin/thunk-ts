import { promises as fs } from "fs";
import path from "path";

import { createHandlers } from "./handlers";
import { findAvailablePort } from "./network";
import { ProjectRegistry } from "./projects";
import { createSseManager } from "./sse";
import { resolveServerConfig } from "./config";

type ServerStart = {
  workspaces: string[];
  port: number;
  bind: string;
  globalDir: string;
};

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

async function ensureServerInfo(globalDir: string, port: number, bind: string): Promise<void> {
  const infoPath = path.join(globalDir, "server.json");
  const now = new Date().toISOString();
  const info = {
    pid: process.pid,
    port,
    bind,
    started_at: now,
    last_activity: now,
  };
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(infoPath, `${JSON.stringify(info)}\n`, "utf8");
}

export async function startServer(opts?: Partial<ServerStart>): Promise<void> {
  const resolved = await resolveServerConfig({ cwd: process.cwd() });
  const globalDir = opts?.globalDir ?? resolved.globalDir;
  const workspaces = opts?.workspaces ?? resolved.workspaces;
  const bind = opts?.bind ?? resolved.bind;
  const port = opts?.port ?? (await findAvailablePort(resolved.port ?? 3456));

  await ensureServerInfo(globalDir, port, bind);

  const registry = new ProjectRegistry({ workspaces });
  await registry.start();
  const sse = createSseManager(registry);
  const handlers = createHandlers({ globalDir, registry, sse });

  const server = Bun.serve({
    port,
    hostname: bind,
    fetch: async (req) => {
      const url = new URL(req.url);
      const pathname = url.pathname;
      const segments = pathname.split("/").filter(Boolean);

      if (pathname === "/") {
        return new Response(null, {
          status: 302,
          headers: { Location: `/projects${url.search}` },
        });
      }

      if (segments[0] === "projects") {
        if (segments.length === 1) {
          return await handlers.handleProjectsPage(req);
        }
        const projectId = segments[1];
        if (segments[2] === "sessions" && segments.length === 3) {
          return await handlers.handleProjectSessionsPage(req, projectId);
        }
        if (segments[2] === "edit" && segments.length === 4) {
          const sessionId = segments[3];
          return await handlers.handleEdit(req, projectId, sessionId);
        }
        return new Response("Not Found", { status: 404 });
      }

      if (segments[0] === "api") {
        if (segments[1] === "projects") {
          if (segments.length === 2) {
            return await handlers.handleProjects(req);
          }
          const projectId = segments[2];
          if (segments[3] === "sessions" && segments.length === 4) {
            return await handlers.handleProjectSessions(req, projectId);
          }
          if (segments[3] === "content" && segments.length === 5) {
            return await handlers.handleGetContent(req, projectId, segments[4]);
          }
          if (segments[3] === "save" && segments.length === 5) {
            if (req.method !== "POST") {
              return new Response("Method Not Allowed", { status: 405 });
            }
            return await handlers.handleSave(req, projectId, segments[4]);
          }
          if (segments[3] === "autosave" && segments.length === 5) {
            if (req.method !== "POST" && req.method !== "DELETE") {
              return new Response("Method Not Allowed", { status: 405 });
            }
            return await handlers.handleAutosave(req, projectId, segments[4]);
          }
          if (segments[3] === "continue" && segments.length === 5) {
            if (req.method !== "POST") {
              return new Response("Method Not Allowed", { status: 405 });
            }
            return await handlers.handleContinue(req, projectId, segments[4]);
          }
          if (segments[3] === "status" && segments.length === 5) {
            return await handlers.handleStatus(req, projectId, segments[4]);
          }
          if (segments[3] === "approve" && segments.length === 5) {
            if (req.method !== "POST") {
              return new Response("Method Not Allowed", { status: 405 });
            }
            return await handlers.handleApprove(req, projectId, segments[4]);
          }
        }

        if (segments[1] === "activity" && segments.length === 2) {
          return await handlers.handleActivity(req);
        }
        if (segments[1] === "events" && segments.length === 2) {
          return await handlers.handleEvents(req);
        }
      }

      if (segments[0] === "assets") {
        const assetPath = segments.slice(1).join("/");
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
    await registry.stop();
    sse.close();
    await server.stop(true);
    await fs.rm(path.join(globalDir, "server.json"), { force: true });
    resolveStop?.();
  };

  const handleSignal = async () => {
    await shutdown();
  };
  process.on("SIGTERM", handleSignal);
  process.on("SIGINT", handleSignal);

  await stopPromise;
}

async function main(): Promise<void> {
  const port = parsePortArg(process.argv) ?? (await findAvailablePort(3456));
  const resolved = await resolveServerConfig({ cwd: process.cwd(), port });
  await startServer({
    workspaces: resolved.workspaces,
    bind: resolved.bind,
    globalDir: resolved.globalDir,
    port,
  });
}

if (import.meta.main) {
  void main();
}
