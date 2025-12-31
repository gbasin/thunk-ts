import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import { describe, expect, it } from "bun:test";

import { Phase, Pl4nConfig } from "../src/models";
import { SessionManager } from "../src/session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-cli-core-"));
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

async function runCliCapture(args: string[]): Promise<string[]> {
  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };

  try {
    const { runCli } = await import("../src/cli");
    await runCli(args);
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
      const pl4nDir = path.join(root, ".pl4n-test");

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "init",
        "CLI init",
      ]);

      const data = JSON.parse(logs[0]) as { session_id: string; turn: number; phase: string };
      expect(data.session_id).toBeDefined();
      expect(data.turn).toBe(1);
      expect(data.phase).toBe(Phase.Drafting);

      const manager = new SessionManager(pl4nDir);
      const state = await manager.loadSession(data.session_id);
      expect(state?.task).toBe("CLI init");
    });
  });

  it("init reads task from stdin with --file -", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const originalStdin = process.stdin;
      (process as { stdin: NodeJS.ReadableStream }).stdin = Readable.from([
        Buffer.from("Task from stdin\n"),
      ]);

      try {
        const logs = await runCliCommandCapture([
          "node",
          "pl4n",
          "--pl4n-dir",
          pl4nDir,
          "init",
          "--file",
          "-",
        ]);

        const data = JSON.parse(logs[0]) as { session_id: string };
        const manager = new SessionManager(pl4nDir);
        const state = await manager.loadSession(data.session_id);
        expect(state?.task).toBe("Task from stdin");
      } finally {
        (process as { stdin: NodeJS.ReadableStream }).stdin = originalStdin;
      }
    });
  });

  it("init errors when task file is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const missing = path.join(root, "missing.md");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "init",
        "--file",
        missing,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Cannot read task file");
    });
  });

  it("init errors when missing task and --file", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit(["node", "pl4n", "--pl4n-dir", pl4nDir, "init"]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing task description");
    });
  });

  it("init errors when config is invalid", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      await fs.mkdir(pl4nDir, { recursive: true });
      await fs.writeFile(path.join(pl4nDir, "pl4n.yaml"), "agents: [", "utf8");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "init",
        "Bad config",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Invalid config");
    });
  });

  it("list honors global options and pretty output", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      await manager.createSession("Task one");
      await manager.createSession("Task two");

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        `--pl4n-dir=${pl4nDir}`,
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
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Status check");

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "status",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { file: string | null; session_id: string };
      expect(data.session_id).toBe(state.sessionId);
      expect(data.file).toBeNull();
    });
  });

  it("status includes agent errors and file path", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Status errors");
      state.agentErrors = { codex: "failed" };
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "## Summary\nOk\n", "utf8");

      const originalWeb = process.env.PL4N_WEB;
      process.env.PL4N_WEB = "false";

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

        const data = JSON.parse(logs[0]) as { agent_errors: Record<string, string>; file: string };
        expect(data.agent_errors).toEqual({ codex: "failed" });
        expect(data.file).toBe(paths.turnFile(state.turn));
      } finally {
        if (originalWeb === undefined) {
          delete process.env.PL4N_WEB;
        } else {
          process.env.PL4N_WEB = originalWeb;
        }
      }
    });
  });

  it("status errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "status",
        "--session",
        "missing-session",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("missing-session");
    });
  });

  it("wait errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit(["node", "pl4n", "--pl4n-dir", pl4nDir, "wait"]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });

  it("wait errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "wait",
        "--session",
        "missing-session",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("missing-session");
    });
  });

  it("approve creates a plan symlink", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Approve test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(state.turn)), { recursive: true });
      await fs.writeFile(paths.turnFile(state.turn), "## Summary\nOk\n", "utf8");
      await fs.writeFile(path.join(paths.root, "PLAN.md"), "Old plan\n", "utf8");

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
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
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Clean test");

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
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
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Diff test", Pl4nConfig.default());
      state.turn = 2;
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(paths.turnFile(1), "Line one\n", "utf8");
      await fs.writeFile(paths.turnFile(2), "Line two\n", "utf8");

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
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

  it("diff errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "diff",
        "--session",
        "missing-session",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("missing-session");
    });
  });

  it("diff errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit(["node", "pl4n", "--pl4n-dir", pl4nDir, "diff"]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });

  it("diff errors when turn is less than 2", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Diff small");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "diff",
        "--session",
        state.sessionId,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Need at least 2 turns");
    });
  });

  it("diff errors when turn files are missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Diff missing");
      state.turn = 2;
      await manager.saveState(state);

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "diff",
        "--session",
        state.sessionId,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Turn files not found");
    });
  });

  it("diff errors when session meta is invalid", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Diff meta");
      state.turn = 2;
      await manager.saveState(state);

      const paths = manager.getPaths(state.sessionId);
      await fs.writeFile(paths.meta, "bad: [", "utf8");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "diff",
        "--session",
        state.sessionId,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Invalid session meta");
    });
  });

  it("wait returns user_review with agent errors", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Wait errors");
      state.phase = Phase.UserReview;
      state.agentErrors = { codex: "failed" };
      await manager.saveState(state);

      const originalWeb = process.env.PL4N_WEB;
      process.env.PL4N_WEB = "false";

      try {
        const logs = await runCliCommandCapture([
          "node",
          "pl4n",
          "--pl4n-dir",
          pl4nDir,
          "wait",
          "--session",
          state.sessionId,
        ]);

        const data = JSON.parse(logs[0]) as { agent_errors: Record<string, string> };
        expect(data.agent_errors).toEqual({ codex: "failed" });
      } finally {
        if (originalWeb === undefined) {
          delete process.env.PL4N_WEB;
        } else {
          process.env.PL4N_WEB = originalWeb;
        }
      }
    });
  });

  it("wait returns approved details", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Wait approved");
      state.phase = Phase.Approved;
      await manager.saveState(state);

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "wait",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { file: string; phase: string };
      expect(data.phase).toBe(Phase.Approved);
      expect(data.file).toBe(path.join(manager.getPaths(state.sessionId).root, "PLAN.md"));
    });
  });

  it("continue advances a user_review session", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Continue test");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const logs = await runCliCommandCapture([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "continue",
        "--session",
        state.sessionId,
      ]);

      const data = JSON.parse(logs[0]) as { turn: number; phase: string };
      expect(data.turn).toBe(2);
      expect(data.phase).toBe(Phase.Drafting);

      const updated = await manager.loadSession(state.sessionId);
      expect(updated?.turn).toBe(2);
      expect(updated?.phase).toBe(Phase.Drafting);
    });
  });

  it("continue errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "continue",
        "--session",
        "missing-session",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("missing-session");
    });
  });

  it("continue errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "continue",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });

  it("approve errors with unanswered questions", async () => {
    await withTempDir(async (root) => {
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

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "approve",
        "--session",
        state.sessionId,
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Cannot approve with unanswered questions");
    });
  });

  it("approve errors when session does not exist", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "approve",
        "--session",
        "missing-session",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("missing-session");
    });
  });

  it("approve errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "approve",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });

  it("clean errors when session is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "clean",
        "--session",
        "missing-session",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("missing-session");
    });
  });

  it("clean errors when --session is missing", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "clean",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });

  it("runCli parses commands", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");
      const manager = new SessionManager(pl4nDir);
      await manager.createSession("List item");

      const logs = await runCliCapture(["node", "pl4n", "--pl4n-dir", pl4nDir, "list"]);
      const data = JSON.parse(logs[0]) as { sessions: unknown[] };
      expect(data.sessions.length).toBe(1);
    });
  });

  it("status exits with error when missing --session", async () => {
    await withTempDir(async (root) => {
      const pl4nDir = path.join(root, ".pl4n-test");

      const result = await runCliCommandExpectExit([
        "node",
        "pl4n",
        "--pl4n-dir",
        pl4nDir,
        "status",
      ]);

      expect(result.exitCode).toBe(1);
      const data = JSON.parse(result.output) as { error: string };
      expect(data.error).toContain("Missing --session");
    });
  });
});
