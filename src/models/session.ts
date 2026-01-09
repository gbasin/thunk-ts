/**
 * Session state and path management classes
 */

import path from "path";

import { Phase } from "./enums";
import type { AgentStatusMap, AgentPlanIdMap, AgentErrorMap } from "./types";

export class SessionState {
  sessionId: string;
  task: string;
  turn: number;
  phase: Phase;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
  agents: AgentStatusMap;
  agentPlanIds: AgentPlanIdMap;
  agentErrors: AgentErrorMap;
  sessionToken?: string;

  constructor(params: {
    sessionId: string;
    task: string;
    turn: number;
    phase: Phase;
    createdAt: Date;
    updatedAt: Date;
    archived?: boolean;
    agents?: AgentStatusMap;
    agentPlanIds?: AgentPlanIdMap;
    agentErrors?: AgentErrorMap;
    sessionToken?: string;
  }) {
    this.sessionId = params.sessionId;
    this.task = params.task;
    this.turn = params.turn;
    this.phase = params.phase;
    this.createdAt = params.createdAt;
    this.updatedAt = params.updatedAt;
    this.archived = params.archived ?? false;
    this.agents = params.agents ?? {};
    this.agentPlanIds = params.agentPlanIds ?? {};
    this.agentErrors = params.agentErrors ?? {};
    this.sessionToken = params.sessionToken;
  }

  toDict(): Record<string, unknown> {
    const dict: Record<string, unknown> = {
      session_id: this.sessionId,
      task: this.task,
      turn: this.turn,
      phase: this.phase,
      created_at: this.createdAt.toISOString(),
      updated_at: this.updatedAt.toISOString(),
      archived: this.archived,
      agents: Object.fromEntries(Object.entries(this.agents).map(([key, value]) => [key, value])),
      agent_plan_ids: this.agentPlanIds,
    };
    if (this.sessionToken) {
      dict.session_token = this.sessionToken;
    }
    if (Object.keys(this.agentErrors).length > 0) {
      dict.agent_errors = this.agentErrors;
    }
    return dict;
  }
}

export class SessionPaths {
  root: string;
  meta: string;
  state: string;
  input: string;
  turns: string;
  agents: string;
  plans: string;

  constructor(root: string) {
    this.root = root;
    this.meta = path.join(root, "meta.yaml");
    this.state = path.join(root, "state.yaml");
    this.input = path.join(root, "input.md");
    this.turns = path.join(root, "turns");
    this.agents = path.join(root, "agents");
    this.plans = path.join(root, "plans");
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
    return path.join(this.plans, `${planId}.md`);
  }

  agentLogFile(planId: string): string {
    return path.join(this.agents, planId, "agent.log");
  }

  agentSessionFile(planId: string): string {
    return path.join(this.agents, planId, "session.txt");
  }

  agentDir(planId: string): string {
    return path.join(this.agents, planId);
  }
}
