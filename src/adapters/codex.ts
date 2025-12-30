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

async function writeThreadId(
  sessionFile: string | undefined,
  threadId: string | null,
): Promise<void> {
  if (!sessionFile || !threadId) {
    return;
  }
  await fs.mkdir(path.dirname(sessionFile), { recursive: true });
  const tempFile = `${sessionFile}.tmp`;
  await fs.writeFile(tempFile, threadId, "utf8");
  await fs.rename(tempFile, sessionFile);
}

function resolveCodexConfigPath(params: {
  sessionFile?: string;
  logFile?: string;
  outputFile?: string;
  worktree?: string;
}): string {
  const baseDir = params.sessionFile
    ? path.dirname(params.sessionFile)
    : params.logFile
      ? path.dirname(params.logFile)
      : params.outputFile
        ? path.dirname(params.outputFile)
        : (params.worktree ?? ".");
  return path.join(baseDir, "codex.config.json");
}

function buildCodexConfigData(codexConfig: AgentConfig["codex"]): Record<string, unknown> | null {
  if (!codexConfig) {
    return null;
  }
  const data: Record<string, unknown> = codexConfig.config ? { ...codexConfig.config } : {};
  if (codexConfig.mcp !== undefined) {
    if ("mcp" in data) {
      throw new Error("codex.mcp conflicts with codex.config.mcp");
    }
    data.mcp = codexConfig.mcp;
  }
  return Object.keys(data).length > 0 ? data : null;
}

function writeCodexConfigFileSync(configPath: string, data: Record<string, unknown>): void {
  fsSync.mkdirSync(path.dirname(configPath), { recursive: true });
  fsSync.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf8");
}

async function writeCodexConfigFile(
  configPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(data, null, 2), "utf8");
}

function buildCmd(
  config: AgentConfig,
  prompt: string,
  threadId?: string | null,
  projectRoot?: string | null,
  codexConfigPath?: string | null,
): string[] {
  const cmd = ["codex", "exec", "--json"];
  if (config.model) {
    cmd.push("--model", config.model);
  }
  if (config.thinking) {
    cmd.push("--thinking", config.thinking);
  }
  if (codexConfigPath) {
    cmd.push("--config", codexConfigPath);
  }

  const codexConfig = config.codex;

  if (codexConfig?.search) {
    cmd.push("--search");
  }

  if (codexConfig?.dangerouslyBypass) {
    cmd.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    const hasSandboxConfig = Boolean(codexConfig?.sandbox || codexConfig?.approvalPolicy);
    const fullAuto = codexConfig?.fullAuto ?? true;
    if (fullAuto && !hasSandboxConfig) {
      cmd.push("--full-auto");
    }
    if (codexConfig?.sandbox) {
      cmd.push("--sandbox", codexConfig.sandbox);
    }
    if (codexConfig?.approvalPolicy) {
      cmd.push("--ask-for-approval", codexConfig.approvalPolicy);
    }
  }

  if (projectRoot) {
    cmd.push("--add-dir", projectRoot);
  }
  if (codexConfig?.addDir) {
    for (const dir of codexConfig.addDir) {
      cmd.push("--add-dir", dir);
    }
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

function shouldPreferOutput(config: AgentConfig): boolean {
  const codexConfig = config.codex;
  if (codexConfig?.dangerouslyBypass) {
    return false;
  }
  return codexConfig?.sandbox === "read-only";
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

export class CodexCLIAdapter extends AgentAdapter {
  spawn(params: {
    worktree: string;
    prompt: string;
    outputFile: string;
    logFile: string;
    sessionFile?: string;
  }): AgentHandle {
    const { worktree, prompt, logFile, sessionFile, outputFile } = params;
    const threadId = readThreadIdSync(sessionFile);
    const codexConfig = buildCodexConfigData(this.config.codex);
    const codexConfigPath = codexConfig
      ? resolveCodexConfigPath({ sessionFile, logFile, outputFile, worktree })
      : null;
    if (codexConfig && codexConfigPath) {
      writeCodexConfigFileSync(codexConfigPath, codexConfig);
    }
    const cmd = buildCmd(this.config, prompt, threadId, worktree, codexConfigPath);
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
    const { worktree, prompt, logFile, sessionFile, outputFile } = params;
    const threadId = readThreadIdSync(sessionFile);
    const codexConfig = buildCodexConfigData(this.config.codex);
    const codexConfigPath = codexConfig
      ? resolveCodexConfigPath({ sessionFile, logFile, outputFile, worktree })
      : null;
    if (codexConfig && codexConfigPath) {
      writeCodexConfigFileSync(codexConfigPath, codexConfig);
    }
    const cmd = buildCmd(this.config, prompt, threadId, worktree, codexConfigPath);
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
    const threadId = await readThreadId(params.sessionFile);
    const codexConfig = buildCodexConfigData(this.config.codex);
    const codexConfigPath = codexConfig
      ? resolveCodexConfigPath({
          sessionFile: params.sessionFile,
          logFile: params.logFile,
          outputFile: params.outputFile,
          worktree: params.worktree,
        })
      : null;
    if (codexConfig && codexConfigPath) {
      await writeCodexConfigFile(codexConfigPath, codexConfig);
    }
    const cmd = buildCmd(this.config, params.prompt, threadId, params.worktree, codexConfigPath);

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

    const { threadId: newThreadId, finalOutput } = parseCodexOutput(stdoutText || fullOutput);
    await writeThreadId(params.sessionFile, newThreadId);

    if (proc.exitCode === 0) {
      if (shouldPreferOutput(this.config) && finalOutput.trim().length > 0) {
        try {
          await fs.writeFile(params.outputFile, finalOutput, "utf8");
        } catch {
          // fall through with output
        }
        return [true, finalOutput];
      }
      try {
        const file = Bun.file(params.outputFile);
        const exists = await file.exists();
        if (!exists) {
          await fs.writeFile(params.outputFile, finalOutput, "utf8");
          return [true, finalOutput];
        }

        const stat = await fs.stat(params.outputFile);
        if (stat.size === 0) {
          await fs.writeFile(params.outputFile, finalOutput, "utf8");
          return [true, finalOutput];
        }

        return [true, await fs.readFile(params.outputFile, "utf8")];
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
