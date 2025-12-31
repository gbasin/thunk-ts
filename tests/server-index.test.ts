import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { Phase } from "../src/models";
import { SessionManager } from "../src/session";
import { ensureGlobalToken } from "../src/server/auth";
import { parsePortArg, resolvePl4nDir, startServer } from "../src/server/index";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-server-index-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("server index", () => {
  it("routes requests and shuts down on idle", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Server routing");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "Plan content\n", "utf8");

      const sessionToken = state.sessionToken ?? "";
      const globalToken = await ensureGlobalToken(pl4nDir);
      const base = "http://localhost";

      const originalServe = Bun.serve;
      const originalSetInterval = globalThis.setInterval;
      const originalClearInterval = globalThis.clearInterval;
      const originalOn = process.on;
      let fetchHandler: ((req: Request) => Promise<Response>) | null = null;
      let resolveServe: (() => void) | null = null;
      const serveReady = new Promise<void>((resolve) => {
        resolveServe = resolve;
      });
      let stopCalled = false;
      let intervalCallback: (() => void | Promise<void>) | null = null;
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
      globalThis.setInterval = ((fn: () => void | Promise<void>) => {
        intervalCallback = fn;
        return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval;
      globalThis.clearInterval = (() => {}) as typeof clearInterval;
      process.on = (() => process) as typeof process.on;

      try {
        const serverPromise = startServer({ pl4nDir, port: 4567 });

        await serveReady;
        if (!fetchHandler) {
          throw new Error("fetch handler not captured");
        }
        const handler = fetchHandler as (req: Request) => Promise<Response>;

        const listRes = await handler(new Request(`${base}/list?t=${globalToken}`));
        expect(listRes.status).toBe(200);

        const editRes = await handler(
          new Request(`${base}/edit/${state.sessionId}?t=${sessionToken}`),
        );
        expect(editRes.status).toBe(200);

        const editMissing = await handler(new Request(`${base}/edit/`));
        expect(editMissing.status).toBe(404);

        const contentRes = await handler(
          new Request(`${base}/api/content/${state.sessionId}?t=${sessionToken}`),
        );
        expect(contentRes.status).toBe(200);

        const contentMissing = await handler(new Request(`${base}/api/content/`));
        expect(contentMissing.status).toBe(404);

        const saveMethod = await handler(
          new Request(`${base}/api/save/${state.sessionId}?t=${sessionToken}`),
        );
        expect(saveMethod.status).toBe(405);

        const saveRes = await handler(
          new Request(`${base}/api/save/${state.sessionId}?t=${sessionToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Nope\n", mtime: 0 }),
          }),
        );
        expect(saveRes.status).toBe(423);

        const draftMethod = await handler(
          new Request(`${base}/api/draft/${state.sessionId}?t=${sessionToken}`, {
            method: "PUT",
          }),
        );
        expect(draftMethod.status).toBe(405);

        const draftRes = await handler(
          new Request(`${base}/api/draft/${state.sessionId}?t=${sessionToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Draft\n" }),
          }),
        );
        expect(draftRes.status).toBe(423);

        const continueMethod = await handler(
          new Request(`${base}/api/continue/${state.sessionId}?t=${sessionToken}`),
        );
        expect(continueMethod.status).toBe(405);

        const continueRes = await handler(
          new Request(`${base}/api/continue/${state.sessionId}?t=${sessionToken}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Nope\n", mtime: 0 }),
          }),
        );
        expect(continueRes.status).toBe(423);

        const statusRes = await handler(
          new Request(`${base}/api/status/${state.sessionId}?t=${sessionToken}`),
        );
        expect(statusRes.status).toBe(200);

        const approveMissing = await handler(new Request(`${base}/api/approve/`));
        expect(approveMissing.status).toBe(404);

        const approveRes = await handler(
          new Request(`${base}/api/approve/${state.sessionId}?t=${sessionToken}`),
        );
        expect(approveRes.status).toBe(423);

        const assetsRes = await handler(new Request(`${base}/assets/styles.css`));
        expect(assetsRes.status).toBe(200);

        const missing = await handler(new Request(`${base}/missing`));
        expect(missing.status).toBe(404);

        const infoPath = path.join(pl4nDir, "server.json");
        const infoRaw = await fs.readFile(infoPath, "utf8");
        const info = JSON.parse(infoRaw) as Record<string, unknown>;
        info.last_activity = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
        await fs.writeFile(infoPath, `${JSON.stringify(info)}\n`, "utf8");

        if (!intervalCallback) {
          throw new Error("idle check not scheduled");
        }
        const idleCheck = intervalCallback as () => void | Promise<void>;
        await idleCheck();
        await serverPromise;

        expect(stopCalled).toBe(true);
        await expect(fs.readFile(infoPath, "utf8")).rejects.toBeDefined();
      } finally {
        (Bun as unknown as { serve: typeof Bun.serve }).serve = originalServe;
        globalThis.setInterval = originalSetInterval;
        globalThis.clearInterval = originalClearInterval;
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

  it("resolves pl4n dir from env and parent paths", async () => {
    await withTempDir(async (root) => {
      const originalDir = process.env.PL4N_DIR;
      const originalCwd = process.cwd();
      const envDir = path.join(root, ".pl4n-env");
      const nested = path.join(root, "nested", "child");
      await fs.mkdir(envDir, { recursive: true });
      await fs.mkdir(nested, { recursive: true });

      try {
        process.env.PL4N_DIR = envDir;
        expect(await resolvePl4nDir()).toBe(envDir);

        delete process.env.PL4N_DIR;
        const parentPl4n = path.join(root, ".pl4n");
        await fs.mkdir(parentPl4n, { recursive: true });
        process.chdir(nested);
        expect(await resolvePl4nDir()).toBe(await fs.realpath(parentPl4n));

        await fs.rm(parentPl4n, { recursive: true, force: true });
        const nestedReal = await fs.realpath(nested);
        expect(await resolvePl4nDir()).toBe(path.join(nestedReal, ".pl4n"));
      } finally {
        process.chdir(originalCwd);
        if (originalDir === undefined) {
          delete process.env.PL4N_DIR;
        } else {
          process.env.PL4N_DIR = originalDir;
        }
      }
    });
  });
});
