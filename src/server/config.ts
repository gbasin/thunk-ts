import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { load as loadYaml } from "js-yaml";

type ServerConfigFile = {
  workspaces?: string[];
  bind?: string;
  port?: number;
  authMode?: ServerAuthMode;
  trustedCidrs?: string[];
};

export type ServerAuthMode = "strict" | "trusted";

export type ServerConfig = {
  workspaces: string[];
  bind: string;
  port?: number;
  globalDir: string;
  workspaceSource: "cli" | "env" | "config" | "default";
  authMode: ServerAuthMode;
  trustedCidrs: string[];
};

export type ServerConfigOverrides = {
  workspace?: string;
  workspaces?: string[];
  bind?: string;
  port?: number;
  cwd?: string;
};

const DEFAULT_BIND = "0.0.0.0";
const DEFAULT_AUTH_MODE: ServerAuthMode = "strict";
const DEFAULT_TRUSTED_CIDRS = [
  "127.0.0.0/8",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
];

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function parseStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be a list`);
  }
  if (value.length === 0) {
    throw new Error(`${field} must include at least one entry`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
}

function parsePort(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }
  throw new Error("port must be a number");
}

function parseAuthMode(value: unknown): ServerAuthMode {
  if (typeof value !== "string") {
    throw new Error("auth.mode must be a string");
  }
  if (value === "strict" || value === "trusted") {
    return value;
  }
  throw new Error("auth.mode must be strict or trusted");
}

export function resolveGlobalDir(): string {
  const override = process.env.PL4N_HOME?.trim();
  if (override) {
    return override;
  }
  return path.join(os.homedir(), ".pl4n");
}

export async function loadServerConfigFile(globalDir: string): Promise<ServerConfigFile> {
  const configPath = path.join(globalDir, "config.yaml");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = loadYaml(raw);
    if (!parsed || typeof parsed !== "object") {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const workspaces = record.workspaces
      ? parseStringList(record.workspaces, "workspaces")
      : undefined;
    const bind = record.bind ? requireString(record.bind, "bind") : undefined;
    const port = parsePort(record.port);
    let authMode: ServerAuthMode | undefined;
    let trustedCidrs: string[] | undefined;
    if (record.auth && typeof record.auth === "object") {
      const auth = record.auth as Record<string, unknown>;
      authMode = auth.mode ? parseAuthMode(auth.mode) : undefined;
      trustedCidrs = auth.trusted_cidrs
        ? parseStringList(auth.trusted_cidrs, "auth.trusted_cidrs")
        : undefined;
    }
    return { workspaces, bind, port, authMode, trustedCidrs };
  } catch {
    return {};
  }
}

function normalizeWorkspaces(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of paths) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    const resolved = path.resolve(trimmed);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    normalized.push(resolved);
  }
  return normalized;
}

export async function resolveServerConfig(
  overrides: ServerConfigOverrides = {},
): Promise<ServerConfig> {
  const globalDir = resolveGlobalDir();
  const fileConfig = await loadServerConfigFile(globalDir);

  const workspaceOverride =
    overrides.workspaces ?? (overrides.workspace ? [overrides.workspace] : []);
  const envWorkspace = process.env.PL4N_WORKSPACE?.trim();
  let workspaceSource: ServerConfig["workspaceSource"] = "default";
  let workspaces: string[];
  if (workspaceOverride.length > 0) {
    workspaces = workspaceOverride;
    workspaceSource = "cli";
  } else if (envWorkspace) {
    workspaces = [envWorkspace];
    workspaceSource = "env";
  } else if (fileConfig.workspaces) {
    workspaces = fileConfig.workspaces;
    workspaceSource = "config";
  } else {
    workspaces = [overrides.cwd ?? process.cwd()];
    workspaceSource = "default";
  }

  const bind = overrides.bind ?? process.env.PL4N_BIND ?? fileConfig.bind ?? DEFAULT_BIND;

  const portEnv = process.env.PL4N_PORT;
  const envPort = portEnv ? Number(portEnv) : undefined;
  const port =
    overrides.port ?? (envPort && !Number.isNaN(envPort) ? envPort : undefined) ?? fileConfig.port;

  const authMode = fileConfig.authMode ?? DEFAULT_AUTH_MODE;
  const trustedCidrs = fileConfig.trustedCidrs ?? DEFAULT_TRUSTED_CIDRS;

  return {
    workspaces: normalizeWorkspaces(workspaces),
    bind,
    port,
    globalDir,
    workspaceSource,
    authMode,
    trustedCidrs,
  };
}
