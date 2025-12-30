import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { Phase, ThunkConfig } from "../src/models";
import { TurnOrchestrator } from "../src/orchestrator";
import { SessionManager } from "../src/session";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-orch-"));
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

async function waitForFiles(files: string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(files.map((file) => fileExists(file)));
    if (states.every(Boolean)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const states = await Promise.all(files.map((file) => fileExists(file)));
  const missing = files.filter((_, index) => !states[index]);
  throw new Error(`Timed out waiting for files: ${missing.join(", ")}`);
}

describe("TurnOrchestrator", () => {
  it("runs a turn and writes outputs", async () => {
    await withTempDir(async (root) => {
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
        const manager = new SessionManager(path.join(root, ".thunk-test"));
        const state = await manager.createSession("Test task");
        state.phase = Phase.Drafting;
        await manager.saveState(state);

        const orchestrator = new TurnOrchestrator(manager, ThunkConfig.default());
        const success = await orchestrator.runTurn(state.sessionId);
        expect(success).toBe(true);

        const updated = await manager.loadSession(state.sessionId);
        expect(updated?.phase).toBe(Phase.UserReview);

        const paths = manager.getPaths(state.sessionId);
        const turnFile = paths.turnFile(1);
        const snapshotFile = turnFile.replace(/\.md$/, ".snapshot.md");
        expect(await fs.readFile(turnFile, "utf8")).toContain("# Plan");
        expect(await fs.readFile(snapshotFile, "utf8")).toContain("# Plan");
      });
    });
  });

  it("runs drafting agents in parallel", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      const signals = {
        claudeStarted: path.join(root, "claude.started"),
        codexStarted: path.join(root, "codex.started"),
        release: path.join(root, "release"),
      };

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
import { promises as fs } from "fs";

const started = ${JSON.stringify(signals.claudeStarted)};
const release = ${JSON.stringify(signals.release)};
const deadline = Date.now() + 5000;

await fs.writeFile(started, "started", "utf8");

while (true) {
  try {
    await fs.access(release);
    break;
  } catch {}
  if (Date.now() > deadline) {
    console.error("release timeout");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const payload = JSON.stringify({ session_id: "sess-1", result: "# Plan from Claude" });
process.stdout.write(payload);
`,
      );

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
import { promises as fs } from "fs";

const started = ${JSON.stringify(signals.codexStarted)};
const release = ${JSON.stringify(signals.release)};
const deadline = Date.now() + 5000;

await fs.writeFile(started, "started", "utf8");

while (true) {
  try {
    await fs.access(release);
    break;
  } catch {}
  if (Date.now() > deadline) {
    console.error("release timeout");
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "# Plan from Codex" }),
];
for (const line of lines) {
  process.stdout.write(line + "\\n");
}
`,
      );

      await withPatchedPath(binDir, async () => {
        const manager = new SessionManager(path.join(root, ".thunk-test"));
        const state = await manager.createSession("Test task");
        state.phase = Phase.Drafting;
        await manager.saveState(state);

        const orchestrator = new TurnOrchestrator(manager, ThunkConfig.default());
        const runPromise = orchestrator.runTurn(state.sessionId);

        let waitError: unknown;
        try {
          await waitForFiles([signals.claudeStarted, signals.codexStarted], 3000);
        } catch (error) {
          waitError = error;
        }

        await fs.writeFile(signals.release, "go", "utf8");
        const success = await runPromise;

        if (waitError) {
          throw waitError;
        }

        expect(success).toBe(true);
      });
    });
  });

  it("returns diffs between turns", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      const paths = manager.getPaths(state.sessionId);

      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(paths.turnFile(1), "line one\n", "utf8");
      await fs.writeFile(paths.turnFile(2), "line two\n", "utf8");

      state.turn = 2;
      await manager.saveState(state);

      const orchestrator = new TurnOrchestrator(manager, ThunkConfig.default());
      const diff = await orchestrator.getDiff(state.sessionId);

      expect(diff).toContain("turn-001.md");
      expect(diff).toContain("turn-002.md");
    });
  });

  it("generates user feedback diff when snapshots exist", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      const paths = manager.getPaths(state.sessionId);

      await fs.mkdir(path.dirname(paths.turnFile(1)), { recursive: true });
      await fs.writeFile(paths.turnFile(1), "line one\n", "utf8");
      await fs.writeFile(paths.turnFile(1).replace(/\.md$/, ".snapshot.md"), "line zero\n", "utf8");

      state.turn = 2;
      await manager.saveState(state);

      const orchestrator = new TurnOrchestrator(manager, ThunkConfig.default());
      const feedback = await (
        orchestrator as unknown as {
          getUserFeedback: (
            paths: { turnFile: (turn: number) => string },
            turn: number,
          ) => Promise<string>;
        }
      ).getUserFeedback(paths, 2);

      expect(feedback).toContain("```diff");
      expect(feedback).toContain("line zero");
      expect(feedback).toContain("line one");
    });
  });

  it("falls back to combined output when synthesis fails", async () => {
    await withTempDir(async (root) => {
      const binDir = path.join(root, "bin");
      await fs.mkdir(binDir, { recursive: true });

      await writeExecutable(
        path.join(binDir, "claude"),
        `#!/usr/bin/env bun
process.exit(1);
`,
      );

      await withPatchedPath(binDir, async () => {
        const manager = new SessionManager(path.join(root, ".thunk-test"));
        const state = await manager.createSession("Test task");
        const paths = manager.getPaths(state.sessionId);

        const orchestrator = new TurnOrchestrator(manager, ThunkConfig.default());
        const result = await (
          orchestrator as unknown as {
            synthesize: (
              task: string,
              agentPlans: Record<string, string>,
              paths: { agents: string },
              userDiff: string,
            ) => Promise<string>;
          }
        ).synthesize(
          "Test task",
          { opus: "Plan A", codex: "Plan B" },
          { agents: paths.agents },
          "",
        );

        expect(result).toContain("Combined from agents");
        expect(result).toContain("Plan A");
        expect(result).toContain("Plan B");
      });
    });
  });

  it("returns the single agent plan without synthesis", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk-test"));
      const state = await manager.createSession("Test task");
      const paths = manager.getPaths(state.sessionId);

      const orchestrator = new TurnOrchestrator(manager, ThunkConfig.default());
      const result = await (
        orchestrator as unknown as {
          synthesize: (
            task: string,
            agentPlans: Record<string, string>,
            paths: { agents: string },
            userDiff: string,
          ) => Promise<string>;
        }
      ).synthesize("Test task", { opus: "Solo plan" }, { agents: paths.agents }, "");

      expect(result).toBe("Solo plan");
    });
  });
});
