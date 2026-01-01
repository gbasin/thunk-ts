import { promises as fs } from "fs";
import path from "path";
import sade from "sade";

import { Phase, Pl4nConfig, type SessionState } from "./models";
import { TurnOrchestrator } from "./orchestrator";
import { SessionManager } from "./session";
import { ensureGlobalToken } from "./server/auth";
import { isDaemonRunning, startDaemon, stopDaemon } from "./server/daemon";
import { startServer } from "./server/index";
import { findAvailablePort, getLocalIP } from "./server/network";

type TurnOrchestratorInstance = {
  runTurn(sessionId: string): Promise<boolean>;
  getDiff(sessionId: string): Promise<string | null>;
};

type TurnOrchestratorCtor = new (
  manager: SessionManager,
  config: Pl4nConfig,
) => TurnOrchestratorInstance;

export type CliDeps = {
  TurnOrchestrator: TurnOrchestratorCtor;
  isDaemonRunning: typeof isDaemonRunning;
  startDaemon: typeof startDaemon;
  stopDaemon: typeof stopDaemon;
  startServer: typeof startServer;
  writeClipboard: (text: string) => Promise<void>;
};

function outputJson(data: Record<string, unknown>, pretty = false): void {
  const output = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  // eslint-disable-next-line no-console
  console.log(output);
}

function resolvePl4nDir(opts: Record<string, unknown>, fallback?: string): string | undefined {
  return (
    (opts.pl4nDir as string | undefined) ?? (opts["pl4n-dir"] as string | undefined) ?? fallback
  );
}

function resolvePretty(opts: Record<string, unknown>, fallback = false): boolean {
  return Boolean(opts.pretty ?? opts["pretty"] ?? fallback);
}

function resolveEnvPort(): number | undefined {
  const value = process.env.PL4N_PORT;
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function extractGlobalOptions(argv: string[]): {
  argv: string[];
  pl4nDir?: string;
  pretty: boolean;
} {
  const cleaned: string[] = [];
  let pl4nDir: string | undefined;
  let pretty = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--pl4n-dir") {
      pl4nDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--pl4n-dir=")) {
      pl4nDir = arg.split("=", 2)[1];
      continue;
    }
    if ((arg === "--file" || arg === "-f") && argv[i + 1] === "-") {
      cleaned.push(`${arg}=-`);
      i += 1;
      continue;
    }
    cleaned.push(arg);
  }

  return { argv: [argv[0], argv[1], ...cleaned], pl4nDir, pretty };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function exitWithError(data: Record<string, unknown>, pretty: boolean): never {
  outputJson(data, pretty);
  process.exit(1);
}

function isWebEnabled(): boolean {
  const value = process.env.PL4N_WEB;
  if (value === undefined) {
    return true;
  }
  return value !== "0" && value.toLowerCase() !== "false";
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    const clipboardy = await import("clipboardy");
    await clipboardy.default.write(text);
  } catch {
    // ignore clipboard errors
  }
}

const defaultDeps: CliDeps = {
  TurnOrchestrator,
  isDaemonRunning,
  startDaemon,
  stopDaemon,
  startServer,
  writeClipboard: copyToClipboard,
};

function resolveDeps(overrides?: Partial<CliDeps>): CliDeps {
  return { ...defaultDeps, ...overrides };
}

async function attachEditUrl(
  result: Record<string, unknown>,
  sessionId: string,
  manager: SessionManager,
  deps: CliDeps,
): Promise<void> {
  if (!isWebEnabled()) {
    return;
  }
  try {
    let status = await deps.isDaemonRunning(manager.pl4nDir);
    if (!status.running) {
      const started = await deps.startDaemon(manager.pl4nDir);
      status = { running: true, port: started.port, pid: started.pid };
    }
    if (!status.port) {
      return;
    }
    const token = await manager.ensureSessionToken(sessionId);
    const host = getLocalIP();
    const url = `http://${host}:${status.port}/edit/${sessionId}?t=${token}`;
    try {
      await deps.writeClipboard(url);
    } catch {
      // ignore clipboard errors
    }
    result.edit_url = url;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start web editor";
    result.web_error = message;
  }
}

async function loadConfig(pretty: boolean, pl4nDir: string): Promise<Pl4nConfig> {
  try {
    return await Pl4nConfig.loadFromPl4nDir(pl4nDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load config";
    exitWithError({ error: message }, pretty);
  }
}

async function loadSessionConfig(
  manager: SessionManager,
  sessionId: string,
  pretty: boolean,
): Promise<Pl4nConfig> {
  try {
    const snapshot = await manager.loadConfigSnapshot(sessionId);
    if (snapshot) {
      return snapshot;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load session config";
    exitWithError({ error: message }, pretty);
  }

  return await loadConfig(pretty, manager.pl4nDir);
}

async function loadSessionOrExit(
  manager: SessionManager,
  sessionId: string,
  pretty: boolean,
): Promise<SessionState> {
  let state: SessionState | null = null;
  try {
    state = await manager.loadSession(sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load session";
    exitWithError({ error: message }, pretty);
  }
  if (!state) {
    exitWithError({ error: `Session ${sessionId} not found` }, pretty);
  }
  return state;
}

function buildProgram(argv = process.argv, depsOverrides?: Partial<CliDeps>) {
  const globalOptions = extractGlobalOptions(argv);
  const deps = resolveDeps(depsOverrides);
  const prog = sade("pl4n");

  prog
    .option("--pl4n-dir", "Path to .pl4n directory (default: .pl4n in current dir)")
    .option("--pretty", "Pretty print JSON output");

  prog
    .command("init [task]")
    .describe("Start a new planning session (blocks until first turn complete)")
    .option("--file, -f <path>", "Read task description from file (use - for stdin)")
    .action(async (task: string | undefined, opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const config = await loadConfig(pretty, manager.pl4nDir);

      const fileOpt = opts.file ?? opts.f;
      let filePath: string | undefined;
      if (typeof fileOpt === "string") {
        filePath = fileOpt;
      } else if (fileOpt === true && typeof task === "string") {
        filePath = task;
        task = undefined;
      }
      let taskDescription: string;

      if (filePath) {
        if (filePath === "-") {
          // Read from stdin
          const chunks: Buffer[] = [];
          for await (const chunk of process.stdin) {
            chunks.push(chunk as Buffer);
          }
          taskDescription = Buffer.concat(chunks).toString("utf8").trim();
        } else {
          // Read from file
          try {
            taskDescription = (await fs.readFile(filePath, "utf8")).trim();
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to read file";
            exitWithError({ error: `Cannot read task file: ${message}` }, pretty);
          }
        }
      } else if (task) {
        taskDescription = task;
      } else {
        exitWithError(
          { error: "Missing task description. Provide as argument or use --file" },
          pretty,
        );
      }

      const state = await manager.createSession(taskDescription, config);
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      // Run first turn (blocking)
      const orchestrator = new deps.TurnOrchestrator(manager, config);
      const success = await orchestrator.runTurn(state.sessionId);

      const updatedState = await manager.loadSession(state.sessionId);
      if (!updatedState) {
        exitWithError({ error: "Session disappeared during turn" }, pretty);
      }

      const paths = manager.getPaths(state.sessionId);
      const turnFile = paths.turnFile(updatedState.turn);

      if (success) {
        const result: Record<string, unknown> = {
          session_id: state.sessionId,
          turn: updatedState.turn,
          phase: updatedState.phase,
          file: turnFile,
          has_questions: await manager.hasQuestions(state.sessionId),
          hint: "User should edit file, then call continue or approve",
        };
        if (Object.keys(updatedState.agentErrors).length > 0) {
          result.agent_errors = updatedState.agentErrors;
        }
        if (updatedState.phase === Phase.UserReview) {
          await attachEditUrl(result, state.sessionId, manager, deps);
        }
        outputJson(result, pretty);
      } else {
        const errorResult: Record<string, unknown> = {
          session_id: state.sessionId,
          turn: updatedState.turn,
          phase: updatedState.phase,
          error: "Turn failed",
          hint: "Check agent logs in .pl4n/sessions/<id>/agents/",
        };
        if (Object.keys(updatedState.agentErrors).length > 0) {
          errorResult.agent_errors = updatedState.agentErrors;
        }
        exitWithError(errorResult, pretty);
      }
    });

  prog
    .command("list")
    .describe("List all planning sessions")
    .action(async (opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);

      const sessions = await manager.listSessions();
      outputJson(
        {
          sessions: sessions.map((session) => ({
            session_id: session.sessionId,
            task: session.task,
            turn: session.turn,
            phase: session.phase,
            updated_at: session.updatedAt.toISOString(),
          })),
        },
        pretty,
      );
    });

  prog
    .command("status")
    .describe("Check session status without blocking")
    .option("--session", "Session ID")
    .action(async (opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const sessionId = opts.session as string | undefined;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await loadSessionOrExit(manager, sessionId, pretty);

      const paths = manager.getPaths(sessionId);
      const turnFile = paths.turnFile(state.turn);

      const result: Record<string, unknown> = {
        session_id: state.sessionId,
        turn: state.turn,
        phase: state.phase,
        file: (await fileExists(turnFile)) ? turnFile : null,
        has_questions: await manager.hasQuestions(sessionId),
        agents: Object.fromEntries(Object.entries(state.agents).map(([k, v]) => [k, v])),
      };
      if (Object.keys(state.agentErrors).length > 0) {
        result.agent_errors = state.agentErrors;
      }
      await attachEditUrl(result, sessionId, manager, deps);
      outputJson(result, pretty);
    });

  prog
    .command("server [action]")
    .describe("Manage the web editor server")
    .option("--foreground", "Run server in foreground")
    .action(async (action: string | undefined, opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const mode = (action ?? "status").toLowerCase();
      const portOverride = resolveEnvPort();

      if (mode === "start") {
        if (opts.foreground) {
          const running = await deps.isDaemonRunning(manager.pl4nDir);
          if (running.running) {
            exitWithError({ error: "Server already running" }, pretty);
          }
          const port = portOverride ?? (await findAvailablePort(3456));
          const token = await ensureGlobalToken(manager.pl4nDir);
          const url = `http://${getLocalIP()}:${port}/list?t=${token}`;
          outputJson({ running: true, foreground: true, port, url }, pretty);
          await deps.startServer({ pl4nDir: manager.pl4nDir, port });
          return;
        }

        let status = await deps.isDaemonRunning(manager.pl4nDir);
        if (!status.running) {
          const started = await deps.startDaemon(
            manager.pl4nDir,
            portOverride === undefined ? {} : { port: portOverride },
          );
          status = { running: true, port: started.port, pid: started.pid };
        }
        const token = await ensureGlobalToken(manager.pl4nDir);
        const url = status.port ? `http://${getLocalIP()}:${status.port}/list?t=${token}` : null;
        outputJson(
          {
            running: true,
            port: status.port,
            pid: status.pid,
            url,
          },
          pretty,
        );
        return;
      }

      if (mode === "stop") {
        const stopped = await deps.stopDaemon(manager.pl4nDir);
        if (!stopped) {
          exitWithError({ error: "Server not running" }, pretty);
        }
        outputJson({ stopped: true }, pretty);
        return;
      }

      if (mode === "status") {
        const status = await deps.isDaemonRunning(manager.pl4nDir);
        if (!status.running) {
          outputJson({ running: false }, pretty);
          return;
        }
        const token = await ensureGlobalToken(manager.pl4nDir);
        const url = status.port ? `http://${getLocalIP()}:${status.port}/list?t=${token}` : null;
        outputJson(
          {
            running: true,
            port: status.port,
            pid: status.pid,
            url,
          },
          pretty,
        );
        return;
      }

      exitWithError({ error: `Unknown server action: ${mode}` }, pretty);
    });

  prog
    .command("continue")
    .describe("Continue to next turn (blocks until complete)")
    .option("--session", "Session ID")
    .action(async (opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const sessionId = opts.session as string | undefined;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await loadSessionOrExit(manager, sessionId, pretty);

      if (state.phase !== Phase.UserReview) {
        exitWithError(
          {
            error: `Cannot continue from phase ${state.phase}`,
            hint: "Session must be in user_review phase to continue",
          },
          pretty,
        );
      }

      state.turn += 1;
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      // Run turn (blocking)
      const config = await loadSessionConfig(manager, sessionId, pretty);
      const orchestrator = new deps.TurnOrchestrator(manager, config);
      const success = await orchestrator.runTurn(sessionId);

      const updatedState = await manager.loadSession(sessionId);
      if (!updatedState) {
        exitWithError({ error: "Session disappeared during turn" }, pretty);
      }

      const paths = manager.getPaths(sessionId);
      const turnFile = paths.turnFile(updatedState.turn);

      if (success) {
        const result: Record<string, unknown> = {
          turn: updatedState.turn,
          phase: updatedState.phase,
          file: turnFile,
          has_questions: await manager.hasQuestions(sessionId),
          hint: "User should edit file, then call continue or approve",
        };
        if (Object.keys(updatedState.agentErrors).length > 0) {
          result.agent_errors = updatedState.agentErrors;
        }
        if (updatedState.phase === Phase.UserReview) {
          await attachEditUrl(result, sessionId, manager, deps);
        }
        outputJson(result, pretty);
      } else {
        const errorResult: Record<string, unknown> = {
          turn: updatedState.turn,
          phase: updatedState.phase,
          error: "Turn failed",
          hint: "Check agent logs in .pl4n/sessions/<id>/agents/",
        };
        if (Object.keys(updatedState.agentErrors).length > 0) {
          errorResult.agent_errors = updatedState.agentErrors;
        }
        exitWithError(errorResult, pretty);
      }
    });

  prog
    .command("approve")
    .describe("Lock current plan as final")
    .option("--session", "Session ID")
    .action(async (opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const sessionId = opts.session as string | undefined;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await loadSessionOrExit(manager, sessionId, pretty);

      if (state.phase !== Phase.UserReview) {
        exitWithError(
          {
            error: `Cannot approve from phase ${state.phase}`,
            hint: "Wait for user_review phase before approving",
          },
          pretty,
        );
      }

      if (await manager.hasQuestions(sessionId)) {
        exitWithError(
          {
            error: "Cannot approve with unanswered questions",
            hint: "Answer all questions in the plan file first",
          },
          pretty,
        );
      }

      const paths = manager.getPaths(sessionId);
      const turnFile = paths.turnFile(state.turn);
      const planLink = path.join(paths.root, "PLAN.md");

      if (await fileExists(planLink)) {
        await fs.rm(planLink, { force: true });
      }

      const relativeTarget = path.relative(paths.root, turnFile);
      await fs.symlink(relativeTarget, planLink);

      state.phase = Phase.Approved;
      await manager.saveState(state);

      outputJson(
        {
          phase: state.phase,
          final_turn: state.turn,
          plan_path: planLink,
          hint: "Planning complete. Plan is ready for implementation.",
        },
        pretty,
      );
    });

  prog
    .command("clean")
    .describe("Remove session and its data")
    .option("--session", "Session ID")
    .action(async (opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const sessionId = opts.session as string | undefined;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      if (await manager.cleanSession(sessionId)) {
        outputJson({ cleaned: true, session_id: sessionId }, pretty);
      } else {
        exitWithError({ error: `Session ${sessionId} not found` }, pretty);
      }
    });

  prog
    .command("diff")
    .describe("Show changes between turns")
    .option("--session", "Session ID")
    .action(async (opts: Record<string, unknown>) => {
      const manager = new SessionManager(resolvePl4nDir(opts, globalOptions.pl4nDir));
      const pretty = resolvePretty(opts, globalOptions.pretty);
      const sessionId = opts.session as string | undefined;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await loadSessionOrExit(manager, sessionId, pretty);

      if (state.turn < 2) {
        exitWithError({ error: "Need at least 2 turns to show diff" }, pretty);
      }

      const config = await loadSessionConfig(manager, sessionId, pretty);
      const diff = await new deps.TurnOrchestrator(manager, config).getDiff(sessionId);
      if (!diff) {
        exitWithError({ error: "Turn files not found" }, pretty);
      }

      outputJson(
        {
          from_turn: state.turn - 1,
          to_turn: state.turn,
          diff,
        },
        pretty,
      );
    });

  return { prog, argv: globalOptions.argv };
}

export async function runCli(argv = process.argv, depsOverrides?: Partial<CliDeps>): Promise<void> {
  await runCliCommand(argv, depsOverrides);
}

export async function runCliCommand(
  argv = process.argv,
  depsOverrides?: Partial<CliDeps>,
): Promise<void> {
  const { prog, argv: parsedArgv } = buildProgram(argv, depsOverrides);
  const parsed = (prog as unknown as { parse: (...args: unknown[]) => unknown }).parse(parsedArgv, {
    lazy: true,
  }) as { handler: (...args: unknown[]) => unknown; args: unknown[] } | undefined;
  if (parsed) {
    await parsed.handler(...parsed.args);
  }
}
