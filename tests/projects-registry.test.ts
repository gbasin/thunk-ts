import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { Phase } from "../src/models";
import { SessionManager } from "../src/session";
import { ProjectRegistry } from "../src/server/projects";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-projects-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("project registry", () => {
  it("discovers projects and emits activity on phase change", async () => {
    await withTempDir(async (root) => {
      const projectRoot = path.join(root, "project-a");
      const pl4nDir = path.join(projectRoot, ".pl4n");
      const manager = new SessionManager(pl4nDir);
      const state = await manager.createSession("Registry test");
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      const registry = new ProjectRegistry({ workspaces: [root] });
      await registry.start();

      const projects = registry.listProjects();
      expect(projects.length).toBe(1);
      expect(projects[0]?.root).toBe(projectRoot);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const eventPromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("activity timeout")), 5000);
        registry.once("activity", (event) => {
          clearTimeout(timer);
          resolve(event);
        });
      });

      state.phase = Phase.UserReview;
      await manager.saveState(state);

      const event = (await eventPromise) as { action: string; session_id: string };
      expect(event.action).toBe("review_needed");
      expect(event.session_id).toBe(state.sessionId);

      await registry.stop();
    });
  });
});
