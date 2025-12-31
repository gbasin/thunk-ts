import { promises as fs } from "fs";
import path from "path";

import { findAvailablePort } from "./network";

type SpawnOptions = {
  cmd: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  stdin?: "ignore" | "pipe" | "inherit" | null;
  stdout?: "ignore" | "pipe" | "inherit" | number | null;
  stderr?: "ignore" | "pipe" | "inherit" | number | null;
  detached?: boolean;
};
type SpawnLike = (options: SpawnOptions) => { pid: number; unref?: () => void };

export type ServerInfo = {
  pid: number;
  port: number;
  started_at: string;
  last_activity: string;
};

type StartOptions = {
  spawn?: SpawnLike;
  findPort?: (start: number) => Promise<number>;
  port?: number;
  now?: () => Date;
  entrypoint?: string;
  env?: NodeJS.ProcessEnv;
  logFile?: string;
};

const DEFAULT_PORT = 3456;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveDaemonCommand(
  thunkDir: string,
  port: number,
  options: StartOptions,
): Promise<string[]> {
  if (options.entrypoint) {
    return [process.execPath, options.entrypoint, "--port", String(port)];
  }

  const sourceEntrypoint = path.join(import.meta.dir, "index.ts");
  if (await fileExists(sourceEntrypoint)) {
    return [process.execPath, sourceEntrypoint, "--port", String(port)];
  }

  const compiledEntrypoint = path.join(import.meta.dir, "server", "index.js");
  if (await fileExists(compiledEntrypoint)) {
    return [process.execPath, compiledEntrypoint, "--port", String(port)];
  }

  const cliEntrypoint = process.argv[1] ?? path.join(import.meta.dir, "index.js");
  return [
    process.execPath,
    cliEntrypoint,
    "--thunk-dir",
    thunkDir,
    "server",
    "start",
    "--foreground",
  ];
}

function serverInfoPath(thunkDir: string): string {
  return path.join(thunkDir, "server.json");
}

async function readServerInfo(thunkDir: string): Promise<ServerInfo | null> {
  const infoPath = serverInfoPath(thunkDir);
  try {
    const raw = await fs.readFile(infoPath, "utf8");
    const parsed = JSON.parse(raw) as ServerInfo;
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeServerInfo(thunkDir: string, info: ServerInfo): Promise<void> {
  await fs.mkdir(thunkDir, { recursive: true });
  await fs.writeFile(serverInfoPath(thunkDir), `${JSON.stringify(info)}\n`, "utf8");
}

export async function updateServerActivity(thunkDir: string, now = new Date()): Promise<void> {
  const info = await readServerInfo(thunkDir);
  if (!info) {
    return;
  }
  info.last_activity = now.toISOString();
  await writeServerInfo(thunkDir, info);
}

export async function isDaemonRunning(
  thunkDir: string,
): Promise<{ running: boolean; port?: number; pid?: number }> {
  const infoPath = serverInfoPath(thunkDir);
  const info = await readServerInfo(thunkDir);
  if (!info) {
    return { running: false };
  }

  try {
    process.kill(info.pid, 0);
    return { running: true, port: info.port, pid: info.pid };
  } catch {
    await fs.rm(infoPath, { force: true });
    return { running: false };
  }
}

export async function startDaemon(
  thunkDir: string,
  options: StartOptions = {},
): Promise<{ pid: number; port: number }> {
  const spawn = options.spawn ?? Bun.spawn;
  const port = options.port ?? (await (options.findPort ?? findAvailablePort)(DEFAULT_PORT));
  const cmd = await resolveDaemonCommand(thunkDir, port, options);
  const env = { ...process.env, ...options.env, THUNK_DIR: thunkDir, THUNK_PORT: String(port) };
  const logFile = options.logFile ?? path.join(thunkDir, "server.log");
  await fs.mkdir(thunkDir, { recursive: true });
  const logHandle = await fs.open(logFile, "a");

  const proc = spawn({
    cmd,
    env,
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: logHandle.fd,
    stderr: logHandle.fd,
    detached: true,
  });
  proc.unref?.();
  await logHandle.close();

  const now = (options.now ?? (() => new Date()))();
  await writeServerInfo(thunkDir, {
    pid: proc.pid,
    port,
    started_at: now.toISOString(),
    last_activity: now.toISOString(),
  });

  return { pid: proc.pid, port };
}

export async function stopDaemon(thunkDir: string): Promise<boolean> {
  const infoPath = serverInfoPath(thunkDir);
  const info = await readServerInfo(thunkDir);
  if (!info) {
    return false;
  }

  try {
    process.kill(info.pid, "SIGTERM");
  } catch (error) {
    const code = error as NodeJS.ErrnoException;
    if (code.code !== "ESRCH") {
      throw error;
    }
    await fs.rm(infoPath, { force: true });
    return false;
  }

  await fs.rm(infoPath, { force: true });
  return true;
}
