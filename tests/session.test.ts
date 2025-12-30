import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";
import { load } from "js-yaml";

import { Phase, ThunkConfig } from "../src/models";
import { SessionManager } from "../src/session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("SessionManager", () => {
  it("creates and loads a session", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Add caching layer");

      expect(state.sessionId).toContain("-");
      expect(state.task).toBe("Add caching layer");
      expect(state.turn).toBe(1);
      expect(state.phase).toBe(Phase.Initializing);

      const loaded = await manager.loadSession(state.sessionId);
      expect(loaded?.sessionId).toBe(state.sessionId);
      expect(loaded?.task).toBe(state.task);
    });
  });

  it("stores config snapshot in meta", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const config = new ThunkConfig({
        agents: [
          {
            id: "alpha",
            type: "claude",
            model: "opus",
            claude: { allowedTools: ["Read", "Write"] },
            enabled: true,
          },
        ],
        synthesizer: {
          id: "synth",
          type: "claude",
          model: "opus",
          claude: { allowedTools: ["Read"] },
          enabled: true,
        },
        timeout: 90,
      });

      const state = await manager.createSession("Test task", config);
      const paths = manager.getPaths(state.sessionId);
      const metaContent = await fs.readFile(paths.meta, "utf8");
      const meta = load(metaContent) as { config?: Record<string, unknown> };

      expect(meta.config).toEqual({
        agents: [
          {
            id: "alpha",
            type: "claude",
            model: "opus",
            claude: { allowed_tools: ["Read", "Write"] },
            enabled: true,
          },
        ],
        synthesizer: {
          id: "synth",
          type: "claude",
          model: "opus",
          claude: { allowed_tools: ["Read"] },
          enabled: true,
        },
        timeout: 90,
      });

      const snapshot = await manager.loadConfigSnapshot(state.sessionId);
      expect(snapshot?.toConfigDict()).toEqual(meta.config);
    });
  });

  it("lists sessions", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      await manager.createSession("Task 1");
      await manager.createSession("Task 2");

      const sessions = await manager.listSessions();
      const tasks = sessions.map((session) => session.task);
      expect(tasks).toContain("Task 1");
      expect(tasks).toContain("Task 2");
    });
  });

  it("saves state changes", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      state.turn = 2;
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const loaded = await manager.loadSession(state.sessionId);
      expect(loaded?.turn).toBe(2);
      expect(loaded?.phase).toBe(Phase.UserReview);
    });
  });

  it("cleans sessions", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");

      const cleaned = await manager.cleanSession(state.sessionId);
      expect(cleaned).toBe(true);

      const loaded = await manager.loadSession(state.sessionId);
      expect(loaded).toBeNull();
    });
  });

  it("returns null for missing session", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const loaded = await manager.loadSession("missing-session");
      expect(loaded).toBeNull();
    });
  });

  it("returns false when cleaning missing session", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const cleaned = await manager.cleanSession("missing-session");
      expect(cleaned).toBe(false);
    });
  });

  it("detects unanswered questions", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      const paths = manager.getPaths(state.sessionId);

      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(
        paths.turnFile(1),
        "## Questions\n\n### Q1: What database?\n**Context:** Need to choose\n**Answer:**\n\n## Summary\nTBD\n",
        "utf8",
      );

      expect(await manager.hasQuestions(state.sessionId)).toBe(true);
    });
  });

  it("allows approval when questions answered", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      const paths = manager.getPaths(state.sessionId);

      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(
        paths.turnFile(1),
        "## Questions\n\n### Q1: What database?\n**Context:** Need to choose\n**Answer:** PostgreSQL\n\n## Summary\nUse PostgreSQL\n",
        "utf8",
      );

      expect(await manager.hasQuestions(state.sessionId)).toBe(false);
    });
  });

  it("treats next-line answers as answered", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      const paths = manager.getPaths(state.sessionId);

      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(
        paths.turnFile(1),
        "## Questions\n\n### Q1: What database?\n**Context:** Need to choose\n**Answer:**\nPostgreSQL\n\n## Summary\nUse PostgreSQL\n",
        "utf8",
      );

      expect(await manager.hasQuestions(state.sessionId)).toBe(false);
    });
  });
});
