import path from "path";
import { describe, expect, it } from "bun:test";

import {
  AgentStatus,
  Phase,
  SessionPaths,
  SessionState,
  ThunkConfig
} from "../src/models";

describe("Phase", () => {
  it("has expected values", () => {
    expect(Phase.Initializing).toBe("initializing");
    expect(Phase.Drafting).toBe("drafting");
    expect(Phase.PeerReview).toBe("peer_review");
    expect(Phase.Synthesizing).toBe("synthesizing");
    expect(Phase.UserReview).toBe("user_review");
    expect(Phase.Approved).toBe("approved");
    expect(Phase.Error).toBe("error");
  });
});

describe("AgentStatus", () => {
  it("has expected values", () => {
    expect(AgentStatus.Pending).toBe("pending");
    expect(AgentStatus.Working).toBe("working");
    expect(AgentStatus.Done).toBe("done");
    expect(AgentStatus.Error).toBe("error");
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
      agentPlanIds: { opus: "sunny-glade" }
    });

    const dict = state.toDict();

    expect(dict.session_id).toBe("test-session");
    expect(dict.task).toBe("Test task");
    expect(dict.turn).toBe(2);
    expect(dict.phase).toBe("user_review");
    expect(dict.agents).toEqual({ opus: "done" });
    expect(dict.agent_plan_ids).toEqual({ opus: "sunny-glade" });
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
    expect(paths.agentLogFile("sunny-glade")).toBe(
      path.join(root, "agents", "sunny-glade.log")
    );
    expect(paths.agentSessionFile("sunny-glade")).toBe(
      path.join(root, "agents", "sunny-glade", "cli_session_id.txt")
    );
    expect(paths.agentDir("sunny-glade")).toBe(path.join(root, "agents", "sunny-glade"));
  });
});

describe("ThunkConfig", () => {
  it("builds default config", () => {
    const config = ThunkConfig.default();
    expect(config.agents.length).toBe(2);
    expect(config.agents[0].id).toBe("opus");
    expect(config.agents[1].id).toBe("codex");
    expect(config.synthesizer.id).toBe("synthesizer");
    expect(config.timeout).toBeUndefined();
  });
});
