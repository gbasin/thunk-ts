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
`
      );

      await writeExecutable(
        path.join(binDir, "codex"),
        `#!/usr/bin/env bun
const lines = [
  JSON.stringify({ type: "thread.started", thread_id: "thread-1" }),
  JSON.stringify({ type: "item.message", role: "assistant", content: "# Plan from Codex" })
];
for (const line of lines) {
  process.stdout.write(line + "\n");
}
`
      );

      const originalPath = process.env.PATH || "";
      process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;

      const manager = new SessionManager(path.join(root, ".thunk"));
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

      process.env.PATH = originalPath;
    });
  });

  it("returns diffs between turns", async () => {
    await withTempDir(async (root) => {
      const manager = new SessionManager(path.join(root, ".thunk"));
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
});
