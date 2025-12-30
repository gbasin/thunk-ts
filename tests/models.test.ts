import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "bun:test";

import { AgentStatus, Phase, SessionPaths, SessionState, ThunkConfig } from "../src/models";

describe("Phase", () => {
  it("has expected values", () => {
    expect(String(Phase.Initializing)).toBe("initializing");
    expect(String(Phase.Drafting)).toBe("drafting");
    expect(String(Phase.PeerReview)).toBe("peer_review");
    expect(String(Phase.Synthesizing)).toBe("synthesizing");
    expect(String(Phase.UserReview)).toBe("user_review");
    expect(String(Phase.Approved)).toBe("approved");
    expect(String(Phase.Error)).toBe("error");
  });
});

describe("AgentStatus", () => {
  it("has expected values", () => {
    expect(String(AgentStatus.Pending)).toBe("pending");
    expect(String(AgentStatus.Working)).toBe("working");
    expect(String(AgentStatus.Done)).toBe("done");
    expect(String(AgentStatus.Error)).toBe("error");
  });
});

describe("SessionState", () => {
  it("serializes to dict", () => {
    const now = new Date("2024-01-01T00:00:00Z");
    const state = new SessionState({
      sessionId: "test-session",
      task: "Test task",
      turn: 2,
      phase: Phase.UserReview,
      createdAt: now,
      updatedAt: now,
      agents: { opus: AgentStatus.Done },
      agentPlanIds: { opus: "sunny-glade" },
    });

    const dict = state.toDict();

    expect(dict.session_id).toBe("test-session");
    expect(dict.task).toBe("Test task");
    expect(dict.turn).toBe(2);
    expect(dict.phase).toBe("user_review");
    expect(dict.agents).toEqual({ opus: "done" });
    expect(dict.agent_plan_ids).toEqual({ opus: "sunny-glade" });
  });

  it("serializes agent errors when present", () => {
    const now = new Date("2024-01-01T00:00:00Z");
    const state = new SessionState({
      sessionId: "test-session",
      task: "Test task",
      turn: 1,
      phase: Phase.UserReview,
      createdAt: now,
      updatedAt: now,
      agentErrors: { codex: "error: draft failed" },
    });

    const dict = state.toDict();

    expect(dict.agent_errors).toEqual({ codex: "error: draft failed" });
  });
});

describe("SessionPaths", () => {
  it("builds expected paths", () => {
    const root = path.join("/tmp", "thunk", "session");
    const paths = SessionPaths.fromRoot(root);

    expect(paths.root).toBe(root);
    expect(paths.meta).toBe(path.join(root, "meta.yaml"));
    expect(paths.state).toBe(path.join(root, "state.yaml"));
    expect(paths.turns).toBe(path.join(root, "turns"));
    expect(paths.agents).toBe(path.join(root, "agents"));

    expect(paths.turnFile(1)).toBe(path.join(root, "turns", "001.md"));
    expect(paths.turnSnapshotDir(10)).toBe(path.join(root, "turns", "010"));
    expect(paths.agentPlanFile("sunny-glade")).toBe(path.join(root, "sunny-glade.md"));
    expect(paths.agentLogFile("sunny-glade")).toBe(path.join(root, "agents", "sunny-glade.log"));
    expect(paths.agentSessionFile("sunny-glade")).toBe(
      path.join(root, "agents", "sunny-glade", "cli_session_id.txt"),
    );
    expect(paths.agentDir("sunny-glade")).toBe(path.join(root, "agents", "sunny-glade"));
  });
});

describe("ThunkConfig", () => {
  it("builds default config", () => {
    const config = ThunkConfig.default();
    expect(config.agents.length).toBe(2);
    expect(config.agents[0].id).toBe("opus");
    expect(config.agents[0].claude?.allowedTools).toContain("Read");
    expect(config.agents[1].id).toBe("codex");
    expect(config.agents[1].model).toBe("codex-5.2");
    expect(config.agents[1].thinking).toBe("xmax");
    expect(config.agents[1].codex?.sandbox).toBeUndefined();
    expect(config.agents[1].codex?.approvalPolicy).toBeUndefined();
    expect(config.agents[1].codex?.fullAuto).toBe(true);
    expect(config.agents[1].codex?.search).toBe(true);
    expect(config.synthesizer.id).toBe("synthesizer");
    expect(config.timeout).toBeUndefined();
  });

  it("loads config from yaml", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-config-"));
    const thunkDir = path.join(root, ".thunk");
    try {
      await fs.mkdir(thunkDir, { recursive: true });
      const yaml = [
        "claude:",
        "  allowed_tools:",
        "    - Read",
        "    - Write",
        "codex:",
        "  full_auto: false",
        "  sandbox: read-only",
        "  approval_policy: untrusted",
        "  dangerously_bypass: false",
        "  search: true",
        "  add_dir:",
        "    - extra-dir",
        "  config:",
        "    sandbox_permissions:",
        "      - disk-full-read-access",
        "  mcp:",
        "    servers:",
        "      - name: default",
        "        command:",
        "          - npx",
        "          - server",
        "agents:",
        "  - id: alpha",
        "    type: claude",
        "    model: opus",
        "    claude:",
        "      allowed_tools:",
        "        - Read",
        "  - id: beta",
        "    type: codex",
        "    model: codex-5.2",
        "    thinking: xmax",
        "    enabled: false",
        "synthesizer:",
        "  id: synth",
        "  type: claude",
        "  model: opus",
        "timeout: 120",
        "",
      ].join("\n");
      await fs.writeFile(path.join(thunkDir, "thunk.yaml"), yaml, "utf8");

      const config = await ThunkConfig.loadFromThunkDir(thunkDir);
      expect(config.agents.length).toBe(2);
      expect(config.agents[0]).toEqual({
        id: "alpha",
        type: "claude",
        model: "opus",
        claude: { allowedTools: ["Read"] },
        enabled: true,
      });
      expect(config.agents[1]).toEqual({
        id: "beta",
        type: "codex",
        model: "codex-5.2",
        thinking: "xmax",
        codex: {
          fullAuto: false,
          sandbox: "read-only",
          approvalPolicy: "untrusted",
          dangerouslyBypass: false,
          addDir: ["extra-dir"],
          search: true,
          config: { sandbox_permissions: ["disk-full-read-access"] },
          mcp: {
            servers: [{ name: "default", command: ["npx", "server"] }],
          },
        },
        enabled: false,
      });
      expect(config.synthesizer).toEqual({
        id: "synth",
        type: "claude",
        model: "opus",
        claude: { allowedTools: ["Read", "Write"] },
        enabled: true,
      });
      expect(config.timeout).toBe(120);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("applies defaults when agents and synthesizer are omitted", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-config-"));
    const thunkDir = path.join(root, ".thunk");
    try {
      await fs.mkdir(thunkDir, { recursive: true });
      const yaml = [
        "claude:",
        "  allowed_tools:",
        "    - Read",
        "codex:",
        "  search: false",
        "",
      ].join("\n");
      await fs.writeFile(path.join(thunkDir, "thunk.yaml"), yaml, "utf8");

      const config = await ThunkConfig.loadFromThunkDir(thunkDir);
      expect(config.agents.length).toBe(2);
      const claudeAgent = config.agents.find((agent) => agent.type === "claude");
      const codexAgent = config.agents.find((agent) => agent.type === "codex");

      expect(claudeAgent?.claude?.allowedTools).toEqual(["Read"]);
      expect(codexAgent?.codex?.search).toBe(false);
      expect(config.synthesizer.claude?.allowedTools).toEqual(["Read"]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to defaults when config is missing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-config-"));
    try {
      const config = await ThunkConfig.loadFromThunkDir(path.join(root, ".thunk"));
      expect(config.agents.length).toBe(2);
      expect(config.agents[0].id).toBe("opus");
      expect(config.agents[1].id).toBe("codex");
      expect(config.synthesizer.id).toBe("synthesizer");
      expect(config.timeout).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "thunk-config-"));
    const thunkDir = path.join(root, ".thunk");
    try {
      await fs.mkdir(thunkDir, { recursive: true });
      await fs.writeFile(path.join(thunkDir, "thunk.yaml"), "agents: []\n", "utf8");
      let error: Error | undefined;
      try {
        await ThunkConfig.loadFromThunkDir(thunkDir);
      } catch (err) {
        error = err as Error;
      }
      expect(error).toBeDefined();
      expect(error?.message).toContain("agents");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
