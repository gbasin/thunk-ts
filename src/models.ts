import { promises as fs } from "fs";
import path from "path";
import { load as loadYaml } from "js-yaml";

export enum Phase {
  Initializing = "initializing",
  Drafting = "drafting",
  PeerReview = "peer_review",
  Synthesizing = "synthesizing",
  UserReview = "user_review",
  Approved = "approved",
  Error = "error",
}

export enum AgentStatus {
  Pending = "pending",
  Working = "working",
  Done = "done",
  Error = "error",
}

export interface AgentConfig {
  id: string;
  type: string;
  model: string;
  thinking?: string;
  allowedTools?: string[];
  enabled?: boolean;
}

export type AgentStatusMap = Record<string, AgentStatus>;
export type AgentPlanIdMap = Record<string, string>;

type ThunkConfigParams = {
  agents: AgentConfig[];
  synthesizer: AgentConfig;
  timeout?: number;
};

function defaultConfigParams(): ThunkConfigParams {
  return {
    agents: [
      { id: "opus", type: "claude", model: "opus", enabled: true },
      { id: "codex", type: "codex", model: "codex-5.2", thinking: "xmax", enabled: true },
    ],
    synthesizer: { id: "synthesizer", type: "claude", model: "opus", enabled: true },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseEnabled(value: unknown, field: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean`);
  }
  return value;
}

function parseTimeout(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) {
    throw new Error("timeout must be a finite number");
  }
  if (value < 0) {
    throw new Error("timeout must be a non-negative number");
  }
  return value;
}

function parseAllowedTools(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a list`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must include at least one entry`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function parseAgentConfig(
  value: unknown,
  field: string,
  defaultAllowedTools?: string[],
): AgentConfig {
  if (!isRecord(value)) {
    throw new Error(`${field} must be a mapping`);
  }
  const allowedToolsValue = value.allowed_tools ?? value.allowedTools;
  return {
    id: requireString(value.id, `${field}.id`),
    type: requireString(value.type, `${field}.type`),
    model: requireString(value.model, `${field}.model`),
    thinking: optionalString(value.thinking, `${field}.thinking`),
    allowedTools:
      allowedToolsValue === undefined
        ? defaultAllowedTools
        : parseAllowedTools(allowedToolsValue, `${field}.allowed_tools`),
    enabled: parseEnabled(value.enabled, `${field}.enabled`),
  };
}

function parseAgents(value: unknown, defaultAllowedTools?: string[]): AgentConfig[] {
  if (!Array.isArray(value)) {
    throw new Error("agents must be a list");
  }
  if (value.length === 0) {
    throw new Error("agents must include at least one entry");
  }

  const agents = value.map((entry, index) =>
    parseAgentConfig(entry, `agents[${index}]`, defaultAllowedTools),
  );
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw new Error(`agents contains duplicate id: ${agent.id}`);
    }
    ids.add(agent.id);
  }
  if (!agents.some((agent) => agent.enabled)) {
    throw new Error("agents must include at least one enabled agent");
  }
  return agents;
}

function applyAllowedTools(agents: AgentConfig[], allowedTools?: string[]): AgentConfig[] {
  if (!allowedTools) {
    return agents;
  }
  return agents.map((agent) => ({ ...agent, allowedTools }));
}

function applyAllowedToolsToAgent(agent: AgentConfig, allowedTools?: string[]): AgentConfig {
  if (!allowedTools) {
    return agent;
  }
  return { ...agent, allowedTools };
}

function parseThunkConfig(value: unknown): ThunkConfigParams {
  if (!isRecord(value)) {
    throw new Error("config must be a mapping");
  }

  const defaults = defaultConfigParams();
  const allowedToolsValue = value.allowed_tools ?? value.allowedTools;
  const allowedToolsDefault =
    allowedToolsValue === undefined
      ? undefined
      : parseAllowedTools(allowedToolsValue, "allowed_tools");
  const agents =
    value.agents === undefined
      ? applyAllowedTools(defaults.agents, allowedToolsDefault)
      : parseAgents(value.agents, allowedToolsDefault);
  const synthesizer =
    value.synthesizer === undefined
      ? applyAllowedToolsToAgent(defaults.synthesizer, allowedToolsDefault)
      : parseAgentConfig(value.synthesizer, "synthesizer", allowedToolsDefault);
  const timeout = value.timeout === undefined ? undefined : parseTimeout(value.timeout);

  return { agents, synthesizer, timeout };
}

async function resolveConfigPath(thunkDir: string): Promise<string | null> {
  const candidates = ["thunk.yaml", "thunk.yml"];
  for (const candidate of candidates) {
    const fullPath = path.join(thunkDir, candidate);
    try {
      await fs.access(fullPath);
      return fullPath;
    } catch {
      // try next candidate
    }
  }
  return null;
}

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
      agents: Object.fromEntries(Object.entries(this.agents).map(([key, value]) => [key, value])),
      agent_plan_ids: this.agentPlanIds,
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

  constructor(params: ThunkConfigParams) {
    this.agents = params.agents;
    this.synthesizer = params.synthesizer;
    this.timeout = params.timeout;
  }

  static default(): ThunkConfig {
    return new ThunkConfig(defaultConfigParams());
  }

  static async loadFromThunkDir(thunkDir: string): Promise<ThunkConfig> {
    const configPath = await resolveConfigPath(thunkDir);
    if (!configPath) {
      return ThunkConfig.default();
    }
    return ThunkConfig.loadFromFile(configPath);
  }

  static async loadFromFile(configPath: string): Promise<ThunkConfig> {
    const content = await fs.readFile(configPath, "utf8");
    let data: unknown;
    try {
      data = loadYaml(content);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse YAML";
      throw new Error(`Invalid config ${configPath}: ${message}`);
    }

    if (data === undefined || data === null) {
      throw new Error(`Invalid config ${configPath}: file is empty`);
    }

    try {
      const parsed = parseThunkConfig(data);
      return new ThunkConfig(parsed);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid config";
      throw new Error(`Invalid config ${configPath}: ${message}`);
    }
  }

  toConfigDict(): Record<string, unknown> {
    const serializeAgent = (agent: AgentConfig): Record<string, unknown> => {
      const data: Record<string, unknown> = {
        id: agent.id,
        type: agent.type,
        model: agent.model,
      };
      if (agent.thinking) {
        data.thinking = agent.thinking;
      }
      if (agent.allowedTools && agent.allowedTools.length > 0) {
        data.allowed_tools = agent.allowedTools;
      }
      if (agent.enabled !== undefined) {
        data.enabled = agent.enabled;
      }
      return data;
    };

    const config: Record<string, unknown> = {
      agents: this.agents.map((agent) => serializeAgent(agent)),
      synthesizer: serializeAgent(this.synthesizer),
    };
    if (this.timeout !== undefined) {
      config.timeout = this.timeout;
    }
    return config;
  }
}
