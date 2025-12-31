import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it, mock } from "bun:test";

import { Phase } from "../src/models";
import { SessionManager } from "../src/session";

const decoder = new TextDecoder();

function runCli(args: string[], cwd: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/index.ts", ...args],
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode ?? 0,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-cli-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeExecutable(filePath: string, content: string) {
  await fs.writeFile(filePath, content, "utf8");
  await fs.chmod(filePath, 0o755);
}

async function withPatchedPath(binDir: string, fn: () => Promise<void>) {
  const originalPath = process.env.PATH || "";
  const bunDir = path.dirname(process.execPath);
  process.env.PATH = `${binDir}${path.delimiter}${bunDir}${path.delimiter}${originalPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

describe("CLI", () => {
  it("init creates a session", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(["--thunk-dir", thunkDir, "init", "Add caching"], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();
      expect(data.turn).toBe(1);
    });
  });

  it("init supports --thunk-dir=... form", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-inline");

      const result = runCli([`--thunk-dir=${thunkDir}`, "init", "Inline path"], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();

      const manager = new SessionManager(thunkDir);
      const state = await manager.loadSession(data.session_id);
      expect(state?.task).toBe("Inline path");
    });
  });

  it("list returns sessions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      runCli(["--thunk-dir", thunkDir, "init", "Feature 1"], repoRoot);
      runCli(["--thunk-dir", thunkDir, "init", "Feature 2"], repoRoot);

      const result = runCli(["--thunk-dir", thunkDir, "list"], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.sessions.length).toBe(2);
    });
  });

  it("status returns session data", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--thunk-dir", thunkDir, "status", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBe(sessionId);
      expect(data.turn).toBe(1);
    });
  });

  it("status errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(["--thunk-dir", thunkDir, "status"], repoRoot);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Missing --session");
    });
  });

  it("status errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(
        ["--thunk-dir", thunkDir, "status", "--session", "missing-session"],
        repoRoot,
      );
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("missing-session");
    });
  });

  it("status includes agent errors when present", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Test feature");
      state.agentErrors = { codex: "error: draft failed" };
      await manager.saveState(state);

      const result = runCli(
        ["--thunk-dir", thunkDir, "status", "--session", state.sessionId],
        repoRoot,
      );
      const data = JSON.parse(result.stdout);
      expect(data.agent_errors).toEqual({ codex: "error: draft failed" });
    });
  });

  it("clean removes sessions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--thunk-dir", thunkDir, "clean", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.cleaned).toBe(true);

      const status = runCli(["--thunk-dir", thunkDir, "status", "--session", sessionId], repoRoot);
      expect(status.exitCode).toBe(1);
    });
  });

  it("pretty output uses indentation", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(
        ["--thunk-dir", thunkDir, "--pretty", "init", "Test feature"],
        repoRoot,
      );

      expect(result.stdout).toContain("\n");
      expect(result.stdout).toContain("  ");
    });
  });

  it("approve and continue require user_review", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const approve = runCli(
        ["--thunk-dir", thunkDir, "approve", "--session", sessionId],
        repoRoot,
      );
      expect(approve.exitCode).toBe(1);

      const cont = runCli(["--thunk-dir", thunkDir, "continue", "--session", sessionId], repoRoot);
      expect(cont.exitCode).toBe(1);
    });
  });

  it("continue advances turn from user_review", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Continue test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const result = runCli(
        ["--thunk-dir", thunkDir, "continue", "--session", state.sessionId],
        repoRoot,
      );

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.turn).toBe(2);
      expect(data.phase).toBe(Phase.Drafting);

      const updated = await manager.loadSession(state.sessionId);
      expect(updated?.turn).toBe(2);
      expect(updated?.phase).toBe(Phase.Drafting);
    });
  });

  it("wait returns user_review details", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Test feature");
      state.phase = Phase.UserReview;
      state.agentErrors = { codex: "error: draft failed" };
      await manager.saveState(state);

      const result = runCli(
        ["--thunk-dir", thunkDir, "wait", "--session", state.sessionId],
        repoRoot,
      );
      const data = JSON.parse(result.stdout);
      expect(data.phase).toBe(Phase.UserReview);
      expect(data.file).toBe(manager.getPaths(state.sessionId).turnFile(state.turn));
      expect(data.agent_errors).toEqual({ codex: "error: draft failed" });
    });
  });

  it("wait returns approved details", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Test feature");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      const result = runCli(
        ["--thunk-dir", thunkDir, "wait", "--session", state.sessionId],
        repoRoot,
      );
      const data = JSON.parse(result.stdout);
      expect(data.phase).toBe(Phase.Approved);
      expect(data.file).toBe(path.join(manager.getPaths(state.sessionId).root, "PLAN.md"));
    });
  });

  it("wait runs a drafting turn", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
const payload = JSON.stringify({ session_id: "sess-1", result: "# Plan from Claude" });
process.stdout.write(payload);
`,
      );

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
process.stderr.write("error: codex failed");
process.exit(1);
`,
      );

      await withPatchedPath(binDir, async () => {
        const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
        const sessionId = JSON.parse(init.stdout).session_id as string;

        const result = runCli(["--thunk-dir", thunkDir, "wait", "--session", sessionId], repoRoot);
        const data = JSON.parse(result.stdout);

        expect(data.phase).toBe(Phase.UserReview);
        expect(data.agent_errors).toEqual({ codex: "error: codex failed" });
        expect(await fs.readFile(data.file, "utf8")).toContain("# Plan");
      });
    });
  });

  it("wait emits edit_url when web enabled", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Web test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      mock.module("../src/server/daemon", () => ({
        isDaemonRunning: mock(async () => ({ running: false })),
        startDaemon: mock(async () => ({ pid: 123, port: 4567 })),
        stopDaemon: mock(async () => true),
      }));
      mock.module("clipboardy", () => ({
        default: {
          write: mock(() => {
            throw new Error("clipboard failed");
          }),
        },
      }));

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalEnv = process.env.THUNK_HOST;
      process.env.THUNK_HOST = "127.0.0.1";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand([
          "node",
          "thunk",
          "--thunk-dir",
          thunkDir,
          "wait",
          "--session",
          state.sessionId,
        ]);
      } finally {
        console.log = originalLog;
        if (originalEnv === undefined) {
          delete process.env.THUNK_HOST;
        } else {
          process.env.THUNK_HOST = originalEnv;
        }
        mock.restore();
      }

      const output = JSON.parse(logs[0]);
      expect(output.edit_url).toBe(
        `http://127.0.0.1:4567/edit/${state.sessionId}?t=${state.sessionToken}`,
      );
    });
  });

  it("wait skips edit_url when THUNK_WEB=0", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Web test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalWeb = process.env.THUNK_WEB;
      process.env.THUNK_WEB = "0";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand([
          "node",
          "thunk",
          "--thunk-dir",
          thunkDir,
          "wait",
          "--session",
          state.sessionId,
        ]);
      } finally {
        console.log = originalLog;
        if (originalWeb === undefined) {
          delete process.env.THUNK_WEB;
        } else {
          process.env.THUNK_WEB = originalWeb;
        }
      }

      const output = JSON.parse(logs[0]);
      expect(output.edit_url).toBeUndefined();
    });
  });

  it("wait reports web_error when daemon fails", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Web error");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      mock.module("../src/server/daemon", () => ({
        isDaemonRunning: mock(async () => {
          throw new Error("daemon down");
        }),
        startDaemon: mock(async () => ({ pid: 1, port: 2222 })),
        stopDaemon: mock(async () => true),
      }));

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand([
          "node",
          "thunk",
          "--thunk-dir",
          thunkDir,
          "wait",
          "--session",
          state.sessionId,
        ]);
      } finally {
        console.log = originalLog;
        mock.restore();
      }

      const output = JSON.parse(logs[0]);
      expect(output.web_error).toContain("daemon down");
    });
  });

  it("server status reports running", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");

      mock.module("../src/server/daemon", () => ({
        isDaemonRunning: mock(async () => ({ running: true, port: 5555, pid: 999 })),
        startDaemon: mock(async () => ({ pid: 999, port: 5555 })),
        stopDaemon: mock(async () => true),
      }));

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalHost = process.env.THUNK_HOST;
      process.env.THUNK_HOST = "127.0.0.1";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(["node", "thunk", "--thunk-dir", thunkDir, "server", "status"]);
      } finally {
        console.log = originalLog;
        if (originalHost === undefined) {
          delete process.env.THUNK_HOST;
        } else {
          process.env.THUNK_HOST = originalHost;
        }
        mock.restore();
      }

      const output = JSON.parse(logs[0]);
      expect(output.running).toBe(true);
      expect(output.port).toBe(5555);
      expect(output.pid).toBe(999);
    });
  });

  it("server status reports not running", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(["--thunk-dir", thunkDir, "server", "status"], repoRoot);
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.running).toBe(false);
    });
  });

  it("server stop errors when not running", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(["--thunk-dir", thunkDir, "server", "stop"], repoRoot);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Server not running");
    });
  });

  it("server start foreground errors when already running", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(
        path.join(thunkDir, "server.json"),
        JSON.stringify({ pid: process.pid, port: 7777 }),
        "utf8",
      );

      const result = runCli(["--thunk-dir", thunkDir, "server", "start", "--foreground"], repoRoot);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Server already running");
    });
  });

  it("server errors on unknown action", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(["--thunk-dir", thunkDir, "server", "bogus"], repoRoot);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Unknown server action");
    });
  });

  it("server start and stop use daemon helpers", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");

      mock.module("../src/server/daemon", () => ({
        isDaemonRunning: mock(async () => ({ running: false })),
        startDaemon: mock(async () => ({ pid: 321, port: 7777 })),
        stopDaemon: mock(async () => true),
      }));

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalHost = process.env.THUNK_HOST;
      process.env.THUNK_HOST = "127.0.0.1";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(["node", "thunk", "--thunk-dir", thunkDir, "server", "start"]);
        await runCliCommand(["node", "thunk", "--thunk-dir", thunkDir, "server", "stop"]);
      } finally {
        console.log = originalLog;
        if (originalHost === undefined) {
          delete process.env.THUNK_HOST;
        } else {
          process.env.THUNK_HOST = originalHost;
        }
        mock.restore();
      }

      const startOutput = JSON.parse(logs[0]);
      expect(startOutput.running).toBe(true);
      expect(startOutput.port).toBe(7777);
      expect(startOutput.pid).toBe(321);

      const stopOutput = JSON.parse(logs[1]);
      expect(stopOutput.stopped).toBe(true);
    });
  });

  it("server start respects THUNK_PORT override", async () => {
    await withTempDir(async (root) => {
      const thunkDir = path.join(root, ".thunk-test");
      let receivedOptions: Record<string, unknown> | undefined;

      mock.module("../src/server/daemon", () => ({
        isDaemonRunning: mock(async () => ({ running: false })),
        startDaemon: mock(async (_dir: string, options?: Record<string, unknown>) => {
          receivedOptions = options;
          return { pid: 111, port: (options?.port as number) ?? 0 };
        }),
        stopDaemon: mock(async () => true),
      }));

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalHost = process.env.THUNK_HOST;
      process.env.THUNK_HOST = "127.0.0.1";
      const originalPort = process.env.THUNK_PORT;
      process.env.THUNK_PORT = "7788";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(["node", "thunk", "--thunk-dir", thunkDir, "server", "start"]);
      } finally {
        console.log = originalLog;
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
        mock.restore();
      }

      expect(receivedOptions).toEqual({ port: 7788 });
      const startOutput = JSON.parse(logs[0]);
      expect(startOutput.port).toBe(7788);
    });
  });

  it("wait reports agent errors when drafting fails", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
process.stderr.write("unexpected argument: --bad-flag");
process.exit(1);
`,
      );

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
process.stderr.write("invalid option: --oops");
process.exit(1);
`,
      );

      await withPatchedPath(binDir, async () => {
        const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
        const sessionId = JSON.parse(init.stdout).session_id as string;

        const result = runCli(["--thunk-dir", thunkDir, "wait", "--session", sessionId], repoRoot);
        expect(result.exitCode).toBe(1);
        const data = JSON.parse(result.stdout);
        expect(data.error).toBe("Turn failed");
        expect(data.agent_errors).toEqual({
          opus: "unexpected argument: --bad-flag",
          codex: "invalid option: --oops",
        });
      });
    });
  });

  it("wait uses session config snapshot", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(thunkDir, { recursive: true });

      const initialConfig = [
        "agents:",
        "  - id: solo",
        "    type: claude",
        "    model: opus",
        "synthesizer:",
        "  id: synth",
        "  type: claude",
        "  model: opus",
        "",
      ].join("\n");
      await fs.writeFile(path.join(thunkDir, "thunk.yaml"), initialConfig, "utf8");

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
const payload = JSON.stringify({ session_id: "sess-1", result: "# Plan from Claude" });
process.stdout.write(payload);
`,
      );

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "# Plan from Codex" })
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      await withPatchedPath(binDir, async () => {
        const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
        const sessionId = JSON.parse(init.stdout).session_id as string;

        const updatedConfig = [
          "agents:",
          "  - id: codex",
          "    type: codex",
          "    model: codex-5.2",
          "synthesizer:",
          "  id: synth",
          "  type: claude",
          "  model: opus",
          "",
        ].join("\n");
        await fs.writeFile(path.join(thunkDir, "thunk.yaml"), updatedConfig, "utf8");

        const waitResult = runCli(
          ["--thunk-dir", thunkDir, "wait", "--session", sessionId],
          repoRoot,
        );
        expect(waitResult.exitCode).toBe(0);

        const manager = new SessionManager(thunkDir);
        const state = await manager.loadSession(sessionId);
        expect(state?.agentPlanIds).toEqual({ solo: expect.any(String) });
      });
    });
  });

  it("approve creates a plan symlink", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Test feature");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "## Summary\nAll good\n", "utf8");

      const result = runCli(
        ["--thunk-dir", thunkDir, "approve", "--session", state.sessionId],
        repoRoot,
      );

      const data = JSON.parse(result.stdout);
      expect(data.phase).toBe(Phase.Approved);

      const linkPath = data.plan_path as string;
      const stats = await fs.lstat(linkPath);
      expect(stats.isSymbolicLink()).toBe(true);
      const target = await fs.readlink(linkPath);
      expect(path.resolve(paths.root, target)).toBe(paths.turnFile(state.turn));
    });
  });

  it("approve errors with unanswered questions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Question test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(
        paths.turnFile(state.turn),
        "## Questions\n\n### Q1\n**Answer:**\n\n## Summary\nTBD\n",
        "utf8",
      );

      const result = runCli(
        ["--thunk-dir", thunkDir, "approve", "--session", state.sessionId],
        repoRoot,
      );

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Cannot approve with unanswered questions");
    });
  });

  it("diff errors when turn < 2", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--thunk-dir", thunkDir, "diff", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(data.error).toContain("Need at least 2 turns");
    });
  });

  it("diff errors when files are missing", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Test feature");
      state.turn = 2;
      await manager.saveState(state);

      const result = runCli(
        ["--thunk-dir", thunkDir, "diff", "--session", state.sessionId],
        repoRoot,
      );
      const data = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(data.error).toContain("Turn files not found");
    });
  });

  it("init reads task from --file", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");
      const taskFile = path.join(root, "task.md");

      const longTask = `# Feature Request

This is a very long task description that would be difficult to pass
as a command line argument due to shell escaping and length limits.

## Requirements
- Support large text input
- Handle special characters like "quotes" and $variables
- Preserve newlines and formatting

## Q&A
Q: Should this work with stdin?
A: Yes, use --file - for stdin
`;

      await fs.writeFile(taskFile, longTask, "utf8");

      const result = runCli(["--thunk-dir", thunkDir, "init", "--file", taskFile], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();

      const manager = new SessionManager(thunkDir);
      const state = await manager.loadSession(data.session_id);
      expect(state?.task).toContain("Feature Request");
      expect(state?.task).toContain("Q&A");
    });
  });

  it("init errors when no task and no --file", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(["--thunk-dir", thunkDir, "init"], repoRoot);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Missing task description");
    });
  });

  it("init errors when --file does not exist", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk-test");

      const result = runCli(
        ["--thunk-dir", thunkDir, "init", "--file", "/nonexistent/task.md"],
        repoRoot,
      );

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Cannot read task file");
    });
  });
});
