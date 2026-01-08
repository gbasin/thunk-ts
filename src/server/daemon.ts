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
  bind?: string;
};

type StartOptions = {
  spawn?: SpawnLike;
  findPort?: (start: number) => Promise<number>;
  port?: number;
  bind?: string;
  workspace?: string;
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

async function resolveDaemonCommand(port: number, options: StartOptions): Promise<string[]> {
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
  return [process.execPath, cliEntrypoint, "server", "start", "--foreground"];
}

function serverInfoPath(globalDir: string): string {
  return path.join(globalDir, "server.json");
}

async function readServerInfo(globalDir: string): Promise<ServerInfo | null> {
  const infoPath = serverInfoPath(globalDir);
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

async function writeServerInfo(globalDir: string, info: ServerInfo): Promise<void> {
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(serverInfoPath(globalDir), `${JSON.stringify(info)}\n`, "utf8");
}

export async function updateServerActivity(globalDir: string, now = new Date()): Promise<void> {
  const info = await readServerInfo(globalDir);
  if (!info) {
    return;
  }
  info.last_activity = now.toISOString();
  await writeServerInfo(globalDir, info);
}

export async function isDaemonRunning(
  globalDir: string,
): Promise<{ running: boolean; port?: number; pid?: number; bind?: string }> {
  const infoPath = serverInfoPath(globalDir);
  const info = await readServerInfo(globalDir);
  if (!info) {
    return { running: false };
  }

  try {
    process.kill(info.pid, 0);
    return { running: true, port: info.port, pid: info.pid, bind: info.bind };
  } catch {
    await fs.rm(infoPath, { force: true });
    return { running: false };
  }
}

export async function startDaemon(
  globalDir: string,
  options: StartOptions = {},
): Promise<{ pid: number; port: number }> {
  const spawn = options.spawn ?? Bun.spawn;
  const portStart = options.port ?? DEFAULT_PORT;
  const port = await (options.findPort ?? findAvailablePort)(portStart);
  const cmd = await resolveDaemonCommand(port, options);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    PL4N_HOME: globalDir,
    PL4N_PORT: String(port),
  };
  if (options.workspace) {
    env.PL4N_WORKSPACE = options.workspace;
  }
  if (options.bind) {
    env.PL4N_BIND = options.bind;
  }
  const logFile = options.logFile ?? path.join(globalDir, "server.log");
  await fs.mkdir(globalDir, { recursive: true });
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
  await writeServerInfo(globalDir, {
    pid: proc.pid,
    port,
    bind: options.bind,
    started_at: now.toISOString(),
    last_activity: now.toISOString(),
  });

  return { pid: proc.pid, port };
}

export async function stopDaemon(globalDir: string): Promise<boolean> {
  const infoPath = serverInfoPath(globalDir);
  const info = await readServerInfo(globalDir);
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
