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
    timeout?: number;
    sessionFile?: string;
    appendLog?: boolean;
  }): Promise<[boolean, string]> {
    const handle = this.spawn({
      worktree: params.worktree,
      prompt: params.prompt,
      outputFile: params.outputFile,
      logFile: params.logFile,
      sessionFile: params.sessionFile
    });

    let timedOut = false;
    const timeoutMs = params.timeout ? params.timeout * 1000 : null;

    const waitPromise = handle.process.exited;
    const timeoutPromise =
      timeoutMs === null
        ? null
        : new Promise<void>((_, reject) => {
            setTimeout(() => {
              timedOut = true;
              handle.process.kill();
              reject(new Error("Timeout expired"));
            }, timeoutMs);
          });

    try {
      if (timeoutPromise) {
        await Promise.race([waitPromise, timeoutPromise]);
      } else {
        await waitPromise;
      }
    } catch {
      if (timedOut) {
        return [false, "Timeout expired"];
      }
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
