import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { Phase } from "../src/models";
import { SessionManager } from "../src/session";
import { ensureGlobalToken } from "../src/server/auth";
import { parsePortArg, startServer } from "../src/server/index";
import { createProjectId } from "../src/server/project-id";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-server-index-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function requireValue<T>(value: T | null | undefined, message: string): NonNullable<T> {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

describe("server index", () => {
  it("routes requests and shuts down on idle", async () => {
    await withTempDir(async (root) => {
      const projectRoot = path.join(root, "project-a");
      const pl4nDir = path.join(projectRoot, ".pl4n");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Server routing");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "Plan content\n", "utf8");

      const sessionToken = state.sessionToken ?? "";
      const globalDir = path.join(root, "global");
      const globalToken = await ensureGlobalToken(globalDir, pl4nDir);
      const projectId = createProjectId(projectRoot);
      const base = "http://localhost";

      const originalServe = Bun.serve;
      const originalOn = process.on;
      let fetchHandler: ((req: Request) => Promise<Response>) | null = null;
      let resolveServe: (() => void) | null = null;
      const serveReady = new Promise<void>((resolve) => {
        resolveServe = resolve;
      });
      let stopCalled = false;
      (Bun as unknown as { serve: typeof Bun.serve }).serve = ((options: {
        fetch: (req: Request) => Promise<Response>;
      }) => {
        fetchHandler = options.fetch;
        resolveServe?.();
        return {
          stop: async () => {
            stopCalled = true;
          },
        } as { stop: (force?: boolean) => Promise<void> };
      }) as typeof Bun.serve;
      let signalHandler: (() => void | Promise<void>) | null = null;
      process.on = ((signal: string, handler: () => void | Promise<void>) => {
        if (signal === "SIGTERM" || signal === "SIGINT") {
          signalHandler = handler;
        }
        return process;
      }) as typeof process.on;

      try {
        const serverPromise = startServer({
          globalDir,
          workspaces: [root],
          bind: "127.0.0.1",
          port: 4567,
        });

        await serveReady;
        if (!fetchHandler) {
          throw new Error("fetch handler not captured");
        }
        const handler = fetchHandler as (req: Request) => Promise<Response>;

        const listRes = await handler(new Request(`${base}/projects?t=${globalToken}`));
        expect(listRes.status).toBe(200);

        const editRes = await handler(
          new Request(`${base}/projects/${projectId}/edit/${state.sessionId}?t=${sessionToken}`),
        );
        expect(editRes.status).toBe(200);

        const editMissing = await handler(new Request(`${base}/projects/${projectId}/edit/`));
        expect(editMissing.status).toBe(404);

        const contentRes = await handler(
          new Request(
            `${base}/api/projects/${projectId}/content/${state.sessionId}?t=${sessionToken}`,
          ),
        );
        expect(contentRes.status).toBe(200);

        const contentMissing = await handler(
          new Request(`${base}/api/projects/${projectId}/content`),
        );
        expect(contentMissing.status).toBe(404);

        const saveMethod = await handler(
          new Request(
            `${base}/api/projects/${projectId}/save/${state.sessionId}?t=${sessionToken}`,
          ),
        );
        expect(saveMethod.status).toBe(405);

        const saveRes = await handler(
          new Request(
            `${base}/api/projects/${projectId}/save/${state.sessionId}?t=${sessionToken}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "Nope\n", mtime: 0 }),
            },
          ),
        );
        expect(saveRes.status).toBe(423);

        const autosaveMethod = await handler(
          new Request(
            `${base}/api/projects/${projectId}/autosave/${state.sessionId}?t=${sessionToken}`,
            {
              method: "PUT",
            },
          ),
        );
        expect(autosaveMethod.status).toBe(405);

        const autosaveRes = await handler(
          new Request(
            `${base}/api/projects/${projectId}/autosave/${state.sessionId}?t=${sessionToken}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "Draft\n" }),
            },
          ),
        );
        expect(autosaveRes.status).toBe(423);

        const continueMethod = await handler(
          new Request(
            `${base}/api/projects/${projectId}/continue/${state.sessionId}?t=${sessionToken}`,
          ),
        );
        expect(continueMethod.status).toBe(405);

        const continueRes = await handler(
          new Request(
            `${base}/api/projects/${projectId}/continue/${state.sessionId}?t=${sessionToken}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: "Nope\n", mtime: 0 }),
            },
          ),
        );
        expect(continueRes.status).toBe(423);

        const statusRes = await handler(
          new Request(
            `${base}/api/projects/${projectId}/status/${state.sessionId}?t=${sessionToken}`,
          ),
        );
        expect(statusRes.status).toBe(200);

        const approveMissing = await handler(
          new Request(`${base}/api/projects/${projectId}/approve/`),
        );
        expect(approveMissing.status).toBe(404);

        const approveRes = await handler(
          new Request(
            `${base}/api/projects/${projectId}/approve/${state.sessionId}?t=${sessionToken}`,
            { method: "POST" },
          ),
        );
        expect(approveRes.status).toBe(423);

        const assetsRes = await handler(new Request(`${base}/assets/styles.css`));
        expect(assetsRes.status).toBe(200);

        const missing = await handler(new Request(`${base}/missing`));
        expect(missing.status).toBe(404);

        const infoPath = path.join(globalDir, "server.json");
        const infoRaw = await fs.readFile(infoPath, "utf8");
        const info = JSON.parse(infoRaw) as Record<string, unknown>;
        info.last_activity = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        await fs.writeFile(infoPath, `${JSON.stringify(info)}\n`, "utf8");

        const signalHandlerFn = requireValue<() => void | Promise<void>>(
          signalHandler,
          "signal handler not registered",
        );
        await signalHandlerFn();
        await serverPromise;

        expect(stopCalled).toBe(true);
        await expect(fs.readFile(infoPath, "utf8")).rejects.toBeDefined();
      } finally {
        (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
        process.on = originalOn;
      }
    });
  });

  it("parses port args and environment", () => {
    const originalPort = process.env.PL4N_PORT;
    process.env.PL4N_PORT = "5123";

    try {
      expect(parsePortArg(["node", "server", "--port", "4040"])).toBe(4040);
      expect(parsePortArg(["node", "server"])).toBe(5123);
      process.env.PL4N_PORT = "bad";
      expect(parsePortArg(["node", "server"])).toBeNull();
    } finally {
      if (originalPort === undefined) {
        delete process.env.PL4N_PORT;
      } else {
        process.env.PL4N_PORT = originalPort;
      }
    }
  });
});
