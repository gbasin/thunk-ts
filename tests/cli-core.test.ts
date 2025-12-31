import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { Phase } from "../src/models";
import { SessionManager } from "../src/session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-cli-core-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function runCliCommandCapture(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };

  try {
    const { runCliCommand } = await import("../src/cli");
    await runCliCommand(args);
  } finally {
    console.log = originalLog;
  }

  return logs;
}

async function runCliCommandExpectExit(
  args: string[],
): Promise<{ exitCode: number; output: string }> {
  const logs: string[] = [];
  const originalLog = console.log;
  const originalExit = process.exit;
  const exitError = new Error("process.exit");
  let exitCode = 0;

  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  process.exit = ((code?: number) => {
    exitCode = code ?? 0;
    throw exitError;
  }) as typeof process.exit;

  try {
    const { runCliCommand } = await import("../src/cli");
    await runCliCommand(args);
  } catch (error) {
    if (error !== exitError) {
      throw error;
    }
  } finally {
    console.log = originalLog;
    process.exit = originalExit;
  }

  return { exitCode, output: logs.join("\n") };
}

describe("CLI (runCliCommand)", () => {
  it("init creates a session", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "init",
        "CLI init",
      ]);

      const data = JSON.parse(logs[0]) as { session_id: string; turn: number; phase: string };
      expect(data.session_id).toBeDefined();
      expect(data.turn).toBe(1);
      expect(data.phase).toBe(Phase.Drafting);

      const manager = new SessionManager(thunkDir);
      const state = await manager.loadSession(data.session_id);
      expect(state?.task).toBe("CLI init");
    });
  });

  it("list honors global options and pretty output", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      await manager.createSession("Task one");
      await manager.createSession("Task two");

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        `--thunk-dir=${thunkDir}`,
        "--pretty",
        "list",
      ]);

      expect(logs[0]).toContain("\n");
      const data = JSON.parse(logs[0]) as { sessions: unknown[] };
      expect(data.sessions.length).toBe(2);
    });
  });

  it("status reports missing turn file as null", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Status check");

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "status",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { file: string | null; session_id: string };
      expect(data.session_id).toBe(state.sessionId);
      expect(data.file).toBeNull();
    });
  });

  it("approve creates a plan symlink", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Approve test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "## Summary\nOk\n", "utf8");
      await fs.writeFile(path.join(paths.root, "PLAN.md"), "Old plan\n", "utf8");

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "approve",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { phase: string; plan_path: string };
      expect(data.phase).toBe(Phase.Approved);
      const stats = await fs.lstat(data.plan_path);
      expect(stats.isSymbolicLink()).toBe(true);
      const target = await fs.readlink(data.plan_path);
      expect(path.resolve(paths.root, target)).toBe(paths.turnFile(state.turn));
    });
  });

  it("clean removes a session", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Clean test");

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "clean",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { cleaned: boolean };
      expect(data.cleaned).toBe(true);
      expect(await manager.loadSession(state.sessionId)).toBeNull();
    });
  });

  it("diff returns unified diff when files exist", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Diff test");
      state.turn = 2;
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(paths.turnFile(1), "Line one\n", "utf8");
      await fs.writeFile(paths.turnFile(2), "Line two\n", "utf8");

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "diff",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { from_turn: number; to_turn: number; diff: string };
      expect(data.from_turn).toBe(1);
      expect(data.to_turn).toBe(2);
      expect(data.diff).toContain("-Line one");
      expect(data.diff).toContain("+Line two");
    });
  });

  it("status exits with error when missing --session", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");

      const result = await runCliCommandExpectExit([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "status",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });
});
