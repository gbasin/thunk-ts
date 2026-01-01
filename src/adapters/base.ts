import type { AgentConfig, AgentStatus } from "../models";
import { AgentStatus as AgentStatusEnum } from "../models";

export class AgentHandle {
  agentId: string;
  process: Bun.Subprocess;
  logFile: string;

  constructor(agentId: string, process: Bun.Subprocess, logFile: string) {
    this.agentId = agentId;
    this.process = process;
    this.logFile = logFile;
  }

  isRunning(): boolean {
    return this.process.exitCode === null;
  }

  getStatus(): AgentStatus {
    if (this.isRunning()) {
      return AgentStatusEnum.Working;
    }
    if (this.process.exitCode === 0) {
      return AgentStatusEnum.Done;
    }
    return AgentStatusEnum.Error;
  }
}

export abstract class AgentAdapter {
  config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  abstract spawn(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
  }): AgentHandle;

  async runSync(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
    appendLog?: boolean;
  }): Promise<[boolean, string]> {
    const handle = this.spawn({
      worktree: params.worktree,
      prompt: params.prompt,
      outputFile: params.outputFile,
      logFile: params.logFile,
      sessionFile: params.sessionFile,
    });

    try {
      await handle.process.exited;
    } catch {
      // fall through with output handling
    }

    try {
      const output = await Bun.file(params.outputFile).text();
      return [true, output];
    } catch {
      return [false, "No output produced"];
    }
  }

  abstract getName(): string;
}
