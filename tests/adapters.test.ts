import { promises as fs } from "fs";
import fsSync from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { AgentAdapter, AgentHandle } from "../src/adapters/base";
import { ClaudeCodeAdapter, ClaudeCodeSyncAdapter } from "../src/adapters/claude";
import { CodexCLIAdapter, CodexCLISyncAdapter } from "../src/adapters/codex";
import { AgentStatus } from "../src/models";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-adapter-"));
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

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

type SpawnParams = {
  worktree: string;
  prompt: string;
  outputFile: string;
  logFile: string;
  sessionFile?: string;
};

class InlineAdapter extends AgentAdapter {
  private spawnFn: (params: SpawnParams) => AgentHandle;

  constructor(spawnFn: (params: SpawnParams) => AgentHandle) {
    super({ id: "inline", type: "test", model: "test" });
    this.spawnFn = spawnFn;
  }

  spawn(params: SpawnParams): AgentHandle {
    return this.spawnFn(params);
  }

  getName(): string {
    return "Inline Adapter";
  }
}

function createResolvedProcess(exitCode = 0): Bun.Subprocess {
  return {
    exited: Promise.resolve(exitCode),
    exitCode,
    kill: () => {},
  } as unknown as Bun.Subprocess;
}

function createPendingProcess(onKill: () => void): Bun.Subprocess {
  return {
    exited: new Promise(() => {}),
    exitCode: null,
    kill: onKill,
  } as unknown as Bun.Subprocess;
}

describe("Adapters", () => {
  it("AgentHandle reports status from exit code", () => {
    const running = new AgentHandle(
      "agent",
      { exitCode: null } as unknown as Bun.Subprocess,
      "log",
    );
    expect(running.isRunning()).toBe(true);
    expect(running.getStatus()).toBe(AgentStatus.Working);

    const done = new AgentHandle("agent", { exitCode: 0 } as unknown as Bun.Subprocess, "log");
    expect(done.isRunning()).toBe(false);
    expect(done.getStatus()).toBe(AgentStatus.Done);

    const errored = new AgentHandle("agent", { exitCode: 1 } as unknown as Bun.Subprocess, "log");
    expect(errored.isRunning()).toBe(false);
    expect(errored.getStatus()).toBe(AgentStatus.Error);
  });

  it("AgentAdapter runSync returns output from file", async () => {
    await withTempDir(async (root) => {
      const adapter = new InlineAdapter((params) => {
        fsSync.writeFileSync(params.outputFile, "hello", "utf8");
        return new AgentHandle("inline", createResolvedProcess(0), params.logFile);
      });
      const outputFile = path.join(root, "output.txt");
      const logFile = path.join(root, "log.txt");

      const [success, output] = await adapter.runSync({
        worktree: root,
        prompt: "test",
        outputFile,
        logFile,
      });

      expect(success).toBe(true);
      expect(output).toBe("hello");
    });
  });

  it("AgentAdapter runSync reports missing output", async () => {
    await withTempDir(async (root) => {
      const adapter = new InlineAdapter(
        (params) => new AgentHandle("inline", createResolvedProcess(0), params.logFile),
      );
      const outputFile = path.join(root, "missing.txt");
      const logFile = path.join(root, "log.txt");

      const [success, output] = await adapter.runSync({
        worktree: root,
        prompt: "test",
        outputFile,
        logFile,
      });

      expect(success).toBe(false);
      expect(output).toBe("No output produced");
    });
  });

  it("AgentAdapter runSync times out and kills process", async () => {
    await withTempDir(async (root) => {
      let killed = false;
      const adapter = new InlineAdapter((params) => {
        const proc = createPendingProcess(() => {
          killed = true;
        });
        return new AgentHandle("inline", proc, params.logFile);
      });
      const outputFile = path.join(root, "timeout.txt");
      const logFile = path.join(root, "log.txt");

      const [success, output] = await adapter.runSync({
        worktree: root,
        prompt: "test",
        outputFile,
        logFile,
        timeout: 0.01,
      });

      expect(success).toBe(false);
      expect(output).toBe("Timeout expired");
      expect(killed).toBe(true);
    });
  });

  it("Claude adapter prepends thinking keyword to prompt", async () => {
    await withTempDir(async (root) => {
      const logFile = path.join(root, "claude.log");
      const outputFile = path.join(root, "output.md");

      const adapter = new ClaudeCodeAdapter({
        id: "claude",
        type: "claude",
        model: "opus",
        thinking: "ultrathink",
      });

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const prompts: string[] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        const pIdx = options.cmd.indexOf("-p");
        if (pIdx !== -1) {
          prompts.push(options.cmd[pIdx + 1]);
        }
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "create a plan", outputFile, logFile });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(prompts.length).toBe(1);
      expect(prompts[0]).toStartWith("ultrathink\n\n");
      expect(prompts[0]).toContain("create a plan");
    });
  });

  it("Claude adapter does not modify prompt when thinking is not set", async () => {
    await withTempDir(async (root) => {
      const logFile = path.join(root, "claude.log");
      const outputFile = path.join(root, "output.md");

      const adapter = new ClaudeCodeAdapter({
        id: "claude",
        type: "claude",
        model: "opus",
      });

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const prompts: string[] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        const pIdx = options.cmd.indexOf("-p");
        if (pIdx !== -1) {
          prompts.push(options.cmd[pIdx + 1]);
        }
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "create a plan", outputFile, logFile });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(prompts.length).toBe(1);
      expect(prompts[0]).toBe("create a plan");
    });
  });

  it("Claude adapters build commands and handle empty streams", async () => {
    await withTempDir(async (root) => {
      const sessionFile = path.join(root, "claude-session.txt");
      await fs.writeFile(sessionFile, "sess-123", "utf8");

      const logFile = path.join(root, "claude.log");
      const logFileSync = path.join(root, "claude-sync.log");
      const outputFile = path.join(root, "output.md");
      const outputFileSync = path.join(root, "output-sync.md");

      const adapter = new ClaudeCodeAdapter({
        id: "claude",
        type: "claude",
        model: "sonnet",
        claude: { allowedTools: ["Read"] },
      });
      const syncAdapter = new ClaudeCodeSyncAdapter({
        id: "claude-sync",
        type: "claude",
        model: "sonnet",
        claude: { allowedTools: ["Read"] },
      });

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const commands: string[][] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        commands.push(options.cmd);
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile, sessionFile });
        syncAdapter.spawn({
          worktree: root,
          prompt: "hello",
          outputFile: outputFileSync,
          logFile: logFileSync,
          sessionFile,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(commands.length).toBe(2);
      expect(commands[0]).toContain("--model");
      expect(commands[0]).toContain("sonnet");
      expect(commands[0]).toContain("--resume");
      expect(commands[0]).toContain("sess-123");
      expect(commands[0]).not.toContain("--add-dir");
      expect(commands[1]).toContain("--add-dir");
      expect(commands[1]).toContain("--allowedTools");
      expect(commands[1]).toContain("Read");
      expect(commands[1]).not.toContain("Glob");
      expect(adapter.getName()).toBe("Claude Code (sonnet)");
      expect(syncAdapter.getName()).toBe("Claude Code Sync (sonnet)");
      expect(await fs.readFile(logFile, "utf8")).toBe("");
      expect(await fs.readFile(logFileSync, "utf8")).toBe("");
    });
  });

  it("Claude adapter includes add_dir when no project root is provided", async () => {
    await withTempDir(async (root) => {
      const logFile = path.join(root, "claude.log");
      const outputFile = path.join(root, "output.md");
      const adapter = new ClaudeCodeAdapter({
        id: "claude",
        type: "claude",
        model: "sonnet",
        claude: { allowedTools: ["Read"], addDir: ["extra-dir"] },
      });

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const commands: string[][] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        commands.push(options.cmd);
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(commands.length).toBe(1);
      expect(commands[0]).toContain("--add-dir");
      expect(commands[0]).toContain("extra-dir");
      expect(commands[0]).toContain("--allowedTools");
      expect(commands[0]).toContain("Read");
    });
  });

  it("Claude adapters handle missing session files", async () => {
    await withTempDir(async (root) => {
      const logFile = path.join(root, "claude.log");
      const outputFile = path.join(root, "output.md");
      const adapter = new ClaudeCodeAdapter({ id: "claude", type: "claude", model: "sonnet" });

      const missingSession = path.join(root, "missing-session.txt");

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      bunSpawn.spawn = () => {
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile });
        adapter.spawn({
          worktree: root,
          prompt: "hello",
          outputFile,
          logFile,
          sessionFile: missingSession,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(await fs.readFile(logFile, "utf8")).toBe("");
    });
  });

  it("Codex adapters build commands and handle empty streams", async () => {
    await withTempDir(async (root) => {
      const sessionFile = path.join(root, "codex-session.txt");
      await fs.writeFile(sessionFile, "thread-123", "utf8");

      const logFile = path.join(root, "codex.log");
      const logFileSync = path.join(root, "codex-sync.log");
      const outputFile = path.join(root, "output.md");
      const outputFileSync = path.join(root, "output-sync.md");

      const adapter = new CodexCLIAdapter({
        id: "codex",
        type: "codex",
        model: "codex-5.2",
        thinking: "xmax",
        codex: {
          fullAuto: false,
          sandbox: "read-only",
          approvalPolicy: "untrusted",
          addDir: ["extra-dir"],
          search: true,
        },
      });
      const syncAdapter = new CodexCLISyncAdapter({
        id: "codex-sync",
        type: "codex",
        model: "codex-5.2",
        thinking: "xmax",
        codex: {
          fullAuto: false,
          sandbox: "read-only",
          approvalPolicy: "untrusted",
          addDir: ["extra-dir"],
          search: true,
        },
      });

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const commands: string[][] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        commands.push(options.cmd);
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile, sessionFile });
        syncAdapter.spawn({
          worktree: root,
          prompt: "hello",
          outputFile: outputFileSync,
          logFile: logFileSync,
          sessionFile,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(commands.length).toBe(2);
      expect(commands[0]).toContain("--add-dir");
      expect(commands[0]).toContain("--enable");
      expect(commands[0]).toContain("web_search_request");
      expect(commands[0]).toContain("--sandbox");
      expect(commands[0]).toContain("read-only");
      expect(commands[0]).toContain("--ask-for-approval");
      expect(commands[0]).toContain("untrusted");
      expect(commands[0]).toContain("extra-dir");
      expect(commands[0]).toContain("--model");
      expect(commands[0]).toContain("codex-5.2");
      expect(commands[0]).toContain("-c");
      expect(commands[0]).toContain("model_reasoning_effort=xmax");
      expect(commands[0]).not.toContain("--full-auto");
      expect(commands[0]).toContain("resume");
      expect(commands[0]).toContain("thread-123");
      expect(commands[1]).toContain("--add-dir");
      expect(commands[1]).toContain("--enable");
      expect(commands[1]).toContain("web_search_request");
      expect(commands[1]).toContain("--sandbox");
      expect(commands[1]).toContain("read-only");
      expect(commands[1]).toContain("--ask-for-approval");
      expect(commands[1]).toContain("untrusted");
      expect(commands[1]).toContain("extra-dir");
      expect(commands[1]).toContain("--model");
      expect(commands[1]).toContain("codex-5.2");
      expect(commands[1]).toContain("-c");
      expect(commands[1]).toContain("model_reasoning_effort=xmax");
      expect(commands[1]).not.toContain("--full-auto");
      expect(commands[1]).toContain("resume");
      expect(commands[1]).toContain("thread-123");
      expect(adapter.getName()).toBe("Codex CLI (codex-5.2)");
      expect(syncAdapter.getName()).toBe("Codex CLI Sync (codex-5.2)");
      expect(await fs.readFile(logFile, "utf8")).toBe("");
      expect(await fs.readFile(logFileSync, "utf8")).toBe("");
    });
  });

  it("Codex adapter uses output file path when log file is empty", async () => {
    await withTempDir(async (root) => {
      const outputFile = path.join(root, "output.md");
      await fs.writeFile(outputFile, "# Plan", "utf8");

      const adapter = new CodexCLIAdapter({
        id: "codex",
        type: "codex",
        model: "codex-5.2",
        codex: { mcp: { servers: [{ name: "test", command: ["npx", "server"] }] } },
      });

      const originalWriteFile = fs.writeFile;
      const originalAppendFile = fs.appendFile;
      (fs as unknown as { writeFile: typeof fs.writeFile }).writeFile = async (
        file,
        data,
        options,
      ) => {
        if (file === "") {
          return;
        }
        return originalWriteFile(file, data, options as Parameters<typeof fs.writeFile>[2]);
      };
      (fs as unknown as { appendFile: typeof fs.appendFile }).appendFile = async (
        file,
        data,
        options,
      ) => {
        if (file === "") {
          return;
        }
        return originalAppendFile(file, data, options as Parameters<typeof fs.appendFile>[2]);
      };

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      bunSpawn.spawn = () => {
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile: "" });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
        (fs as unknown as { writeFile: typeof fs.writeFile }).writeFile = originalWriteFile;
        (fs as unknown as { appendFile: typeof fs.appendFile }).appendFile = originalAppendFile;
      }

      const configPath = path.join(path.dirname(outputFile), "codex.config.json");
      const configData = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(configData).toEqual({
        mcp: { servers: [{ name: "test", command: ["npx", "server"] }] },
      });
    });
  });

  it("Codex adapter writes config file when MCP config is set", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "# Plan" })
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({
          id: "codex",
          type: "codex",
          model: "codex-5.2",
          codex: {
            mcp: { servers: [{ name: "test", command: ["npx", "server"] }] },
          },
        });
        const outputFile = path.join(root, "plan.md");
        const logFile = path.join(root, "codex.log");
        const sessionFile = path.join(root, "codex-session.txt");
        await fs.writeFile(outputFile, "# Old Plan", "utf8");

        const [success] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);

        const configPath = path.join(path.dirname(sessionFile), "codex.config.json");
        const configData = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(configData).toEqual({
          mcp: { servers: [{ name: "test", command: ["npx", "server"] }] },
        });
      });
    });
  });

  it("Codex spawn writes config file synchronously when config is present", async () => {
    await withTempDir(async (root) => {
      const logFile = path.join(root, "codex.log");
      const logFileSync = path.join(root, "codex-sync.log");
      const outputFile = path.join(root, "output.md");
      const adapter = new CodexCLIAdapter({
        id: "codex",
        type: "codex",
        model: "codex-5.2",
        codex: { mcp: { servers: [{ name: "test", command: ["npx", "server"] }] } },
      });
      const syncAdapter = new CodexCLISyncAdapter({
        id: "codex-sync",
        type: "codex",
        model: "codex-5.2",
        codex: { mcp: { servers: [{ name: "test", command: ["npx", "server"] }] } },
      });

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const commands: string[][] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        commands.push(options.cmd);
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile });
        syncAdapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile: logFileSync });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(commands.length).toBe(2);
      expect(commands[0]).toContain("--config");
      expect(commands[1]).toContain("--config");

      const configPath = path.join(path.dirname(logFile), "codex.config.json");
      const configData = JSON.parse(await fs.readFile(configPath, "utf8"));
      expect(configData).toEqual({
        mcp: { servers: [{ name: "test", command: ["npx", "server"] }] },
      });
    });
  });

  it("Codex adapter throws when config includes mcp twice", async () => {
    await withTempDir(async (root) => {
      const adapter = new CodexCLIAdapter({
        id: "codex",
        type: "codex",
        model: "codex-5.2",
        codex: { config: { mcp: { servers: [] } }, mcp: { servers: [] } },
      });
      const logFile = path.join(root, "codex.log");
      const outputFile = path.join(root, "output.md");

      expect(() => adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile })).toThrow(
        "codex.mcp conflicts",
      );
    });
  });

  it("Claude adapter prefers output when write tools are disabled", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
const payload = JSON.stringify({ session_id: "sess-1", result: "# New Plan" });
process.stdout.write(payload);
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new ClaudeCodeSyncAdapter({
          id: "opus",
          type: "claude",
          model: "opus",
          claude: { allowedTools: ["Read"] },
        });
        const outputFile = path.join(root, "plan.md");
        const logFile = path.join(root, "claude.log");
        const sessionFile = path.join(root, "claude-session.txt");
        await fs.writeFile(outputFile, "# Old Plan", "utf8");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("# New Plan");
        expect(await fs.readFile(outputFile, "utf8")).toBe("# New Plan");
      });
    });
  });

  it("Codex adapter prefers output in read-only sandbox", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "# New Plan" })
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({
          id: "codex",
          type: "codex",
          model: "codex-5.2",
          codex: { sandbox: "read-only" },
        });
        const outputFile = path.join(root, "plan.md");
        const logFile = path.join(root, "codex.log");
        const sessionFile = path.join(root, "codex-session.txt");
        await fs.writeFile(outputFile, "# Old Plan", "utf8");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("# New Plan");
        expect(await fs.readFile(outputFile, "utf8")).toBe("# New Plan");
      });
    });
  });

  it("Codex adapter ignores prefer-output when dangerously bypassing", async () => {
    await withTempDir(async (root) => {
      const adapter = new CodexCLISyncAdapter({
        id: "codex",
        type: "codex",
        model: "codex-5.2",
        codex: { dangerouslyBypass: true },
      });
      const outputFile = path.join(root, "plan.md");
      const logFile = path.join(root, "codex.log");
      await fs.writeFile(outputFile, "# Old Plan", "utf8");

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      const commands: string[][] = [];
      bunSpawn.spawn = (options: { cmd: string[] }) => {
        commands.push(options.cmd);
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      let output = "";
      try {
        const [success, result] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
        });
        expect(success).toBe(true);
        output = result;
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(commands[0]).toContain("--dangerously-bypass-approvals-and-sandbox");
      expect(output).toBe("# Old Plan");
      expect(await fs.readFile(outputFile, "utf8")).toBe("# Old Plan");
    });
  });

  it("Codex adapters handle missing session files", async () => {
    await withTempDir(async (root) => {
      const logFile = path.join(root, "codex.log");
      const outputFile = path.join(root, "output.md");
      const adapter = new CodexCLIAdapter({ id: "codex", type: "codex", model: "mini" });

      const missingSession = path.join(root, "missing-session.txt");

      const originalSpawn = Bun.spawn;
      const bunSpawn = Bun as unknown as { spawn: (options: any) => Bun.Subprocess };
      bunSpawn.spawn = () => {
        return {
          stdout: null,
          stderr: null,
          exited: Promise.resolve(0),
          exitCode: 0,
          kill: () => {},
        } as unknown as Bun.Subprocess;
      };

      try {
        adapter.spawn({ worktree: root, prompt: "hello", outputFile, logFile });
        adapter.spawn({
          worktree: root,
          prompt: "hello",
          outputFile,
          logFile,
          sessionFile: missingSession,
        });
        await new Promise((resolve) => setTimeout(resolve, 10));
      } finally {
        bunSpawn.spawn = originalSpawn as unknown as (options: any) => Bun.Subprocess;
      }

      expect(await fs.readFile(logFile, "utf8")).toBe("");
    });
  });

  it("Claude adapter streams output and persists session id", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      const claudePath = path.join(binDir, "claude");
      await writeExecutable(
        claudePath,
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
const isResume = args.includes("--resume");
const sessionId = isResume ? "sess-resume" : "sess-start";
const result = "# Plan from Claude";
const payload = JSON.stringify({ session_id: sessionId, result });
const mid = Math.floor(payload.length / 2);
process.stdout.write(payload.slice(0, mid));
process.stdout.write(payload.slice(mid));
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new ClaudeCodeSyncAdapter({ id: "opus", type: "claude", model: "opus" });
        const outputFile = path.join(root, "output.md");
        const logFile = path.join(root, "claude.log");
        const sessionFile = path.join(root, "claude-session.txt");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);
        expect(output).toContain("# Plan from Claude");
        expect(await fs.readFile(sessionFile, "utf8")).toBe("sess-start");

        const [success2] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
          appendLog: true,
        });

        expect(success2).toBe(true);
        expect(await fs.readFile(sessionFile, "utf8")).toBe("sess-resume");

        const logContent = await fs.readFile(logFile, "utf8");
        expect(logContent.length).toBeGreaterThan(0);
      });
    });
  });

  it("Codex adapter parses JSON lines and updates thread id", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      const codexPath = path.join(binDir, "codex");
      await writeExecutable(
        codexPath,
        `#!/usr/bin/env bun
const args = process.argv.slice(2);
const isResume = args.includes("resume");
const threadId = isResume ? "thread-resume" : "thread-start";
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: threadId }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "Final output" })
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({ id: "codex", type: "codex", model: "codex" });
        const outputFile = path.join(root, "codex-output.md");
        const logFile = path.join(root, "codex.log");
        const sessionFile = path.join(root, "codex-session.txt");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);
        expect(output).toContain("Final output");
        expect(await fs.readFile(sessionFile, "utf8")).toBe("thread-start");

        const [success2] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
          appendLog: true,
        });

        expect(success2).toBe(true);
        expect(await fs.readFile(sessionFile, "utf8")).toBe("thread-resume");

        const logContent = await fs.readFile(logFile, "utf8");
        expect(logContent.length).toBeGreaterThan(0);
      });
    });
  });

  it("Claude adapter falls back to raw output on invalid JSON", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
process.stdout.write("plain output");
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new ClaudeCodeSyncAdapter({ id: "opus", type: "claude", model: "opus" });
        const outputFile = path.join(root, "raw.md");
        const logFile = path.join(root, "claude.log");
        const sessionFile = path.join(root, "claude-session.txt");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("plain output");
        expect(await fs.readFile(outputFile, "utf8")).toBe("plain output");
        expect(await fileExists(sessionFile)).toBe(false);
      });
    });
  });

  it("Codex adapter falls back to raw output on invalid JSON", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
process.stdout.write("raw codex output");
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({ id: "codex", type: "codex", model: "codex" });
        const outputFile = path.join(root, "codex-raw.md");
        const logFile = path.join(root, "codex.log");
        const sessionFile = path.join(root, "codex-session.txt");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          sessionFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("raw codex output");
        expect(await fs.readFile(outputFile, "utf8")).toBe("raw codex output");
        expect(await fileExists(sessionFile)).toBe(false);
      });
    });
  });

  it("Codex adapter returns error output on nonzero exit", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
process.stderr.write("codex failed");
process.exit(1);
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({ id: "codex", type: "codex", model: "codex" });
        const outputFile = path.join(root, "codex-error.md");
        const logFile = path.join(root, "codex.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
        });

        expect(success).toBe(false);
        expect(output).toContain("codex failed");
      });
    });
  });

  it("Claude adapter writes to preexisting empty output file", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
const payload = JSON.stringify({ session_id: "sess-empty", result: "fresh output" });
process.stdout.write(payload);
`,
      );

      const outputFile = path.join(root, "existing.md");
      await fs.writeFile(outputFile, "", "utf8");

      await withPatchedPath(binDir, async () => {
        const adapter = new ClaudeCodeSyncAdapter({ id: "opus", type: "claude", model: "opus" });
        const logFile = path.join(root, "claude.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("fresh output");
        expect(await fs.readFile(outputFile, "utf8")).toBe("fresh output");
      });
    });
  });

  it("Claude adapter returns output when output file cannot be read", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
const payload = JSON.stringify({ session_id: "sess-dir", result: "fresh output" });
process.stdout.write(payload);
`,
      );

      const outputDir = path.join(root, "output-dir");
      await fs.mkdir(outputDir, { recursive: true });

      await withPatchedPath(binDir, async () => {
        const adapter = new ClaudeCodeSyncAdapter({ id: "opus", type: "claude", model: "opus" });
        const logFile = path.join(root, "claude.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile: outputDir,
          logFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("fresh output");
      });
    });
  });

  it("Codex adapter writes to preexisting empty output file", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "fresh output" })
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      const outputFile = path.join(root, "existing.md");
      await fs.writeFile(outputFile, "", "utf8");

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({ id: "codex", type: "codex", model: "codex" });
        const logFile = path.join(root, "codex.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("fresh output");
        expect(await fs.readFile(outputFile, "utf8")).toBe("fresh output");
      });
    });
  });

  it("Codex adapter returns output when output file cannot be read", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "fresh output" })
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      const outputDir = path.join(root, "output-dir");
      await fs.mkdir(outputDir, { recursive: true });

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({ id: "codex", type: "codex", model: "codex" });
        const logFile = path.join(root, "codex.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile: outputDir,
          logFile,
        });

        expect(success).toBe(true);
        expect(output).toBe("fresh output");
      });
    });
  });

  it("Claude adapter reports timeout", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
await new Promise((r) => setTimeout(r, 50));
process.stdout.write("late output");
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new ClaudeCodeSyncAdapter({ id: "opus", type: "claude", model: "opus" });
        const outputFile = path.join(root, "timeout.md");
        const logFile = path.join(root, "claude.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          timeout: 0.01,
        });

        expect(success).toBe(false);
        expect(output).toBe("Timeout expired");
      });
    });
  });

  it("Codex adapter reports timeout", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
await new Promise((r) => setTimeout(r, 50));
process.stdout.write("late output");
`,
      );

      await withPatchedPath(binDir, async () => {
        const adapter = new CodexCLISyncAdapter({ id: "codex", type: "codex", model: "codex" });
        const outputFile = path.join(root, "timeout.md");
        const logFile = path.join(root, "codex.log");

        const [success, output] = await adapter.runSync({
          worktree: root,
          prompt: "test",
          outputFile,
          logFile,
          timeout: 0.01,
        });

        expect(success).toBe(false);
        expect(output).toBe("Timeout expired");
      });
    });
  });
});
