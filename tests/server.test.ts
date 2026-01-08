import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { Phase } from "../src/models";
import { SessionManager } from "../src/session";
import {
  ensureGlobalToken,
  generateToken,
  validateGlobalToken,
  validateSessionToken,
} from "../src/server/auth";
import {
  isDaemonRunning,
  startDaemon,
  stopDaemon,
  updateServerActivity,
} from "../src/server/daemon";
import { createHandlers } from "../src/server/handlers";
import { findAvailablePort, getLocalIP } from "../src/server/network";
import { ProjectRegistry } from "../src/server/projects";
import { createProjectId } from "../src/server/project-id";
import { createSseManager } from "../src/server/sse";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-server-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function setupProject(root: string): Promise<{
  projectRoot: string;
  pl4nDir: string;
  manager: SessionManager;
  projectId: string;
  globalDir: string;
  registry: ProjectRegistry;
}> {
  const projectRoot = path.join(root, "project-a");
  const pl4nDir = path.join(projectRoot, ".pl4n");
  const manager = new SessionManager(pl4nDir);
  const projectId = createProjectId(projectRoot);
  const globalDir = path.join(root, "global");
  const registry = new ProjectRegistry({ workspaces: [root] });
  return { projectRoot, pl4nDir, manager, projectId, globalDir, registry };
}

async function createHandlersForProject(
  root: string,
  options: {
    spawn?: (options: { cmd: string[] }) => { pid: number };
    setup?: (manager: SessionManager, projectId: string, globalDir: string) => Promise<void>;
  } = {},
): Promise<{
  manager: SessionManager;
  projectId: string;
  globalDir: string;
  registry: ProjectRegistry;
  handlers: ReturnType<typeof createHandlers>;
  sse: ReturnType<typeof createSseManager>;
}> {
  const { manager, projectId, globalDir, registry } = await setupProject(root);
  if (options.setup) {
    await options.setup(manager, projectId, globalDir);
  }
  await registry.start();
  const sse = createSseManager(registry);
  const handlers = createHandlers({
    globalDir,
    registry,
    sse,
    authMode: "strict",
    spawn: options.spawn as undefined | ((options: { cmd: string[] }) => { pid: number }),
  });
  return { manager, projectId, globalDir, registry, handlers, sse };
}

function extractListPayload(html: string): {
  project: Record<string, unknown>;
  sessions: Record<string, unknown>[];
} {
  const marker = "window.__PL4N_LIST__ = ";
  const start = html.indexOf(marker);
  if (start < 0) {
    throw new Error("missing list payload");
  }
  const payloadStart = start + marker.length;
  const end = html.indexOf(";", payloadStart);
  if (end < 0) {
    throw new Error("missing list payload terminator");
  }
  const json = html.slice(payloadStart, end).trim();
  return JSON.parse(json) as {
    project: Record<string, unknown>;
    sessions: Record<string, unknown>[];
  };
}

describe("auth", () => {
  it("generates base64url token", () => {
    const token = generateToken();
    expect(token.length).toBe(16);
    expect(token).not.toContain("+");
    expect(token).not.toContain("/");
    expect(token).not.toContain("=");
  });

  it("creates and validates global token", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      const token = await ensureGlobalToken(globalDir);
      expect(token.length).toBe(16);
      const same = await ensureGlobalToken(globalDir);
      expect(same).toBe(token);
      expect(await validateGlobalToken(token, globalDir)).toBe(true);
      expect(await validateGlobalToken("bad", globalDir)).toBe(false);
    });
  });

  it("validates session token", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".pl4n"));
      const state = await manager.createSession("Test tokens");
      const token = state.sessionToken ?? "";

      expect(await validateSessionToken(state.sessionId, token, manager)).toBe(true);
      expect(await validateSessionToken(state.sessionId, "bad", manager)).toBe(false);
    });
  });
});

describe("network", () => {
  it("returns PL4N_HOST override", () => {
    const original = process.env.PL4N_HOST;
    process.env.PL4N_HOST = "100.100.100.100";
    try {
      expect(getLocalIP()).toBe("100.100.100.100");
    } finally {
      if (original === undefined) {
        delete process.env.PL4N_HOST;
      } else {
        process.env.PL4N_HOST = original;
      }
    }
  });

  it("finds available port", async () => {
    const seen: number[] = [];
    const found = await findAvailablePort(5000, {
      isAvailable: async (port) => {
        seen.push(port);
        return port === 5002;
      },
    });
    expect(found).toBe(5002);
    expect(seen).toEqual([5000, 5001, 5002]);
  });

  it("throws when no ports are available", async () => {
    await expect(findAvailablePort(6000, { isAvailable: async () => false })).rejects.toThrow(
      "No available port found starting at 6000",
    );
  });
});

describe("daemon", () => {
  it("starts daemon with stubbed spawn", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      const spawned: string[][] = [];
      const result = await startDaemon(globalDir, {
        port: 4567,
        findPort: async (start) => start,
        now: () => new Date("2024-01-01T00:00:00Z"),
        spawn: (options) => {
          spawned.push(options.cmd);
          return { pid: 2222 };
        },
      });

      expect(result.pid).toBe(2222);
      expect(result.port).toBe(4567);
      expect(spawned.length).toBe(1);

      const infoPath = path.join(globalDir, "server.json");
      const raw = await fs.readFile(infoPath, "utf8");
      const info = JSON.parse(raw) as { pid: number; port: number; last_activity: string };
      expect(info.pid).toBe(2222);
      expect(info.port).toBe(4567);
      expect(info.last_activity).toBe("2024-01-01T00:00:00.000Z");
    });
  });

  it("updates server activity timestamp", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "server.json"),
        JSON.stringify({
          pid: 2222,
          port: 4567,
          started_at: "2024-01-01T00:00:00.000Z",
          last_activity: "2024-01-01T00:00:00.000Z",
        }),
        "utf8",
      );

      const now = new Date("2024-02-01T00:00:00Z");
      await updateServerActivity(globalDir, now);

      const raw = await fs.readFile(path.join(globalDir, "server.json"), "utf8");
      const info = JSON.parse(raw) as { last_activity: string };
      expect(info.last_activity).toBe(now.toISOString());
    });
  });

  it("detects stale daemon", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "server.json"),
        JSON.stringify({ pid: 999999, port: 9999 }),
        "utf8",
      );

      const status = await isDaemonRunning(globalDir);
      expect(status.running).toBe(false);
      await expect(fs.readFile(path.join(globalDir, "server.json"), "utf8")).rejects.toBeDefined();
    });
  });

  it("stops daemon when pid is killable", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "server.json"),
        JSON.stringify({ pid: 1234, port: 9999 }),
        "utf8",
      );

      const originalKill = process.kill;
      process.kill = ((pid: number) => {
        if (pid === 1234) {
          return true;
        }
        throw new Error("Unexpected pid");
      }) as typeof process.kill;

      try {
        const stopped = await stopDaemon(globalDir);
        expect(stopped).toBe(true);
      } finally {
        process.kill = originalKill;
      }
    });
  });

  it("returns false when daemon pid is missing", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "server.json"),
        JSON.stringify({ pid: 7777, port: 9999 }),
        "utf8",
      );

      const originalKill = process.kill;
      process.kill = ((pid: number) => {
        if (pid === 7777) {
          const error = new Error("missing pid") as NodeJS.ErrnoException;
          error.code = "ESRCH";
          throw error;
        }
        throw new Error("Unexpected pid");
      }) as typeof process.kill;

      try {
        const stopped = await stopDaemon(globalDir);
        expect(stopped).toBe(false);
        await expect(
          fs.readFile(path.join(globalDir, "server.json"), "utf8"),
        ).rejects.toBeDefined();
      } finally {
        process.kill = originalKill;
      }
    });
  });

  it("propagates daemon stop errors", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "server.json"),
        JSON.stringify({ pid: 8888, port: 9999 }),
        "utf8",
      );

      const originalKill = process.kill;
      process.kill = ((pid: number) => {
        if (pid === 8888) {
          const error = new Error("permission denied") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        }
        throw new Error("Unexpected pid");
      }) as typeof process.kill;

      try {
        await expect(stopDaemon(globalDir)).rejects.toBeDefined();
      } finally {
        process.kill = originalKill;
      }
    });
  });
});

describe("handlers", () => {
  it("serves edit template with read-only based on phase", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, manager, registry, sse } = await createHandlersForProject(root, {
        setup: async (manager) => {
          state = await manager.createSession("Edit task");
          state.phase = Phase.UserReview;
          await manager.saveState(state);
        },
      });
      const token = state.sessionToken ?? "";

      const editRes = await handlers.handleEdit(
        new Request(`http://localhost/projects/${projectId}/edit/${state.sessionId}?t=${token}`),
        projectId,
        state.sessionId,
      );
      expect(editRes.status).toBe(200);
      const editHtml = await editRes.text();
      expect(editHtml).toContain(`data-session="${state.sessionId}"`);
      expect(editHtml).toContain(`data-token="${token}"`);
      expect(editHtml).toContain(`data-phase="${Phase.UserReview}"`);
      expect(editHtml).toContain('data-read-only="false"');

      state.phase = Phase.Approved;
      await manager.saveState(state);
      const readonlyRes = await handlers.handleEdit(
        new Request(`http://localhost/projects/${projectId}/edit/${state.sessionId}?t=${token}`),
        projectId,
        state.sessionId,
      );
      expect(readonlyRes.status).toBe(200);
      const readonlyHtml = await readonlyRes.text();
      expect(readonlyHtml).toContain(`data-phase="${Phase.Approved}"`);
      expect(readonlyHtml).toContain('data-read-only="true"');

      await registry.stop();
      sse.close();
    });
  });

  it("rejects edit when token is invalid", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, registry, sse } = await createHandlersForProject(root, {
        setup: async (manager) => {
          state = await manager.createSession("Edit task");
          state.phase = Phase.UserReview;
          await manager.saveState(state);
        },
      });

      const res = await handlers.handleEdit(
        new Request(`http://localhost/projects/${projectId}/edit/${state.sessionId}?t=bad`),
        projectId,
        state.sessionId,
      );
      expect(res.status).toBe(401);
      await registry.stop();
      sse.close();
    });
  });

  it("serves content and autosaves", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      let stat!: { mtimeMs: number };
      const { handlers, projectId, registry, sse } = await createHandlersForProject(root, {
        spawn: () => ({ pid: 1 }),
        setup: async (manager) => {
          state = await manager.createSession("Plan task");
          state.phase = Phase.UserReview;
          await manager.saveState(state);

          const paths = manager.getPaths(state.sessionId);
          await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
          await fs.writeFile(paths.turnFile(state.turn), "# Plan\n", "utf8");
          const snapshotFile = paths.turnFile(state.turn).replace(/\.md$/, ".snapshot.md");
          await fs.writeFile(snapshotFile, "# Snapshot\n", "utf8");
          stat = await fs.stat(paths.turnFile(state.turn));
        },
      });

      const token = state.sessionToken ?? "";
      const contentRes = await handlers.handleGetContent(
        new Request(
          `http://localhost/api/projects/${projectId}/content/${state.sessionId}?t=${token}`,
        ),
        projectId,
        state.sessionId,
      );
      expect(contentRes.status).toBe(200);
      const content = await readJson(contentRes);
      expect(content.content).toBe("# Plan\n");
      expect(content.hasAutosave).toBe(false);
      expect(content.autosave).toBeNull();
      expect(content.snapshot).toBe("# Snapshot\n");
      expect(content.mtime).toBe(stat.mtimeMs);

      const autosaveRes = await handlers.handleAutosave(
        new Request(
          `http://localhost/api/projects/${projectId}/autosave/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "# Draft\n" }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(autosaveRes.status).toBe(200);

      const afterAutosave = await handlers.handleGetContent(
        new Request(
          `http://localhost/api/projects/${projectId}/content/${state.sessionId}?t=${token}`,
        ),
        projectId,
        state.sessionId,
      );
      const afterData = await readJson(afterAutosave);
      expect(afterData.hasAutosave).toBe(true);
      expect(afterData.autosave).toBe("# Draft\n");

      await registry.stop();
      sse.close();
    });
  });

  it("loads plan file when approved and falls back when missing", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, manager, registry, sse } = await createHandlersForProject(root, {
        setup: async (manager) => {
          state = await manager.createSession("Plan task");
          state.phase = Phase.Approved;
          await manager.saveState(state);

          const paths = manager.getPaths(state.sessionId);
          await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
          await fs.writeFile(paths.turnFile(state.turn), "Turn content\n", "utf8");
        },
      });

      const token = state.sessionToken ?? "";

      const fallbackRes = await handlers.handleGetContent(
        new Request(
          `http://localhost/api/projects/${projectId}/content/${state.sessionId}?t=${token}`,
        ),
        projectId,
        state.sessionId,
      );
      expect(fallbackRes.status).toBe(200);
      const fallbackPayload = await readJson(fallbackRes);
      expect(fallbackPayload.content).toBe("Turn content\n");
      expect(fallbackPayload.readOnly).toBe(true);

      const paths = manager.getPaths(state.sessionId);
      await fs.writeFile(path.join(paths.root, "PLAN.md"), "Plan content\n", "utf8");
      const planRes = await handlers.handleGetContent(
        new Request(
          `http://localhost/api/projects/${projectId}/content/${state.sessionId}?t=${token}`,
        ),
        projectId,
        state.sessionId,
      );
      expect(planRes.status).toBe(200);
      const planPayload = await readJson(planRes);
      expect(planPayload.content).toBe("Plan content\n");
      expect(planPayload.readOnly).toBe(true);

      await registry.stop();
      sse.close();
    });
  });

  it("returns session list without edit links when not in user review", async () => {
    await withTempDir(async (root) => {
      let review!: Awaited<ReturnType<SessionManager["createSession"]>>;
      let approved: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, globalDir, registry, sse } = await createHandlersForProject(
        root,
        {
          setup: async (manager) => {
            review = await manager.createSession("<script>alert(1)</script>");
            review.phase = Phase.UserReview;
            await manager.saveState(review);
            approved = await manager.createSession("Approved task");
            approved.phase = Phase.Approved;
            await manager.saveState(approved);
          },
        },
      );

      const token = await ensureGlobalToken(globalDir);
      const listRes = await handlers.handleProjectSessionsPage(
        new Request(`http://localhost/projects/${projectId}/sessions?t=${token}`),
        projectId,
      );
      expect(listRes.status).toBe(200);
      const html = await listRes.text();
      expect(html).toContain("\\u003cscript");

      const payload = extractListPayload(html);
      const reviewItem = payload.sessions.find((item) => item.session_id === review.sessionId) as
        | Record<string, unknown>
        | undefined;
      const approvedItem = payload.sessions.find(
        (item) => item.session_id === approved.sessionId,
      ) as Record<string, unknown> | undefined;

      expect(reviewItem?.edit_path).toBe(
        `/projects/${projectId}/edit/${review.sessionId}?t=${review.sessionToken ?? ""}`,
      );
      expect(approvedItem?.edit_path).toBeNull();

      await registry.stop();
      sse.close();
    });
  });

  it("handles save conflicts and continue", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      let stat!: { mtimeMs: number };
      let spawned = false;
      const { handlers, projectId, registry, sse } = await createHandlersForProject(root, {
        spawn: () => {
          spawned = true;
          return { pid: 1 };
        },
        setup: async (manager) => {
          state = await manager.createSession("Plan task");
          state.phase = Phase.UserReview;
          await manager.saveState(state);

          const paths = manager.getPaths(state.sessionId);
          await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
          await fs.writeFile(paths.turnFile(state.turn), "# Plan\n", "utf8");
          stat = await fs.stat(paths.turnFile(state.turn));
        },
      });

      const token = state.sessionToken ?? "";

      const staleRes = await handlers.handleSave(
        new Request(
          `http://localhost/api/projects/${projectId}/save/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "# New\n", mtime: 0 }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(staleRes.status).toBe(409);

      const saveRes = await handlers.handleSave(
        new Request(
          `http://localhost/api/projects/${projectId}/save/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "# New\n", mtime: stat.mtimeMs }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(saveRes.status).toBe(200);
      const savePayload = await readJson(saveRes);
      const saveMtime = savePayload.mtime as number;

      const contRes = await handlers.handleContinue(
        new Request(
          `http://localhost/api/projects/${projectId}/continue/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "# New\n", mtime: saveMtime }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(contRes.status).toBe(202);
      expect(spawned).toBe(true);

      await registry.stop();
      sse.close();
    });
  });

  it("rejects save and autosave when session is locked", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, registry, sse } = await createHandlersForProject(root, {
        setup: async (manager) => {
          state = await manager.createSession("Plan task");
          state.phase = Phase.Approved;
          await manager.saveState(state);
        },
      });

      const token = state.sessionToken ?? "";

      const saveRes = await handlers.handleSave(
        new Request(
          `http://localhost/api/projects/${projectId}/save/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Nope\n", mtime: 0 }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(saveRes.status).toBe(423);

      const autosaveRes = await handlers.handleAutosave(
        new Request(
          `http://localhost/api/projects/${projectId}/autosave/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Draft\n" }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(autosaveRes.status).toBe(423);

      await registry.stop();
      sse.close();
    });
  });

  it("deletes autosaves when requested", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, manager, registry, sse } = await createHandlersForProject(root, {
        setup: async (manager) => {
          state = await manager.createSession("Plan task");
          state.phase = Phase.UserReview;
          await manager.saveState(state);
        },
      });

      const token = state.sessionToken ?? "";

      const autosaveRes = await handlers.handleAutosave(
        new Request(
          `http://localhost/api/projects/${projectId}/autosave/${state.sessionId}?t=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Draft\n" }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(autosaveRes.status).toBe(200);

      const deleteRes = await handlers.handleAutosave(
        new Request(
          `http://localhost/api/projects/${projectId}/autosave/${state.sessionId}?t=${token}`,
          {
            method: "DELETE",
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(deleteRes.status).toBe(200);

      const paths = manager.getPaths(state.sessionId);
      const autosavePath = path.join(
        path.dirname(paths.turnFile(state.turn)),
        `${String(state.turn).padStart(3, "0")}-autosave.md`,
      );
      await expect(fs.access(autosavePath)).rejects.toBeDefined();

      await registry.stop();
      sse.close();
    });
  });

  it("rejects invalid payloads and tokens for status", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, registry, sse } = await createHandlersForProject(root, {
        setup: async (manager) => {
          state = await manager.createSession("Plan task");
          state.phase = Phase.UserReview;
          await manager.saveState(state);
        },
      });

      const badSave = await handlers.handleSave(
        new Request(
          `http://localhost/api/projects/${projectId}/save/${state.sessionId}?t=${state.sessionToken ?? ""}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: "Missing mtime\n" }),
          },
        ),
        projectId,
        state.sessionId,
      );
      expect(badSave.status).toBe(400);

      const statusRes = await handlers.handleStatus(
        new Request(`http://localhost/api/projects/${projectId}/status/${state.sessionId}?t=bad`),
        projectId,
        state.sessionId,
      );
      expect(statusRes.status).toBe(401);

      await registry.stop();
      sse.close();
    });
  });

  it("validates tokens and serves list", async () => {
    await withTempDir(async (root) => {
      let state!: Awaited<ReturnType<SessionManager["createSession"]>>;
      const { handlers, projectId, globalDir, registry, sse } = await createHandlersForProject(
        root,
        {
          setup: async (manager) => {
            state = await manager.createSession("Plan task");
            state.phase = Phase.UserReview;
            await manager.saveState(state);
          },
        },
      );

      const badList = await handlers.handleProjectsPage(
        new Request("http://localhost/projects?t=bad"),
      );
      expect(badList.status).toBe(401);

      const token = await ensureGlobalToken(globalDir);
      const listRes = await handlers.handleProjectSessionsPage(
        new Request(`http://localhost/projects/${projectId}/sessions?t=${token}`),
        projectId,
      );
      expect(listRes.status).toBe(200);
      const body = await listRes.text();
      expect(body).toContain(state.sessionId);

      const assetRes = await handlers.handleAssets(
        new Request("http://localhost/assets/styles.css"),
        "styles.css",
      );
      expect(assetRes.status).toBe(200);

      await registry.stop();
      sse.close();
    });
  });

  it("rejects asset traversal attempts", async () => {
    await withTempDir(async (root) => {
      const { handlers, registry, sse } = await createHandlersForProject(root);

      const res = await handlers.handleAssets(
        new Request("http://localhost/assets/../secret"),
        "../secret",
      );
      expect(res.status).toBe(404);

      await registry.stop();
      sse.close();
    });
  });

  it("builds and serves editor.js from TypeScript source", async () => {
    await withTempDir(async (root) => {
      const { handlers, registry, sse } = await createHandlersForProject(root);

      const res = await handlers.handleAssets(
        new Request("http://localhost/assets/editor.js"),
        "editor.js",
      );
      expect(res.status).toBe(200);
      const contentType = res.headers.get("Content-Type") ?? "";
      expect(contentType.startsWith("text/javascript")).toBe(true);

      const js = await res.text();
      expect(js.length).toBeGreaterThan(1000);
      expect(js).toContain("Pl4nEditor");
      expect(js).toContain("customElements.define");

      await registry.stop();
      sse.close();
    });
  });

  it("builds and serves list.js from TypeScript source", async () => {
    await withTempDir(async (root) => {
      const { handlers, registry, sse } = await createHandlersForProject(root);

      const res = await handlers.handleAssets(
        new Request("http://localhost/assets/list.js"),
        "list.js",
      );
      expect(res.status).toBe(200);
      const js = await res.text();
      expect(js).toContain("Pl4nList");

      const projectsRes = await handlers.handleAssets(
        new Request("http://localhost/assets/projects.js"),
        "projects.js",
      );
      expect(projectsRes.status).toBe(200);
      const projectsJs = await projectsRes.text();
      expect(projectsJs).toContain("Pl4nProjects");

      await registry.stop();
      sse.close();
    });
  });
});
