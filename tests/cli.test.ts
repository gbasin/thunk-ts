import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import type { CliDeps } from "../src/cli";
import { Phase } from "../src/models";
import { SessionManager } from "../src/session";
import { createProjectId } from "../src/server/project-id";

const decoder = new TextDecoder();
const DEFAULT_CLAUDE_STUB = [
  "#!/usr/bin/env sh",
  'printf \'%s\' \'{"session_id":"stub-claude","result":"# Stub Plan"}\'',
  "",
].join("\n");
const DEFAULT_CODEX_STUB = [
  "#!/usr/bin/env sh",
  'printf \'%s\\n\' \'{"type":"item.message","role":"assistant","content":"# Stub Codex"}\'',
  "",
].join("\n");

let originalPath: string | undefined;
let stubRoot: string | null = null;

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-cli-"));
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

beforeAll(async () => {
  originalPath = process.env.PATH;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-agent-stubs-"));
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });
  await writeExecutable(path.join(binDir, "claude"), DEFAULT_CLAUDE_STUB);
  await writeExecutable(path.join(binDir, "codex"), DEFAULT_CODEX_STUB);
  process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ""}`;
  stubRoot = root;
});

afterAll(async () => {
  if (stubRoot) {
    const binDir = path.join(stubRoot, "bin");
    const currentPath = process.env.PATH;
    if (currentPath !== undefined) {
      const nextPath = currentPath
        .split(path.delimiter)
        .filter((entry) => entry && entry !== binDir);
      if (nextPath.length === 0) {
        delete process.env.PATH;
      } else {
        process.env.PATH = nextPath.join(path.delimiter);
      }
    } else if (originalPath === undefined) {
      delete process.env.PATH;
    }
    await fs.rm(stubRoot, { recursive: true, force: true });
  }
});

describe("CLI", () => {
  it("init creates a session", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = runCli(["--pl4n-dir", pl4nDir, "init", "Add caching"], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();
      expect(data.turn).toBe(1);
    });
  });

  it("init supports --pl4n-dir=... form", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-inline");

      const result = runCli([`--pl4n-dir=${pl4nDir}`, "init", "Inline path"], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();

      const manager = new SessionManager(pl4nDir);
      const state = await manager.loadSession(data.session_id);
      expect(state?.task).toBe("Inline path");
    });
  });

  it("list returns sessions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      runCli(["--pl4n-dir", pl4nDir, "init", "Feature 1"], repoRoot);
      runCli(["--pl4n-dir", pl4nDir, "init", "Feature 2"], repoRoot);

      const result = runCli(["--pl4n-dir", pl4nDir, "list"], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.sessions.length).toBe(2);
    });
  });

  it("archive and unarchive hide sessions by default", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const init = runCli(["--pl4n-dir", pl4nDir, "init", "Feature 1"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const archiveRes = runCli(
        ["--pl4n-dir", pl4nDir, "archive", "--session", sessionId],
        repoRoot,
      );
      const archiveData = JSON.parse(archiveRes.stdout);
      expect(archiveData.archived).toBe(true);

      const listActive = runCli(["--pl4n-dir", pl4nDir, "list"], repoRoot);
      const activeData = JSON.parse(listActive.stdout);
      expect(activeData.sessions.length).toBe(0);

      const listArchived = runCli(["--pl4n-dir", pl4nDir, "list", "--archived"], repoRoot);
      const archivedData = JSON.parse(listArchived.stdout);
      expect(archivedData.sessions.length).toBe(1);

      const unarchiveRes = runCli(
        ["--pl4n-dir", pl4nDir, "unarchive", "--session", sessionId],
        repoRoot,
      );
      const unarchiveData = JSON.parse(unarchiveRes.stdout);
      expect(unarchiveData.archived).toBe(false);
    });
  });

  it("status returns session data", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const init = runCli(["--pl4n-dir", pl4nDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--pl4n-dir", pl4nDir, "status", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBe(sessionId);
      expect(data.turn).toBe(1);
    });
  });

  it("status errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = runCli(["--pl4n-dir", pl4nDir, "status"], repoRoot);
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Missing --session");
    });
  });

  it("status errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = runCli(
        ["--pl4n-dir", pl4nDir, "status", "--session", "missing-session"],
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
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Test feature");
      state.agentErrors = { codex: "error: draft failed" };
      await manager.saveState(state);

      const result = runCli(
        ["--pl4n-dir", pl4nDir, "status", "--session", state.sessionId],
        repoRoot,
      );
      const data = JSON.parse(result.stdout);
      expect(data.agent_errors).toEqual({ codex: "error: draft failed" });
    });
  });

  it("clean removes sessions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const init = runCli(["--pl4n-dir", pl4nDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--pl4n-dir", pl4nDir, "clean", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.cleaned).toBe(true);

      const status = runCli(["--pl4n-dir", pl4nDir, "status", "--session", sessionId], repoRoot);
      expect(status.exitCode).toBe(1);
    });
  });

  it("pretty output uses indentation", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = runCli(["--pl4n-dir", pl4nDir, "--pretty", "init", "Test feature"], repoRoot);

      expect(result.stdout).toContain("\n");
      expect(result.stdout).toContain("  ");
    });
  });

  it("approve and continue require user_review", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Test feature");
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      const approve = runCli(
        ["--pl4n-dir", pl4nDir, "approve", "--session", state.sessionId],
        repoRoot,
      );
      expect(approve.exitCode).toBe(1);

      const cont = runCli(
        ["--pl4n-dir", pl4nDir, "continue", "--session", state.sessionId],
        repoRoot,
      );
      expect(cont.exitCode).toBe(1);
    });
  });

  it("continue advances turn from user_review", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Continue test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const result = runCli(
        ["--pl4n-dir", pl4nDir, "continue", "--session", state.sessionId],
        repoRoot,
      );

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.turn).toBe(2);
      expect(data.phase).toBe(Phase.UserReview);

      const updated = await manager.loadSession(state.sessionId);
      expect(updated?.turn).toBe(2);
      expect(updated?.phase).toBe(Phase.UserReview);
    });
  });

  it("init runs a drafting turn", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
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
        const result = runCli(["--pl4n-dir", pl4nDir, "init", "Test feature"], repoRoot);
        const data = JSON.parse(result.stdout);

        expect(data.phase).toBe(Phase.UserReview);
        expect(data.agent_errors).toEqual({ codex: "error: codex failed" });
        expect(await fs.readFile(data.file, "utf8")).toContain("# Plan");
      });
    });
  });

  it("status emits edit_url when web enabled", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Web test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const deps: Partial<CliDeps> = {
        isDaemonRunning: async () => ({ running: false }),
        startDaemon: async () => ({ pid: 123, port: 4567 }),
        stopDaemon: async () => true,
        writeClipboard: async () => {
          throw new Error("clipboard failed");
        },
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalEnv = process.env.PL4N_HOST;
      process.env.PL4N_HOST = "127.0.0.1";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(
          ["node", "pl4n", "--pl4n-dir", pl4nDir, "status", "--session", state.sessionId],
          deps,
        );
      } finally {
        console.log = originalLog;
        if (originalEnv === undefined) {
          delete process.env.PL4N_HOST;
        } else {
          process.env.PL4N_HOST = originalEnv;
        }
      }

      const output = JSON.parse(logs[0]);
      const projectId = createProjectId(path.dirname(pl4nDir));
      expect(output.edit_url).toBe(
        `http://127.0.0.1:4567/projects/${projectId}/edit/${state.sessionId}?t=${state.sessionToken}`,
      );
    });
  });

  it("status skips edit_url when PL4N_WEB=0", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Web test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalWeb = process.env.PL4N_WEB;
      process.env.PL4N_WEB = "0";

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand([
          "node",
          "pl4n",
          "--pl4n-dir",
          pl4nDir,
          "status",
          "--session",
          state.sessionId,
        ]);
      } finally {
        console.log = originalLog;
        if (originalWeb === undefined) {
          delete process.env.PL4N_WEB;
        } else {
          process.env.PL4N_WEB = originalWeb;
        }
      }

      const output = JSON.parse(logs[0]);
      expect(output.edit_url).toBeUndefined();
    });
  });

  it("status reports web_error when daemon fails", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Web error");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const deps: Partial<CliDeps> = {
        isDaemonRunning: async () => {
          throw new Error("daemon down");
        },
        startDaemon: async () => ({ pid: 1, port: 2222 }),
        stopDaemon: async () => true,
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(
          ["node", "pl4n", "--pl4n-dir", pl4nDir, "status", "--session", state.sessionId],
          deps,
        );
      } finally {
        console.log = originalLog;
      }

      const output = JSON.parse(logs[0]);
      expect(output.web_error).toContain("daemon down");
    });
  });

  it("server status reports running", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const deps: Partial<CliDeps> = {
        isDaemonRunning: async () => ({ running: true, port: 5555, pid: 999 }),
        startDaemon: async () => ({ pid: 999, port: 5555 }),
        stopDaemon: async () => true,
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalHost = process.env.PL4N_HOST;
      process.env.PL4N_HOST = "127.0.0.1";
      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = path.join(root, "global");

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(["node", "pl4n", "--pl4n-dir", pl4nDir, "server", "status"], deps);
      } finally {
        console.log = originalLog;
        if (originalHost === undefined) {
          delete process.env.PL4N_HOST;
        } else {
          process.env.PL4N_HOST = originalHost;
        }
        if (originalHome === undefined) {
          delete process.env.PL4N_HOME;
        } else {
          process.env.PL4N_HOME = originalHome;
        }
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
      const pl4nDir = path.join(root, ".pl4n-test");

      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = path.join(root, "global");
      const result = runCli(["--pl4n-dir", pl4nDir, "server", "status"], repoRoot);
      if (originalHome === undefined) {
        delete process.env.PL4N_HOME;
      } else {
        process.env.PL4N_HOME = originalHome;
      }
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.running).toBe(false);
    });
  });

  it("server stop errors when not running", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = path.join(root, "global");
      const result = runCli(["--pl4n-dir", pl4nDir, "server", "stop"], repoRoot);
      if (originalHome === undefined) {
        delete process.env.PL4N_HOME;
      } else {
        process.env.PL4N_HOME = originalHome;
      }
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Server not running");
    });
  });

  it("server start foreground errors when already running", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "server.json"),
        JSON.stringify({ pid: process.pid, port: 7777 }),
        "utf8",
      );

      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = globalDir;
      const result = runCli(["--pl4n-dir", pl4nDir, "server", "start", "--foreground"], repoRoot);
      if (originalHome === undefined) {
        delete process.env.PL4N_HOME;
      } else {
        process.env.PL4N_HOME = originalHome;
      }
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Server already running");
    });
  });

  it("server errors on unknown action", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = path.join(root, "global");
      const result = runCli(["--pl4n-dir", pl4nDir, "server", "bogus"], repoRoot);
      if (originalHome === undefined) {
        delete process.env.PL4N_HOME;
      } else {
        process.env.PL4N_HOME = originalHome;
      }
      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Unknown server action");
    });
  });

  it("server start and stop use daemon helpers", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const deps: Partial<CliDeps> = {
        isDaemonRunning: async () => ({ running: false }),
        startDaemon: async () => ({ pid: 321, port: 7777 }),
        stopDaemon: async () => true,
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalHost = process.env.PL4N_HOST;
      process.env.PL4N_HOST = "127.0.0.1";
      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = path.join(root, "global");
      const originalWorkspace = process.env.PL4N_WORKSPACE;
      process.env.PL4N_WORKSPACE = root;

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(["node", "pl4n", "--pl4n-dir", pl4nDir, "server", "start"], deps);
        await runCliCommand(["node", "pl4n", "--pl4n-dir", pl4nDir, "server", "stop"], deps);
      } finally {
        console.log = originalLog;
        if (originalHost === undefined) {
          delete process.env.PL4N_HOST;
        } else {
          process.env.PL4N_HOST = originalHost;
        }
        if (originalHome === undefined) {
          delete process.env.PL4N_HOME;
        } else {
          process.env.PL4N_HOME = originalHome;
        }
        if (originalWorkspace === undefined) {
          delete process.env.PL4N_WORKSPACE;
        } else {
          process.env.PL4N_WORKSPACE = originalWorkspace;
        }
      }

      const startOutput = JSON.parse(logs[0]);
      expect(startOutput.running).toBe(true);
      expect(startOutput.port).toBe(7777);
      expect(startOutput.pid).toBe(321);

      const stopOutput = JSON.parse(logs[1]);
      expect(stopOutput.stopped).toBe(true);
    });
  });

  it("server start respects PL4N_PORT override", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      let receivedOptions: Record<string, unknown> | undefined;

      const deps: Partial<CliDeps> = {
        isDaemonRunning: async () => ({ running: false }),
        startDaemon: async (_dir: string, options?: Record<string, unknown>) => {
          receivedOptions = options;
          return { pid: 111, port: (options?.port as number) ?? 0 };
        },
        stopDaemon: async () => true,
      };

      const logs: string[] = [];
      const originalLog = console.log;
      console.log = (message?: unknown) => {
        logs.push(String(message ?? ""));
      };

      const originalHost = process.env.PL4N_HOST;
      process.env.PL4N_HOST = "127.0.0.1";
      const originalPort = process.env.PL4N_PORT;
      process.env.PL4N_PORT = "7788";
      const originalHome = process.env.PL4N_HOME;
      process.env.PL4N_HOME = path.join(root, "global");
      const originalWorkspace = process.env.PL4N_WORKSPACE;
      process.env.PL4N_WORKSPACE = root;

      try {
        const { runCliCommand } = await import("../src/cli");
        await runCliCommand(["node", "pl4n", "--pl4n-dir", pl4nDir, "server", "start"], deps);
      } finally {
        console.log = originalLog;
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
        if (originalHome === undefined) {
          delete process.env.PL4N_HOME;
        } else {
          process.env.PL4N_HOME = originalHome;
        }
        if (originalWorkspace === undefined) {
          delete process.env.PL4N_WORKSPACE;
        } else {
          process.env.PL4N_WORKSPACE = originalWorkspace;
        }
      }

      expect(receivedOptions).toEqual({ bind: "0.0.0.0", workspace: root, port: 7788 });
      const startOutput = JSON.parse(logs[0]);
      expect(startOutput.port).toBe(7788);
    });
  });

  it("init reports agent errors when drafting fails", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
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
        const result = runCli(["--pl4n-dir", pl4nDir, "init", "Test feature"], repoRoot);
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

  it("init uses session config snapshot", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });
      await fs.mkdir(pl4nDir, { recursive: true });

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
      await fs.writeFile(path.join(pl4nDir, "pl4n.yaml"), initialConfig, "utf8");

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
        const initResult = runCli(["--pl4n-dir", pl4nDir, "init", "Test feature"], repoRoot);
        expect(initResult.exitCode).toBe(0);
        const sessionId = JSON.parse(initResult.stdout).session_id as string;

        const manager = new SessionManager(pl4nDir);
        const state = await manager.loadSession(sessionId);
        expect(state?.agentPlanIds).toEqual({ solo: expect.any(String) });
      });
    });
  });

  it("approve creates a plan symlink", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Test feature");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "## Summary\nAll good\n", "utf8");

      const result = runCli(
        ["--pl4n-dir", pl4nDir, "approve", "--session", state.sessionId],
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
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
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
        ["--pl4n-dir", pl4nDir, "approve", "--session", state.sessionId],
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
      const pl4nDir = path.join(root, ".pl4n-test");

      const init = runCli(["--pl4n-dir", pl4nDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--pl4n-dir", pl4nDir, "diff", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(result.exitCode).toBe(1);
      expect(data.error).toContain("Need at least 2 turns");
    });
  });

  it("diff errors when files are missing", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Test feature");
      state.turn = 2;
      await manager.saveState(state);

      const result = runCli(
        ["--pl4n-dir", pl4nDir, "diff", "--session", state.sessionId],
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
      const pl4nDir = path.join(root, ".pl4n-test");
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

      const result = runCli(["--pl4n-dir", pl4nDir, "init", "--file", taskFile], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();

      const manager = new SessionManager(pl4nDir);
      const state = await manager.loadSession(data.session_id);
      expect(state?.task).toContain("Feature Request");
      expect(state?.task).toContain("Q&A");
    });
  });

  it("init errors when no task and no --file", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = runCli(["--pl4n-dir", pl4nDir, "init"], repoRoot);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Missing task description");
    });
  });

  it("init errors when --file does not exist", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = runCli(
        ["--pl4n-dir", pl4nDir, "init", "--file", "/nonexistent/task.md"],
        repoRoot,
      );

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.stdout);
      expect(data.error).toContain("Cannot read task file");
    });
  });
});
