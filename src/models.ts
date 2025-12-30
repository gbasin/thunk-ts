import path from "path";

export enum Phase {
  Initializing = "initializing",
  Drafting = "drafting",
  PeerReview = "peer_review",
  Synthesizing = "synthesizing",
  UserReview = "user_review",
  Approved = "approved",
  Error = "error"
}

export enum AgentStatus {
  Pending = "pending",
  Working = "working",
  Done = "done",
  Error = "error"
}

export interface AgentConfig {
  id: string;
  type: string;
  model: string;
  enabled?: boolean;
}

export type AgentStatusMap = Record<string, AgentStatus>;
export type AgentPlanIdMap = Record<string, string>;

export class SessionState {
  sessionId: string;
  task: string;
  turn: number;
  phase: Phase;
  createdAt: Date;
  updatedAt: Date;
  agents: AgentStatusMap;
  agentPlanIds: AgentPlanIdMap;

  constructor(params: {
    sessionId: string;
    task: string;
    turn: number;
    phase: Phase;
    createdAt: Date;
    updatedAt: Date;
    agents?: AgentStatusMap;
    agentPlanIds?: AgentPlanIdMap;
  }) {
    this.sessionId = params.sessionId;
    this.task = params.task;
    this.turn = params.turn;
    this.phase = params.phase;
    this.createdAt = params.createdAt;
    this.updatedAt = params.updatedAt;
    this.agents = params.agents ?? {};
    this.agentPlanIds = params.agentPlanIds ?? {};
  }

  toDict(): Record<string, unknown> {
    return {
      session_id: this.sessionId,
      task: this.task,
      turn: this.turn,
      phase: this.phase,
      created_at: this.createdAt.toISOString(),
      updated_at: this.updatedAt.toISOString(),
      agents: Object.fromEntries(
        Object.entries(this.agents).map(([key, value]) => [key, value])
      ),
      agent_plan_ids: this.agentPlanIds
    };
  }
}

export class SessionPaths {
  root: string;
  meta: string;
  state: string;
  turns: string;
  agents: string;

  constructor(root: string) {
    this.root = root;
    this.meta = path.join(root, "meta.yaml");
    this.state = path.join(root, "state.yaml");
    this.turns = path.join(root, "turns");
    this.agents = path.join(root, "agents");
  }

  static fromRoot(root: string): SessionPaths {
    return new SessionPaths(root);
  }

  turnFile(turn: number): string {
    return path.join(this.turns, `${String(turn).padStart(3, "0")}.md`);
  }

  turnSnapshotDir(turn: number): string {
    return path.join(this.turns, `${String(turn).padStart(3, "0")}`);
  }

  agentPlanFile(planId: string): string {
    return path.join(this.root, `${planId}.md`);
  }

  agentLogFile(planId: string): string {
    return path.join(this.agents, `${planId}.log`);
  }

  agentSessionFile(planId: string): string {
    return path.join(this.agents, planId, "cli_session_id.txt");
  }

  agentDir(planId: string): string {
    return path.join(this.agents, planId);
  }
}

export class ThunkConfig {
  agents: AgentConfig[];
  synthesizer: AgentConfig;
  timeout?: number;

  constructor(params: { agents: AgentConfig[]; synthesizer: AgentConfig; timeout?: number }) {
    this.agents = params.agents;
    this.synthesizer = params.synthesizer;
    this.timeout = params.timeout;
  }

  static default(): ThunkConfig {
    return new ThunkConfig({
      agents: [
        { id: "opus", type: "claude", model: "opus", enabled: true },
        { id: "codex", type: "codex", model: "codex-mini-latest", enabled: true }
      ],
      synthesizer: { id: "synthesizer", type: "claude", model: "opus", enabled: true }
    });
  }
}
