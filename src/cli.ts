import { promises as fs } from "fs";
import path from "path";
import sade from "sade";

import { Phase, ThunkConfig } from "./models";
import { TurnOrchestrator } from "./orchestrator";
import { SessionManager } from "./session";

function outputJson(data: Record<string, unknown>, pretty = false): void {
  const output = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  // eslint-disable-next-line no-console
  console.log(output);
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

export function runCli(argv = process.argv): void {
  const prog = sade("thunk");

  prog
    .option("--thunk-dir", "Path to .thunk directory (default: .thunk in current dir)")
    .option("--pretty", "Pretty print JSON output");

  prog
    .command("init <task>")
    .describe("Start a new planning session")
    .action(async (task: string, opts: { thunkDir?: string; pretty?: boolean }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);

      const state = await manager.createSession(task);
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      outputJson(
        {
          session_id: state.sessionId,
          turn: state.turn,
          phase: state.phase,
          hint: "call wait to block until turn complete"
        },
        pretty
      );
    });

  prog
    .command("list")
    .describe("List all planning sessions")
    .action(async (opts: { thunkDir?: string; pretty?: boolean }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);

      const sessions = await manager.listSessions();
      outputJson(
        {
          sessions: sessions.map((session) => ({
            session_id: session.sessionId,
            task: session.task,
            turn: session.turn,
            phase: session.phase,
            updated_at: session.updatedAt.toISOString()
          }))
        },
        pretty
      );
    });

  prog
    .command("status")
    .describe("Check session status without blocking")
    .option("--session", "Session ID")
    .action(async (opts: { thunkDir?: string; pretty?: boolean; session?: string }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);
      const sessionId = opts.session;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await manager.loadSession(sessionId);
      if (!state) {
        exitWithError({ error: `Session ${sessionId} not found` }, pretty);
      }

      const paths = manager.getPaths(sessionId);
      const turnFile = paths.turnFile(state.turn);

      outputJson(
        {
          session_id: state.sessionId,
          turn: state.turn,
          phase: state.phase,
          file: (await fileExists(turnFile)) ? turnFile : null,
          has_questions: await manager.hasQuestions(sessionId),
          agents: Object.fromEntries(Object.entries(state.agents).map(([k, v]) => [k, v]))
        },
        pretty
      );
    });

  prog
    .command("wait")
    .describe("Block until current turn is complete")
    .option("--session", "Session ID")
    .option("--timeout", "Timeout in seconds")
    .action(
      async (opts: {
        thunkDir?: string;
        pretty?: boolean;
        session?: string;
        timeout?: string;
      }) => {
        const manager = new SessionManager(opts.thunkDir);
        const pretty = Boolean(opts.pretty);
        const sessionId = opts.session;

        if (!sessionId) {
          exitWithError({ error: "Missing --session" }, pretty);
        }

        const state = await manager.loadSession(sessionId);
        if (!state) {
          exitWithError({ error: `Session ${sessionId} not found` }, pretty);
        }

        const paths = manager.getPaths(sessionId);
        const turnFile = paths.turnFile(state.turn);

        if (state.phase === Phase.UserReview) {
          outputJson(
            {
              turn: state.turn,
              phase: state.phase,
              file: turnFile,
              has_questions: await manager.hasQuestions(sessionId),
              hint: "User should edit file, then call continue or approve"
            },
            pretty
          );
          return;
        }

        if (state.phase === Phase.Approved) {
          outputJson(
            {
              turn: state.turn,
              phase: state.phase,
              file: path.join(paths.root, "PLAN.md"),
              hint: "Planning complete"
            },
            pretty
          );
          return;
        }

        if (
          state.phase === Phase.Drafting ||
          state.phase === Phase.Initializing ||
          state.phase === Phase.PeerReview ||
          state.phase === Phase.Synthesizing
        ) {
          const config = ThunkConfig.default();
          if (opts.timeout) {
            const timeoutValue = Number(opts.timeout);
            if (!Number.isNaN(timeoutValue)) {
              config.timeout = timeoutValue;
            }
          }
          const orchestrator = new TurnOrchestrator(manager, config);
          const success = await orchestrator.runTurn(sessionId);

          const updatedState = await manager.loadSession(sessionId);
          if (!updatedState) {
            exitWithError({ error: "Session disappeared during turn" }, pretty);
          }

          if (success) {
            outputJson(
              {
                turn: updatedState.turn,
                phase: updatedState.phase,
                file: turnFile,
                has_questions: await manager.hasQuestions(sessionId),
                hint: "User should edit file, then call continue or approve"
              },
              pretty
            );
          } else {
            exitWithError(
              {
                turn: updatedState.turn,
                phase: updatedState.phase,
                error: "Turn failed",
                hint: "Check agent logs in .thunk/sessions/<id>/agents/"
              },
              pretty
            );
          }
          return;
        }

        exitWithError(
          {
            turn: state.turn,
            phase: state.phase,
            error: `Unexpected phase: ${state.phase}`
          },
          pretty
        );
      }
    );

  prog
    .command("continue")
    .describe("User done editing, start next turn")
    .option("--session", "Session ID")
    .action(async (opts: { thunkDir?: string; pretty?: boolean; session?: string }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);
      const sessionId = opts.session;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await manager.loadSession(sessionId);
      if (!state) {
        exitWithError({ error: `Session ${sessionId} not found` }, pretty);
      }

      if (state.phase !== Phase.UserReview) {
        exitWithError(
          {
            error: `Cannot continue from phase ${state.phase}`,
            hint: "Wait for user_review phase before continuing"
          },
          pretty
        );
      }

      state.turn += 1;
      state.phase = Phase.Drafting;
      await manager.saveState(state);

      outputJson(
        {
          turn: state.turn,
          phase: state.phase,
          hint: "call wait to block until turn complete"
        },
        pretty
      );
    });

  prog
    .command("approve")
    .describe("Lock current plan as final")
    .option("--session", "Session ID")
    .action(async (opts: { thunkDir?: string; pretty?: boolean; session?: string }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);
      const sessionId = opts.session;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await manager.loadSession(sessionId);
      if (!state) {
        exitWithError({ error: `Session ${sessionId} not found` }, pretty);
      }

      if (state.phase !== Phase.UserReview) {
        exitWithError(
          {
            error: `Cannot approve from phase ${state.phase}`,
            hint: "Wait for user_review phase before approving"
          },
          pretty
        );
      }

      if (await manager.hasQuestions(sessionId)) {
        exitWithError(
          {
            error: "Cannot approve with unanswered questions",
            hint: "Answer all questions in the plan file first"
          },
          pretty
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
          hint: "Planning complete. Plan is ready for implementation."
        },
        pretty
      );
    });

  prog
    .command("clean")
    .describe("Remove session and its data")
    .option("--session", "Session ID")
    .action(async (opts: { thunkDir?: string; pretty?: boolean; session?: string }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);
      const sessionId = opts.session;

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
    .action(async (opts: { thunkDir?: string; pretty?: boolean; session?: string }) => {
      const manager = new SessionManager(opts.thunkDir);
      const pretty = Boolean(opts.pretty);
      const sessionId = opts.session;

      if (!sessionId) {
        exitWithError({ error: "Missing --session" }, pretty);
      }

      const state = await manager.loadSession(sessionId);
      if (!state) {
        exitWithError({ error: `Session ${sessionId} not found` }, pretty);
      }

      if (state.turn < 2) {
        exitWithError({ error: "Need at least 2 turns to show diff" }, pretty);
      }

      const diff = await new TurnOrchestrator(manager, ThunkConfig.default()).getDiff(sessionId);
      if (!diff) {
        exitWithError({ error: "Turn files not found" }, pretty);
      }

      outputJson(
        {
          from_turn: state.turn - 1,
          to_turn: state.turn,
          diff
        },
        pretty
      );
    });

  prog.parse(argv);
}
