import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";

import type { AgentConfig } from "../models";
import { DEFAULT_CLAUDE_ALLOWED_TOOLS } from "../defaults";
import { AgentAdapter, AgentHandle } from "./base";
import { readSessionId, readSessionIdSync, writeSessionId } from "./session-file";
import { streamToLog } from "./stream-utils";

const DEFAULT_ALLOWED_TOOLS = DEFAULT_CLAUDE_ALLOWED_TOOLS;

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

function shouldPreferOutput(config: AgentConfig): boolean {
  const allowedTools = config.claude?.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
  return !allowedTools.some((tool) => WRITE_TOOLS.has(tool));
}

function applyThinking(config: AgentConfig, prompt: string): string {
  // Claude Code triggers extended thinking via magic words in the prompt:
  // "ultrathink" = 31,999 tokens, "megathink"/"think hard" = 10,000, "think" = 4,000
  if (!config.thinking) {
    return prompt;
  }
  return `${config.thinking}\n\n${prompt}`;
}

function buildCmd(
  config: AgentConfig,
  prompt: string,
  sessionId?: string | null,
  projectRoot?: string | null,
): string[] {
  const cmd = ["claude", "--print", "--output-format", "json"];

  if (config.model) {
    cmd.push("--model", config.model);
  }

  if (projectRoot) {
    const addDirs = [projectRoot, ...(config.claude?.addDir ?? [])];
    for (const dir of addDirs) {
      cmd.push("--add-dir", dir);
    }
    const allowedTools = config.claude?.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    if (allowedTools.length > 0) {
      cmd.push("--allowedTools", ...allowedTools);
    }
  } else if (config.claude?.addDir && config.claude.addDir.length > 0) {
    for (const dir of config.claude.addDir) {
      cmd.push("--add-dir", dir);
    }
    const allowedTools = config.claude.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    if (allowedTools.length > 0) {
      cmd.push("--allowedTools", ...allowedTools);
    }
  }

  if (sessionId) {
    cmd.push("--resume", sessionId);
  }

  cmd.push("-p", prompt);
  return cmd;
}

export class ClaudeCodeAdapter extends AgentAdapter {
  spawn(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
  }): AgentHandle {
    const { worktree, prompt, logFile, sessionFile } = params;
    const sessionId = readSessionIdSync(sessionFile);
    const finalPrompt = applyThinking(this.config, prompt);
    const cmd = buildCmd(this.config, finalPrompt, sessionId);

    // Create log file synchronously before spawning to avoid race conditions
    fsSync.mkdirSync(path.dirname(logFile), { recursive: true });
    fsSync.writeFileSync(logFile, "", "utf8");

    const proc = Bun.spawn({
      cmd,
      cwd: worktree,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    void streamToLog({ stdout: proc.stdout, stderr: proc.stderr, logFile, appendLog: false });

    return new AgentHandle(this.config.id, proc, logFile);
  }

  getName(): string {
    return `Claude Code (${this.config.model})`;
  }
}

export class ClaudeCodeSyncAdapter extends AgentAdapter {
  spawn(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
  }): AgentHandle {
    const { worktree, prompt, logFile, sessionFile } = params;
    const sessionId = readSessionIdSync(sessionFile);
    const finalPrompt = applyThinking(this.config, prompt);
    const cmd = buildCmd(this.config, finalPrompt, sessionId, worktree);

    // Create log file synchronously before spawning to avoid race conditions
    fsSync.mkdirSync(path.dirname(logFile), { recursive: true });
    fsSync.writeFileSync(logFile, "", "utf8");

    const proc = Bun.spawn({
      cmd,
      cwd: worktree,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    void streamToLog({ stdout: proc.stdout, stderr: proc.stderr, logFile, appendLog: false });
    return new AgentHandle(this.config.id, proc, logFile);
  }

  async runSync(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
    appendLog?: boolean;
  }): Promise<[boolean, string]> {
    const sessionId = await readSessionId(params.sessionFile);
    const finalPrompt = applyThinking(this.config, params.prompt);
    const cmd = buildCmd(this.config, finalPrompt, sessionId, params.worktree);

    const proc = Bun.spawn({
      cmd,
      cwd: params.worktree,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const outputPromise = streamToLog({
      stdout: proc.stdout,
      stderr: proc.stderr,
      logFile: params.logFile,
      appendLog: params.appendLog ?? false,
    });

    try {
      await proc.exited;
    } catch {
      // handled below
    }

    const { stdoutText, stderrText } = await outputPromise;
    const fullOutput = stdoutText + stderrText;

    let outputText = stdoutText || fullOutput;
    let newSessionId: string | null = null;

    try {
      const data = JSON.parse(outputText);
      newSessionId = data.session_id ?? null;
      outputText = data.result ?? outputText;
    } catch {
      // Fall back to raw output
    }

    await writeSessionId(params.sessionFile, newSessionId);

    if (proc.exitCode === 0) {
      if (shouldPreferOutput(this.config) && outputText.trim().length > 0) {
        try {
          await fs.writeFile(params.outputFile, outputText, "utf8");
        } catch {
          // fall through with output
        }
        return [true, outputText];
      }
      try {
        const file = Bun.file(params.outputFile);
        const exists = await file.exists();
        if (!exists) {
          await fs.writeFile(params.outputFile, outputText, "utf8");
          return [true, outputText];
        }

        const stat = await fs.stat(params.outputFile);
        if (stat.size === 0) {
          await fs.writeFile(params.outputFile, outputText, "utf8");
          return [true, outputText];
        }

        return [true, await fs.readFile(params.outputFile, "utf8")];
      } catch {
        return [true, outputText];
      }
    }

    return [false, fullOutput || "Unknown error"];
  }

  getName(): string {
    return `Claude Code Sync (${this.config.model})`;
  }
}
