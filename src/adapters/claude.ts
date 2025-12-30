import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";

import type { AgentConfig } from "../models";
import { AgentAdapter, AgentHandle } from "./base";

async function readSessionId(sessionFile?: string): Promise<string | null> {
  if (!sessionFile) {
    return null;
  }
  try {
    const content = await fs.readFile(sessionFile, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function readSessionIdSync(sessionFile?: string): string | null {
  if (!sessionFile) {
    return null;
  }
  try {
    const content = fsSync.readFileSync(sessionFile, "utf8");
    const trimmed = content.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function writeSessionId(
  sessionFile: string | undefined,
  sessionId: string | null,
): Promise<void> {
  if (!sessionFile || !sessionId) {
    return;
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const tempFile = `${sessionFile}.tmp`;
  await fs.writeFile(tempFile, sessionId, "utf8");
  await fs.rename(tempFile, sessionFile);
}

const DEFAULT_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Bash(git:*)",
  "Bash(ls:*)",
  "Bash(find:*)",
  "Bash(cat:*)",
  "Bash(head:*)",
  "Bash(tail:*)",
  "Bash(wc:*)",
  "Bash(grep:*)",
  "Bash(rg:*)",
  "Bash(tree:*)",
  "Bash(file:*)",
  "Bash(stat:*)",
  "Bash(du:*)",
  "Bash(pwd:*)",
  "Bash(echo:*)",
  "Bash(which:*)",
  "Bash(env:*)",
  "Bash(python:*)",
  "Bash(python3:*)",
  "Bash(node:*)",
  "Bash(npm:*)",
  "Bash(pnpm:*)",
  "Bash(yarn:*)",
  "Bash(pip:*)",
  "Bash(uv:*)",
  "Bash(cargo:*)",
  "Bash(go:*)",
  "Bash(make:*)",
  "Bash(jq:*)",
  "Bash(curl:*)",
  "Bash(diff:*)",
  "Bash(sort:*)",
  "Bash(uniq:*)",
  "Bash(xargs:*)",
  "Bash(sed:*)",
  "Bash(awk:*)",
];

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
    cmd.push("--add-dir", projectRoot);
    const allowedTools = config.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
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

async function streamToLog(params: {
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  logFile: string;
  appendLog: boolean;
}): Promise<{ stdoutText: string; stderrText: string }> {
  const { stdout, stderr, logFile, appendLog } = params;
  await fs.mkdir(path.dirname(logFile), { recursive: true });

  if (appendLog) {
    const header = `\n${"=".repeat(60)}\n=== New run ===\n${"=".repeat(60)}\n\n`;
    await fs.appendFile(logFile, header, "utf8");
  } else {
    await fs.writeFile(logFile, "", "utf8");
  }

  const decoder = new TextDecoder();

  const readStream = async (stream: ReadableStream<Uint8Array> | null): Promise<string> => {
    if (!stream) {
      return "";
    }
    const reader = stream.getReader();
    let output = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value);
      output += chunk;
      await fs.appendFile(logFile, chunk, "utf8");
    }
    return output;
  };

  const [stdoutText, stderrText] = await Promise.all([readStream(stdout), readStream(stderr)]);

  return { stdoutText, stderrText };
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
    const cmd = buildCmd(this.config, prompt, sessionId);

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
    const cmd = buildCmd(this.config, prompt, sessionId, worktree);
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
    timeout?: number;
    sessionFile?: string;
    appendLog?: boolean;
  }): Promise<[boolean, string]> {
    const sessionId = await readSessionId(params.sessionFile);
    const cmd = buildCmd(this.config, params.prompt, sessionId, params.worktree);

    const proc = Bun.spawn({
      cmd,
      cwd: params.worktree,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutMs = params.timeout ? params.timeout * 1000 : null;
    let timedOut = false;

    const outputPromise = streamToLog({
      stdout: proc.stdout,
      stderr: proc.stderr,
      logFile: params.logFile,
      appendLog: params.appendLog ?? false,
    });

    const exitPromise = proc.exited;
    const timeoutPromise =
      timeoutMs === null
        ? null
        : new Promise<void>((_, reject) => {
            setTimeout(() => {
              timedOut = true;
              proc.kill();
              reject(new Error("Timeout expired"));
            }, timeoutMs);
          });

    try {
      if (timeoutPromise) {
        await Promise.race([exitPromise, timeoutPromise]);
      } else {
        await exitPromise;
      }
    } catch {
      // handled below
    }

    const { stdoutText, stderrText } = await outputPromise;
    const fullOutput = stdoutText + stderrText;

    if (timedOut) {
      return [false, "Timeout expired"];
    }

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
