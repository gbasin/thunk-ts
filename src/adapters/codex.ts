import { promises as fs } from "fs";
import fsSync from "fs";
import path from "path";

import type { AgentConfig } from "../models";
import { AgentAdapter, AgentHandle } from "./base";

async function readThreadId(sessionFile?: string): Promise<string | null> {
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

function readThreadIdSync(sessionFile?: string): string | null {
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

async function writeThreadId(sessionFile: string | undefined, threadId: string | null): Promise<void> {
  if (!sessionFile || !threadId) {
    return;
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const tempFile = `${sessionFile}.tmp`;
  await fs.writeFile(tempFile, threadId, "utf8");
  await fs.rename(tempFile, sessionFile);
}

function buildCmd(
  _config: AgentConfig,
  prompt: string,
  threadId?: string | null,
  projectRoot?: string | null
): string[] {
  const cmd = ["codex", "exec", "--json", "--full-auto"];
  if (projectRoot) {
    cmd.push("--add-dir", projectRoot);
  }
  if (threadId) {
    cmd.push("resume", threadId, prompt);
    return cmd;
  }
  cmd.push(prompt);
  return cmd;
}

function parseCodexOutput(stdout: string): { threadId: string | null; finalOutput: string } {
  let threadId: string | null = null;
  const messages: string[] = [];

  for (const line of stdout.trim().split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "thread.started") {
        threadId = event.thread_id as string;
      } else if (event.type === "item.message" && event.role === "assistant") {
        const content = event.content;
        if (typeof content === "string" && content.length > 0) {
          messages.push(content);
        }
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  const finalOutput = messages.length > 0 ? messages[messages.length - 1] : stdout;
  return { threadId, finalOutput };
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

  const [stdoutText, stderrText] = await Promise.all([
    readStream(stdout),
    readStream(stderr)
  ]);

  return { stdoutText, stderrText };
}

export class CodexCLIAdapter extends AgentAdapter {
  spawn(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
  }): AgentHandle {
    const { worktree, prompt, logFile, sessionFile } = params;
    const threadId = readThreadIdSync(sessionFile);
    const cmd = buildCmd(this.config, prompt, threadId, worktree);
    const process = Bun.spawn({ cmd, cwd: worktree, stdout: "pipe", stderr: "pipe" });
    void streamToLog({ stdout: process.stdout, stderr: process.stderr, logFile, appendLog: false });
    return new AgentHandle(this.config.id, process, logFile);
  }

  getName(): string {
    return `Codex CLI (${this.config.model})`;
  }
}

export class CodexCLISyncAdapter extends AgentAdapter {
  spawn(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
  }): AgentHandle {
    const { worktree, prompt, logFile, sessionFile } = params;
    const threadId = readThreadIdSync(sessionFile);
    const cmd = buildCmd(this.config, prompt, threadId, worktree);
    const process = Bun.spawn({ cmd, cwd: worktree, stdout: "pipe", stderr: "pipe" });
    void streamToLog({ stdout: process.stdout, stderr: process.stderr, logFile, appendLog: false });
    return new AgentHandle(this.config.id, process, logFile);
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
    const threadId = await readThreadId(params.sessionFile);
    const cmd = buildCmd(this.config, params.prompt, threadId, params.worktree);

    const proc = Bun.spawn({
      cmd,
      cwd: params.worktree,
      stdout: "pipe",
      stderr: "pipe"
    });

    const timeoutMs = params.timeout ? params.timeout * 1000 : null;
    let timedOut = false;

    const outputPromise = streamToLog({
      stdout: proc.stdout,
      stderr: proc.stderr,
      logFile: params.logFile,
      appendLog: params.appendLog ?? false
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

    const { threadId: newThreadId, finalOutput } = parseCodexOutput(stdoutText || fullOutput);
    await writeThreadId(params.sessionFile, newThreadId);

    if (proc.exitCode === 0) {
      try {
        const file = Bun.file(params.outputFile);
        if (!(await file.exists()) || file.size === 0) {
          await fs.writeFile(params.outputFile, finalOutput, "utf8");
        }
        return [true, await file.text()];
      } catch {
        return [true, finalOutput];
      }
    }

    return [false, fullOutput || "Unknown error"];
  }

  getName(): string {
    return `Codex CLI Sync (${this.config.model})`;
  }
}
