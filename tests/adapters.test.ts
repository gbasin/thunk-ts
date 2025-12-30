import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { ClaudeCodeSyncAdapter } from "../src/adapters/claude";
import { CodexCLISyncAdapter } from "../src/adapters/codex";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-adapter-"));
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

describe("Adapters", () => {
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

  it("Claude adapter reports timeout", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
await new Promise((r) => setTimeout(r, 200));
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
          timeout: 0.05,
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
await new Promise((r) => setTimeout(r, 200));
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
          timeout: 0.05,
        });

        expect(success).toBe(false);
        expect(output).toBe("Timeout expired");
      });
    });
  });
});
