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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-server-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function extractListPayload(html: string): { sessions: Record<string, unknown>[] } {
  const marker = "window.__THUNK_LIST__ = ";
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
  return JSON.parse(json) as { sessions: Record<string, unknown>[] };
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
      const thunkDir = path.join(root, ".thunk");
      const token = await ensureGlobalToken(thunkDir);
      expect(token.length).toBe(16);
      const same = await ensureGlobalToken(thunkDir);
      expect(same).toBe(token);
      expect(await validateGlobalToken(token, thunkDir)).toBe(true);
      expect(await validateGlobalToken("bad", thunkDir)).toBe(false);
    });
  });

  it("validates session token", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk"));
      const state = await manager.createSession("Test tokens");
      const token = state.sessionToken ?? "";

      expect(await validateSessionToken(state.sessionId, token, manager)).toBe(true);
      expect(await validateSessionToken(state.sessionId, "bad", manager)).toBe(false);
    });
  });
});

describe("network", () => {
  it("returns THUNK_HOST override", () => {
    const original = process.env.THUNK_HOST;
    process.env.THUNK_HOST = "100.100.100.100";
    try {
      expect(getLocalIP()).toBe("100.100.100.100");
    } finally {
      if (original === undefined) {
        delete process.env.THUNK_HOST;
      } else {
        process.env.THUNK_HOST = original;
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
      const thunkDir = path.join(root, ".thunk");
      const spawned: string[][] = [];
      const result = await startDaemon(thunkDir, {
        port: 4567,
        now: () => new Date("2024-01-01T00:00:00Z"),
        spawn: (options) => {
          spawned.push(options.cmd);
          return { pid: 2222 };
        },
      });

      expect(result.pid).toBe(2222);
      expect(result.port).toBe(4567);
      expect(spawned.length).toBe(1);

      const infoPath = path.join(thunkDir, "server.json");
      const raw = await fs.readFile(infoPath, "utf8");
      const info = JSON.parse(raw) as { pid: number; port: number; last_activity: string };
      expect(info.pid).toBe(2222);
      expect(info.port).toBe(4567);
      expect(info.last_activity).toBe("2024-01-01T00:00:00.000Z");
    });
  });

  it("updates server activity timestamp", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
        JSON.stringify({
          pid: 2222,
          port: 4567,
          started_at: "2024-01-01T00:00:00.000Z",
          last_activity: "2024-01-01T00:00:00.000Z",
        }),
        "utf8",
      );

      const now = new Date("2024-02-01T00:00:00Z");
      await updateServerActivity(thunkDir, now);

      const raw = await fs.readFile(path.join(thunkDir, "server.json"), "utf8");
      const info = JSON.parse(raw) as { last_activity: string };
      expect(info.last_activity).toBe(now.toISOString());
    });
  });

  it("detects stale daemon", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
        JSON.stringify({ pid: 999999, port: 9999 }),
        "utf8",
      );

      const status = await isDaemonRunning(thunkDir);
      expect(status.running).toBe(false);
      await expect(fs.readFile(path.join(thunkDir, "server.json"), "utf8")).rejects.toBeDefined();
    });
  });

  it("stops daemon when pid is killable", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
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
        const stopped = await stopDaemon(thunkDir);
        expect(stopped).toBe(true);
      } finally {
        process.kill = originalKill;
      }
    });
  });

  it("returns false when daemon pid is missing", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
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
        const stopped = await stopDaemon(thunkDir);
        expect(stopped).toBe(false);
        await expect(fs.readFile(path.join(thunkDir, "server.json"), "utf8")).rejects.toBeDefined();
      } finally {
        process.kill = originalKill;
      }
    });
  });

  it("propagates daemon stop errors", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
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
        await expect(stopDaemon(thunkDir)).rejects.toBeDefined();
      } finally {
        process.kill = originalKill;
      }
    });
  });
});

describe("handlers", () => {
  it("serves edit template with read-only based on phase", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Edit task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const handlers = createHandlers({ thunkDir, manager });
      const token = state.sessionToken ?? "";

      const editRes = await handlers.handleEdit(
        new Request(`http://localhost/edit/${state.sessionId}?t=${token}`),
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
        new Request(`http://localhost/edit/${state.sessionId}?t=${token}`),
        state.sessionId,
      );
      expect(readonlyRes.status).toBe(200);
      const readonlyHtml = await readonlyRes.text();
      expect(readonlyHtml).toContain(`data-phase="${Phase.Approved}"`);
      expect(readonlyHtml).toContain('data-read-only="true"');
    });
  });

  it("rejects edit when token is invalid", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Edit task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const handlers = createHandlers({ thunkDir, manager });
      const res = await handlers.handleEdit(
        new Request(`http://localhost/edit/${state.sessionId}?t=bad`),
        state.sessionId,
      );
      expect(res.status).toBe(401);
    });
  });

  it("serves content and drafts", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "# Plan\n", "utf8");
      const stat = await fs.stat(paths.turnFile(state.turn));

      const token = state.sessionToken ?? "";
      const handlers = createHandlers({ thunkDir, manager, spawn: () => ({ pid: 1 }) });

      const contentRes = await handlers.handleGetContent(
        new Request(`http://localhost/api/content/${state.sessionId}?t=${token}`),
        state.sessionId,
      );
      expect(contentRes.status).toBe(200);
      const content = await readJson(contentRes);
      expect(content.content).toBe("# Plan\n");
      expect(content.hasDraft).toBe(false);
      expect(content.mtime).toBe(stat.mtimeMs);

      const draftRes = await handlers.handleDraft(
        new Request(`http://localhost/api/draft/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# Draft\n" }),
        }),
        state.sessionId,
      );
      expect(draftRes.status).toBe(200);

      const afterDraft = await handlers.handleGetContent(
        new Request(`http://localhost/api/content/${state.sessionId}?t=${token}`),
        state.sessionId,
      );
      const afterData = await readJson(afterDraft);
      expect(afterData.hasDraft).toBe(true);
      expect(afterData.draft).toBe("# Draft\n");
    });
  });

  it("loads plan file when approved and falls back when missing", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "Turn content\n", "utf8");

      const token = state.sessionToken ?? "";
      const handlers = createHandlers({ thunkDir, manager });

      const fallbackRes = await handlers.handleGetContent(
        new Request(`http://localhost/api/content/${state.sessionId}?t=${token}`),
        state.sessionId,
      );
      expect(fallbackRes.status).toBe(200);
      const fallbackPayload = await readJson(fallbackRes);
      expect(fallbackPayload.content).toBe("Turn content\n");
      expect(fallbackPayload.readOnly).toBe(true);

      await fs.writeFile(path.join(paths.root, "PLAN.md"), "Plan content\n", "utf8");
      const planRes = await handlers.handleGetContent(
        new Request(`http://localhost/api/content/${state.sessionId}?t=${token}`),
        state.sessionId,
      );
      expect(planRes.status).toBe(200);
      const planPayload = await readJson(planRes);
      expect(planPayload.content).toBe("Plan content\n");
      expect(planPayload.readOnly).toBe(true);
    });
  });

  it("returns session list without edit links when not in user review", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const review = await manager.createSession("<script>alert(1)</script>");
      review.phase = Phase.UserReview;
      await manager.saveState(review);
      const approved = await manager.createSession("Approved task");
      approved.phase = Phase.Approved;
      await manager.saveState(approved);

      const handlers = createHandlers({ thunkDir, manager });
      const token = await ensureGlobalToken(thunkDir);
      const listRes = await handlers.handleList(new Request(`http://localhost/list?t=${token}`));
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
        `/edit/${review.sessionId}?t=${review.sessionToken ?? ""}`,
      );
      expect(approvedItem?.edit_path).toBeNull();
    });
  });

  it("handles save conflicts and continue", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "# Plan\n", "utf8");
      const stat = await fs.stat(paths.turnFile(state.turn));
      const token = state.sessionToken ?? "";
      let spawned = false;

      const handlers = createHandlers({
        thunkDir,
        manager,
        spawn: () => {
          spawned = true;
          return { pid: 1 };
        },
      });

      const staleRes = await handlers.handleSave(
        new Request(`http://localhost/api/save/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# New\n", mtime: 0 }),
        }),
        state.sessionId,
      );
      expect(staleRes.status).toBe(409);

      const saveRes = await handlers.handleSave(
        new Request(`http://localhost/api/save/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# New\n", mtime: stat.mtimeMs }),
        }),
        state.sessionId,
      );
      expect(saveRes.status).toBe(200);
      const savePayload = await readJson(saveRes);
      const saveMtime = savePayload.mtime as number;

      const contRes = await handlers.handleContinue(
        new Request(`http://localhost/api/continue/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "# New\n", mtime: saveMtime }),
        }),
        state.sessionId,
      );
      expect(contRes.status).toBe(202);
      expect(spawned).toBe(true);
    });
  });

  it("rejects save and draft when session is locked", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      const handlers = createHandlers({ thunkDir, manager });
      const token = state.sessionToken ?? "";

      const saveRes = await handlers.handleSave(
        new Request(`http://localhost/api/save/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Nope\n", mtime: 0 }),
        }),
        state.sessionId,
      );
      expect(saveRes.status).toBe(423);

      const draftRes = await handlers.handleDraft(
        new Request(`http://localhost/api/draft/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Draft\n" }),
        }),
        state.sessionId,
      );
      expect(draftRes.status).toBe(423);
    });
  });

  it("deletes drafts when requested", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const handlers = createHandlers({ thunkDir, manager });
      const token = state.sessionToken ?? "";

      const draftRes = await handlers.handleDraft(
        new Request(`http://localhost/api/draft/${state.sessionId}?t=${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Draft\n" }),
        }),
        state.sessionId,
      );
      expect(draftRes.status).toBe(200);

      const deleteRes = await handlers.handleDraft(
        new Request(`http://localhost/api/draft/${state.sessionId}?t=${token}`, {
          method: "DELETE",
        }),
        state.sessionId,
      );
      expect(deleteRes.status).toBe(200);

      const paths = manager.getPaths(state.sessionId);
      const draftPath = path.join(
        path.dirname(paths.turnFile(state.turn)),
        `${String(state.turn).padStart(3, "0")}-draft.md`,
      );
      await expect(fs.access(draftPath)).rejects.toBeDefined();
    });
  });

  it("rejects invalid payloads and tokens for status", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const handlers = createHandlers({ thunkDir, manager });

      const badSave = await handlers.handleSave(
        new Request(`http://localhost/api/save/${state.sessionId}?t=${state.sessionToken ?? ""}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Missing mtime\n" }),
        }),
        state.sessionId,
      );
      expect(badSave.status).toBe(400);

      const statusRes = await handlers.handleStatus(
        new Request(`http://localhost/api/status/${state.sessionId}?t=bad`),
        state.sessionId,
      );
      expect(statusRes.status).toBe(401);
    });
  });

  it("validates tokens and serves list", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const handlers = createHandlers({ thunkDir, manager });

      const badList = await handlers.handleList(new Request("http://localhost/list?t=bad"));
      expect(badList.status).toBe(401);

      const token = await ensureGlobalToken(thunkDir);
      const listRes = await handlers.handleList(new Request(`http://localhost/list?t=${token}`));
      expect(listRes.status).toBe(200);
      const body = await listRes.text();
      expect(body).toContain(state.sessionId);

      const assetRes = await handlers.handleAssets(
        new Request("http://localhost/assets/styles.css"),
        "styles.css",
      );
      expect(assetRes.status).toBe(200);
    });
  });

  it("rejects asset traversal attempts", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const handlers = createHandlers({ thunkDir, manager });

      const res = await handlers.handleAssets(
        new Request("http://localhost/assets/../secret"),
        "../secret",
      );
      expect(res.status).toBe(404);
    });
  });

  it("idles when inactive and no user review", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Plan task");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
        JSON.stringify({
          last_activity: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
        }),
        "utf8",
      );

      const handlers = createHandlers({ thunkDir, manager });
      const shouldIdle = await handlers.handleIdleCheck();
      expect(shouldIdle).toBe(true);
    });
  });
});
