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
  pl4nDir: string,
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
    "--pl4n-dir",
    pl4nDir,
    "server",
    "start",
    "--foreground",
  ];
}

function serverInfoPath(pl4nDir: string): string {
  return path.join(pl4nDir, "server.json");
}

async function readServerInfo(pl4nDir: string): Promise<ServerInfo | null> {
  const infoPath = serverInfoPath(pl4nDir);
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

async function writeServerInfo(pl4nDir: string, info: ServerInfo): Promise<void> {
  await fs.mkdir(pl4nDir, { recursive: true });
  await fs.writeFile(serverInfoPath(pl4nDir), `${JSON.stringify(info)}\n`, "utf8");
}

export async function updateServerActivity(pl4nDir: string, now = new Date()): Promise<void> {
  const info = await readServerInfo(pl4nDir);
  if (!info) {
    return;
  }
  info.last_activity = now.toISOString();
  await writeServerInfo(pl4nDir, info);
}

export async function isDaemonRunning(
  pl4nDir: string,
): Promise<{ running: boolean; port?: number; pid?: number }> {
  const infoPath = serverInfoPath(pl4nDir);
  const info = await readServerInfo(pl4nDir);
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
  pl4nDir: string,
  options: StartOptions = {},
): Promise<{ pid: number; port: number }> {
  const spawn = options.spawn ?? Bun.spawn;
  const port = options.port ?? (await (options.findPort ?? findAvailablePort)(DEFAULT_PORT));
  const cmd = await resolveDaemonCommand(pl4nDir, port, options);
  const env = { ...process.env, ...options.env, PL4N_DIR: pl4nDir, PL4N_PORT: String(port) };
  const logFile = options.logFile ?? path.join(pl4nDir, "server.log");
  await fs.mkdir(pl4nDir, { recursive: true });
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
  await writeServerInfo(pl4nDir, {
    pid: proc.pid,
    port,
    started_at: now.toISOString(),
    last_activity: now.toISOString(),
  });

  return { pid: proc.pid, port };
}

export async function stopDaemon(pl4nDir: string): Promise<boolean> {
  const infoPath = serverInfoPath(pl4nDir);
  const info = await readServerInfo(pl4nDir);
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
