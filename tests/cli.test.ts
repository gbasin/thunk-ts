import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

const decoder = new TextDecoder();

function runCli(args: string[], cwd: string) {
  const result = Bun.spawnSync({
    cmd: ["bun", "src/index.ts", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    exitCode: result.exitCode ?? 0,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr)
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

      const result = runCli([
        "--thunk-dir",
        thunkDir,
        "--pretty",
        "init",
        "Test feature"
      ], repoRoot);

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

      const approve = runCli(["--thunk-dir", thunkDir, "approve", "--session", sessionId], repoRoot);
      expect(approve.exitCode).toBe(1);

      const cont = runCli(["--thunk-dir", thunkDir, "continue", "--session", sessionId], repoRoot);
      expect(cont.exitCode).toBe(1);
    });
  });
});
