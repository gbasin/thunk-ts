import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { resolveServerConfig } from "../src/server/config";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pl4n-config-"));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("server config", () => {
  it("loads config from file when no overrides", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "config.yaml"),
        ["workspaces:", "  - /tmp/one", "bind: 127.0.0.1", "port: 4567", ""].join("\n"),
        "utf8",
      );

      const originalHome = process.env.PL4N_HOME;
      delete process.env.PL4N_WORKSPACE;
      try {
        process.env.PL4N_HOME = globalDir;
        const config = await resolveServerConfig({ cwd: "/cwd" });
        expect(config.workspaces).toEqual([path.resolve("/tmp/one")]);
        expect(config.bind).toBe("127.0.0.1");
        expect(config.port).toBe(4567);
        expect(config.workspaceSource).toBe("config");
      } finally {
        if (originalHome === undefined) {
          delete process.env.PL4N_HOME;
        } else {
          process.env.PL4N_HOME = originalHome;
        }
      }
    });
  });

  it("prefers env workspace over config", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });
      await fs.writeFile(
        path.join(globalDir, "config.yaml"),
        ["workspaces:", "  - /tmp/one", ""].join("\n"),
        "utf8",
      );

      const originalHome = process.env.PL4N_HOME;
      const originalWorkspace = process.env.PL4N_WORKSPACE;
      try {
        process.env.PL4N_HOME = globalDir;
        process.env.PL4N_WORKSPACE = "/tmp/two";
        const config = await resolveServerConfig({ cwd: "/cwd" });
        expect(config.workspaces).toEqual([path.resolve("/tmp/two")]);
        expect(config.workspaceSource).toBe("env");
      } finally {
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
    });
  });

  it("prefers CLI workspace over env", async () => {
    await withTempDir(async (root) => {
      const globalDir = path.join(root, "global");
      await fs.mkdir(globalDir, { recursive: true });

      const originalHome = process.env.PL4N_HOME;
      const originalWorkspace = process.env.PL4N_WORKSPACE;
      try {
        process.env.PL4N_HOME = globalDir;
        process.env.PL4N_WORKSPACE = "/tmp/two";
        const config = await resolveServerConfig({ workspace: "/tmp/cli" });
        expect(config.workspaces).toEqual([path.resolve("/tmp/cli")]);
        expect(config.workspaceSource).toBe("cli");
      } finally {
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
    });
  });
});
