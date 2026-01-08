import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import type { CliDeps } from "../src/cli";
import { type Pl4nConfig } from "../src/models";
import { SessionManager } from "../src/session";
import { createProjectId } from "../src/server/project-id";

let daemonStatus: { running: boolean; port?: number; pid?: number; bind?: string } = {
  running: false,
};
let startServerCalls: Array<unknown> = [];
let clipboardWrites: string[] = [];
let runTurnHandler: (manager: SessionManager, sessionId: string) => Promise<boolean> = async () =>
  true;

const cliDeps: Partial<CliDeps> = {
  isDaemonRunning: async () => daemonStatus,
  startDaemon: async () => ({ pid: 123, port: 4567 }),
  stopDaemon: async () => true,
  startServer: async (opts) => {
    startServerCalls.push(opts ?? null);
  },
  findAvailablePort: async (start) => start,
  TurnOrchestrator: class {
    manager: SessionManager;
    constructor(manager: SessionManager, _config: Pl4nConfig) {
      this.manager = manager;
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-cli-mocked-"));
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
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Status edit url");
      await manager.saveState(state);

      daemonStatus = { running: true, port: 9000, pid: 1 };
      clipboardWrites = [];
      startServerCalls = [];
      runTurnHandler = async () => true;

      const originalHost = process.env.PL4N_HOST;
      process.env.PL4N_HOST = "127.0.0.1";

      try {
        const logs = await runCliCommandCapture([
          "node",
          "pl4n",
          "--pl4n-dir",
          pl4nDir,
          "status",
          "--session",
          state.sessionId,
        ]);

        const data = JSON.parse(logs[0]) as { edit_url?: string };
        const projectId = createProjectId(path.dirname(pl4nDir));
        const expected = `http://127.0.0.1:9000/projects/${projectId}/edit/${state.sessionId}?t=${state.sessionToken}`;
        expect(data.edit_url).toBe(expected);
        expect(clipboardWrites).toEqual([expected]);
      } finally {
        if (originalHost === undefined) {
          delete process.env.PL4N_HOST;
        } else {
          process.env.PL4N_HOST = originalHost;
        }
      }
    });
  });

  it("skips edit_url when daemon has no port", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Status missing port");
      await manager.saveState(state);

      daemonStatus = { running: true };
      clipboardWrites = [];
      startServerCalls = [];
      runTurnHandler = async () => true;

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "status",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { edit_url?: string };
      expect(data.edit_url).toBeUndefined();
      expect(clipboardWrites.length).toBe(0);
    });
  });

  it("init reports errors when a turn fails", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      runTurnHandler = async () => false;

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "init",
        "Failing task",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toBe("Turn failed");
    });
  });

  it("init reports when session disappears mid-turn", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      runTurnHandler = async (mgr, sessionId) => {
        await mgr.cleanSession(sessionId);
        return true;
      };

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "init",
        "Vanishing task",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Session disappeared");
    });
  });

  it("server start foreground uses port override", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      runTurnHandler = async () => true;

      const originalHost = process.env.PL4N_HOST;
      const originalPort = process.env.PL4N_PORT;
      process.env.PL4N_HOST = "127.0.0.1";
      process.env.PL4N_PORT = "4321";

      try {
        const logs = await runCliCommandCapture([
          "node",
          "pl4n",
          "--pl4n-dir",
          pl4nDir,
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
          delete process.env.PL4N_HOST;
        } else {
          process.env.PL4N_HOST = originalHost;
        }
        if (originalPort === undefined) {
          delete process.env.PL4N_PORT;
        } else {
          process.env.PL4N_PORT = originalPort;
        }
      }
    });
  });

  it("server start daemon uses config port when no override", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const pl4nHome = path.join(root, "pl4n-home");
      const workspace = path.join(root, "workspace");
      await fs.mkdir(pl4nHome, { recursive: true });
      await fs.writeFile(
        path.join(pl4nHome, "config.yaml"),
        `workspaces:\n  - ${workspace}\nport: 9876\n`,
        "utf8",
      );

      daemonStatus = { running: false };
      clipboardWrites = [];
      startServerCalls = [];
      runTurnHandler = async () => true;

      const originalHome = process.env.PL4N_HOME;
      const originalPort = process.env.PL4N_PORT;
      const originalWorkspace = process.env.PL4N_WORKSPACE;
      process.env.PL4N_HOME = pl4nHome;
      delete process.env.PL4N_PORT;
      delete process.env.PL4N_WORKSPACE;

      try {
        let captured: { globalDir: string; options: Record<string, unknown> } | null = null;
        const logs = await runCliCommandCapture(
          ["node", "pl4n", "--pl4n-dir", pl4nDir, "server", "start"],
          {
            ...cliDeps,
            startDaemon: async (globalDir, options) => {
              captured = { globalDir, options: options ?? {} };
              return { pid: 123, port: 9876 };
            },
          },
        );

        const data = JSON.parse(logs[0]) as { running: boolean; port?: number };
        expect(data.running).toBe(true);
        expect(data.port).toBe(9876);
        const capturedValue = requireValue<{
          globalDir: string;
          options: Record<string, unknown>;
        }>(captured, "startDaemon was not called");
        expect(capturedValue.globalDir).toBe(pl4nHome);
        expect(capturedValue.options.port).toBe(9876);
      } finally {
        if (originalHome === undefined) {
          delete process.env.PL4N_HOME;
        } else {
          process.env.PL4N_HOME = originalHome;
        }
        if (originalPort === undefined) {
          delete process.env.PL4N_PORT;
        } else {
          process.env.PL4N_PORT = originalPort;
        }
        if (originalWorkspace === undefined) {
          delete process.env.PL4N_WORKSPACE;
        } else {
          process.env.PL4N_WORKSPACE = originalWorkspace;
        }
      }
    });
  });
});
