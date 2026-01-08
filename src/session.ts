import { promises as fs } from "fs";
import path from "path";
import { dump, load } from "js-yaml";

import { AgentStatus, Phase, SessionPaths, SessionState, Pl4nConfig } from "./models";
import { generateName } from "./names";
import { generateToken } from "./server/auth";

export class SessionManager {
  pl4nDir: string;
  sessionsDir: string;

  constructor(pl4nDir?: string) {
    this.pl4nDir = pl4nDir ?? ".pl4n";
    this.sessionsDir = path.join(this.pl4nDir, "sessions");
  }

  async createSession(task: string, config?: Pl4nConfig): Promise<SessionState> {
    const sessionId = await this.generateUniqueSessionId();
    const now = new Date();

    const paths = this.getPaths(sessionId);
    await fs.mkdir(paths.root, { recursive: true });
    await fs.mkdir(paths.turns, { recursive: true });
    await fs.mkdir(paths.agents, { recursive: true });
    await fs.mkdir(paths.plans, { recursive: true });

    const state = new SessionState({
      sessionId,
      task,
      turn: 1,
      phase: Phase.Initializing,
      createdAt: now,
      updatedAt: now,
      sessionToken: generateToken(),
    });

    const meta: Record<string, unknown> = {
      session_id: sessionId,
      task,
      created_at: now.toISOString(),
    };
    if (config) {
      meta.config = config.toConfigDict();
    }

    await fs.writeFile(paths.meta, dump(meta), "utf8");
    await this.saveState(state, false);

    return state;
  }

  async loadConfigSnapshot(sessionId: string): Promise<Pl4nConfig | null> {
    const paths = this.getPaths(sessionId);
    let metaContent: string;
    try {
      metaContent = await fs.readFile(paths.meta, "utf8");
    } catch {
      return null;
    }

    let meta: unknown;
    try {
      meta = load(metaContent);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse YAML";
      throw new Error(`Invalid session meta ${paths.meta}: ${message}`);
    }

    if (typeof meta !== "object" || meta === null) {
      return null;
    }

    const config = (meta as Record<string, unknown>).config;
    if (config === undefined) {
      return null;
    }

    return Pl4nConfig.fromConfigData(config, `${paths.meta} config`);
  }

  async loadSession(sessionId: string): Promise<SessionState | null> {
    const paths = this.getPaths(sessionId);
    try {
      await fs.access(paths.root);
    } catch {
      return null;
    }

    const metaContent = await fs.readFile(paths.meta, "utf8");
    const stateContent = await fs.readFile(paths.state, "utf8");

    let meta: { task: string; created_at: string };
    try {
      meta = load(metaContent) as { task: string; created_at: string };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse YAML";
      throw new Error(`Invalid session meta ${paths.meta}: ${message}`);
    }

    let stateData: {
      turn: number;
      phase: string;
      updated_at: string;
      session_token?: string;
      agents?: Record<string, string>;
      agent_plan_ids?: Record<string, string>;
      agent_errors?: Record<string, string>;
    };
    try {
      stateData = load(stateContent) as {
        turn: number;
        phase: string;
        updated_at: string;
        session_token?: string;
        agents?: Record<string, string>;
        agent_plan_ids?: Record<string, string>;
        agent_errors?: Record<string, string>;
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to parse YAML";
      throw new Error(`Invalid session state ${paths.state}: ${message}`);
    }

    return new SessionState({
      sessionId,
      task: meta.task,
      turn: stateData.turn,
      phase: stateData.phase as Phase,
      createdAt: new Date(meta.created_at),
      updatedAt: new Date(stateData.updated_at),
      agents: Object.fromEntries(
        Object.entries(stateData.agents ?? {}).map(([key, value]) => [key, value as AgentStatus]),
      ),
      agentPlanIds: stateData.agent_plan_ids ?? {},
      agentErrors: stateData.agent_errors ?? {},
      sessionToken: stateData.session_token,
    });
  }

  async saveState(state: SessionState, updateTimestamp = true): Promise<void> {
    if (updateTimestamp) {
      state.updatedAt = new Date();
    }

    const paths = this.getPaths(state.sessionId);
    const stateData: Record<string, unknown> = {
      turn: state.turn,
      phase: state.phase,
      updated_at: state.updatedAt.toISOString(),
      agents: Object.fromEntries(Object.entries(state.agents).map(([key, value]) => [key, value])),
      agent_plan_ids: state.agentPlanIds,
    };
    if (state.sessionToken) {
      stateData.session_token = state.sessionToken;
    }
    if (Object.keys(state.agentErrors).length > 0) {
      stateData.agent_errors = state.agentErrors;
    }

    await fs.writeFile(paths.state, dump(stateData), "utf8");
  }

  async listSessions(): Promise<SessionState[]> {
    try {
      await fs.access(this.sessionsDir);
    } catch {
      return [];
    }

    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true });
    const sessions: SessionState[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      try {
        const session = await this.loadSession(entry.name);
        if (session) {
          sessions.push(session);
        }
      } catch {
        // ignore invalid/missing session data
      }
    }

    return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  getPaths(sessionId: string): SessionPaths {
    return SessionPaths.fromRoot(path.join(this.sessionsDir, sessionId));
  }

  private async generateUniqueSessionId(): Promise<string> {
    for (let i = 0; i < 10; i += 1) {
      const sessionId = generateName();
      try {
        await fs.access(path.join(this.sessionsDir, sessionId));
      } catch {
        return sessionId;
      }
    }

    const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 4);
    return `${generateName()}-${suffix}`;
  }

  async cleanSession(sessionId: string): Promise<boolean> {
    const paths = this.getPaths(sessionId);
    try {
      await fs.access(paths.root);
    } catch {
      return false;
    }

    await fs.rm(paths.root, { recursive: true, force: true });
    return true;
  }

  async getCurrentTurnFile(sessionId: string): Promise<string | null> {
    const state = await this.loadSession(sessionId);
    if (!state) {
      return null;
    }

    const paths = this.getPaths(sessionId);
    return paths.turnFile(state.turn);
  }

  async ensureSessionToken(sessionId: string): Promise<string> {
    const state = await this.loadSession(sessionId);
    if (!state) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (state.sessionToken) {
      return state.sessionToken;
    }
    state.sessionToken = generateToken();
    await this.saveState(state, false);
    return state.sessionToken;
  }

  async hasQuestions(sessionId: string): Promise<boolean> {
    const turnFile = await this.getCurrentTurnFile(sessionId);
    if (!turnFile) {
      return false;
    }

    try {
      await fs.access(turnFile);
    } catch {
      return false;
    }

    const content = await fs.readFile(turnFile, "utf8");
    if (!content.includes("## Questions")) {
      return false;
    }

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim().startsWith("**Answer:**")) {
        const answerContent = line.replace("**Answer:**", "").trim();
        if (!answerContent) {
          if (i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            const isEmpty = nextLine.length === 0;
            const isSection = nextLine.startsWith("###") || nextLine.startsWith("---");
            if (isEmpty || isSection) {
              return true;
            }
          } else {
            return true;
          }
        }
      }
    }

    return false;
  }
}
