import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

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
      const thunkDir = path.join(root, ".thunk");

      const result = runCli(["--thunk-dir", thunkDir, "init", "Add caching"], repoRoot);

      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBeDefined();
      expect(data.turn).toBe(1);
    });
  });

  it("list returns sessions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk");

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
      const thunkDir = path.join(root, ".thunk");

      const init = runCli(["--thunk-dir", thunkDir, "init", "Test feature"], repoRoot);
      const sessionId = JSON.parse(init.stdout).session_id as string;

      const result = runCli(["--thunk-dir", thunkDir, "status", "--session", sessionId], repoRoot);
      const data = JSON.parse(result.stdout);
      expect(data.session_id).toBe(sessionId);
      expect(data.turn).toBe(1);
    });
  });

  it("clean removes sessions", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk");

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
      const thunkDir = path.join(root, ".thunk");

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
      const thunkDir = path.join(root, ".thunk");

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

  it("wait returns user_review details", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk");
      const manager = new SessionManager(thunkDir);
      const state = await manager.createSession("Test feature");
      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const result = runCli(
        ["--thunk-dir", thunkDir, "wait", "--session", state.sessionId],
        repoRoot,
      );
      const data = JSON.parse(result.stdout);
      expect(data.phase).toBe(Phase.UserReview);
      expect(data.file).toBe(manager.getPaths(state.sessionId).turnFile(state.turn));
    });
  });

  it("wait returns approved details", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk");
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
      const thunkDir = path.join(root, ".thunk");
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

        const result = runCli(["--thunk-dir", thunkDir, "wait", "--session", sessionId], repoRoot);
        const data = JSON.parse(result.stdout);

        expect(data.phase).toBe(Phase.UserReview);
        expect(await fs.readFile(data.file, "utf8")).toContain("# Plan");
      });
    });
  });

  it("approve creates a plan symlink", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk");
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

  it("diff errors when turn < 2", async () => {
    await withTempDir(async (root) => {
      const repoRoot = path.resolve(import.meta.dir, "..");
      const thunkDir = path.join(root, ".thunk");

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
      const thunkDir = path.join(root, ".thunk");
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
});
