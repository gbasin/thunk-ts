import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import type { CliDeps } from "../src/cli";
import { Phase, type ThunkConfig } from "../src/models";
import { SessionManager } from "../src/session";

let daemonStatus: { running: boolean; port?: number; pid?: number } = { running: false };
let startServerCalls: Array<unknown> = [];
let clipboardWrites: string[] = [];
let lastTimeout: number | undefined;
let runTurnHandler: (manager: SessionManager, sessionId: string) => Promise<boolean> = async () =>
  true;

function resetLastTimeout(): void {
  lastTimeout = undefined;
}

const cliDeps: Partial<CliDeps> = {
  isDaemonRunning: async () => daemonStatus,
  startDaemon: async () => ({ pid: 123, port: 4567 }),
  stopDaemon: async () => true,
  startServer: async (opts) => {
    startServerCalls.push(opts ?? null);
  },
  TurnOrchestrator: class {
    manager: SessionManager;
    constructor(manager: SessionManager, config: ThunkConfig) {
      this.manager = manager;
      lastTimeout = config.timeout;
    }
    async runTurn(sessionId: string): Promise<boolean> {
      return await runTurnHandler(this.manager, sessionId);
    }
    async getDiff(): Promise<string | null> {
      return null;
    }
  },
  writeClipboard: async (text: string) => {
    clipboardWrites.push(text);
  },
};

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-cli-mocked-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function runCliCommandCapture(
  args: string[],
  deps: Partial<CliDeps> = cliDeps,
): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };

  try {
    const { runCliCommand } = await import("../src/cli");
    await runCliCommand(args, deps);
  } finally {
    console.log = originalLog;
  }

  return logs;
}

async function runCliCommandExpectExit(
  args: string[],
  deps: Partial<CliDeps> = cliDeps,
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
    await runCliCommand(args, deps);
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

describe("CLI (mocked dependencies)", () => {
  it("attaches edit_url when daemon is running", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Status edit url");
      await manager.saveState(state);

      daemonStatus = { running: true, port: 9000, pid: 1 };
      clipboardWrites = [];
      startServerCalls = [];
      resetLastTimeout();
      runTurnHandler = async () => true;

      const originalHost = process.env.THUNK_HOST;
      process.env.THUNK_HOST = "127.0.0.1";

      try {
        const logs = await runCliCommandCapture([
          "node",
          "thunk",
          "--thunk-dir",
          thunkDir,
          "status",
          "--session",
          state.sessionId,
        ]);

        const data = JSON.parse(logs[0]) as { edit_url?: string };
        const expected = `http://127.0.0.1:9000/edit/${state.sessionId}?t=${state.sessionToken}`;
        expect(data.edit_url).toBe(expected);
        expect(clipboardWrites).toEqual([expected]);
      } finally {
        if (originalHost === undefined) {
          delete process.env.THUNK_HOST;
        } else {
          process.env.THUNK_HOST = originalHost;
        }
      }
    });
  });

  it("skips edit_url when daemon has no port", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Status missing port");
      await manager.saveState(state);

      daemonStatus = { running: true };
      clipboardWrites = [];
      startServerCalls = [];
      resetLastTimeout();
      runTurnHandler = async () => true;

      const logs = await runCliCommandCapture([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "status",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { edit_url?: string };
      expect(data.edit_url).toBeUndefined();
      expect(clipboardWrites.length).toBe(0);
    });
  });

  it("wait runs a drafting turn and respects timeout", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Drafting wait");
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      resetLastTimeout();
      runTurnHandler = async (mgr, sessionId) => {
        const updated = await mgr.loadSession(sessionId);
        if (updated) {
          updated.phase = Phase.UserReview;
          await mgr.saveState(updated);
        }
        return true;
      };

      const originalWeb = process.env.THUNK_WEB;
      process.env.THUNK_WEB = "0";

      try {
        const logs = await runCliCommandCapture([
          "node",
          "thunk",
          "--thunk-dir",
          thunkDir,
          "wait",
          "--session",
          state.sessionId,
          "--timeout",
          "120",
        ]);

        const data = JSON.parse(logs[0]) as { phase: string };
        expect(data.phase).toBe(Phase.UserReview);
        if (lastTimeout === undefined) {
          throw new Error("Expected timeout to be set");
        }
        expect(lastTimeout).toBe(120);
      } finally {
        if (originalWeb === undefined) {
          delete process.env.THUNK_WEB;
        } else {
          process.env.THUNK_WEB = originalWeb;
        }
      }
    });
  });

  it("wait reports errors when a turn fails", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Drafting fail");
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      resetLastTimeout();
      runTurnHandler = async () => false;

      const result = await runCliCommandExpectExit([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "wait",
        "--session",
        state.sessionId,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toBe("Turn failed");
    });
  });

  it("wait reports when session disappears mid-turn", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Drafting vanish");
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      resetLastTimeout();
      runTurnHandler = async (mgr, sessionId) => {
        await mgr.cleanSession(sessionId);
        return true;
      };

      const result = await runCliCommandExpectExit([
        "node",
        "thunk",
        "--thunk-dir",
        thunkDir,
        "wait",
        "--session",
        state.sessionId,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Session disappeared");
    });
  });

  it("server start foreground uses port override", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      resetLastTimeout();
      runTurnHandler = async () => true;

      const originalHost = process.env.THUNK_HOST;
      const originalPort = process.env.THUNK_PORT;
      process.env.THUNK_HOST = "127.0.0.1";
      process.env.THUNK_PORT = "4321";

      try {
        const logs = await runCliCommandCapture([
          "node",
          "thunk",
          "--thunk-dir",
          thunkDir,
          "server",
          "start",
          "--foreground",
        ]);

        const data = JSON.parse(logs[0]) as { foreground: boolean; port: number; url: string };
        expect(data.foreground).toBe(true);
        expect(data.port).toBe(4321);
        expect(data.url).toContain("4321");
        expect(startServerCalls.length).toBe(1);
      } finally {
        if (originalHost === undefined) {
          delete process.env.THUNK_HOST;
        } else {
          process.env.THUNK_HOST = originalHost;
        }
        if (originalPort === undefined) {
          delete process.env.THUNK_PORT;
        } else {
          process.env.THUNK_PORT = originalPort;
        }
      }
    });
  });
});
