# AGENTS.md — How to work in this repo

## Environment

- Bun 1.x
- TypeScript 5.x

## Quick Start

bun install
bun run src/index.ts --help

## Repo Commands

bun run lint       # oxlint
bun run format     # Biome format
bun run typecheck  # tsc --noEmit
bun run test       # bun test
bun run build      # bun build

## Git Rules

- Check `git status`/`git diff` before commits
- Atomic commits; push only when asked
- Never destructive ops (`reset --hard`, `force push`) without explicit consent
- Use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`

## Critical Thinking

- Read more code when stuck
- Document unexpected behavior
- Call out conflicts between instructions

## Engineering

- Small files (<500 LOC), descriptive paths, current header comments (agents navigate via filesystem and read line-by-line)
- Fix root causes, not symptoms
- Simplicity > cleverness (even if it means bigger refactors)
- 100% test coverage (forces edge-case thinking)

## Project Overview

Thunk is a multi-agent ensemble planning CLI. It orchestrates multiple AI agents
(Claude Code, OpenAI Codex) to collaboratively create implementation plans for
tasks, with human-in-the-loop review.

See `README.md` for full documentation.

## Commands

thunk init "task description"        # Start planning session
thunk wait --session <id>            # Block until turn complete
thunk continue --session <id>        # Start next turn after user edits
thunk approve --session <id>         # Lock plan as final
thunk status --session <id>          # Check progress
thunk list                           # List all sessions
thunk clean --session <id>           # Remove session
thunk diff --session <id>            # Show changes between turns

## Architecture

src/
├── cli.ts          # CLI commands (sade)
├── models.ts       # Data models (SessionState, Phase, etc.)
├── session.ts      # Session management
├── orchestrator.ts # Turn orchestration (draft → peer review → synthesis)
├── prompts.ts      # Agent prompt templates
├── names.ts        # Human-friendly name generator
└── adapters/
    ├── base.ts     # AgentAdapter interface
    ├── claude.ts   # Claude Code adapter (with session continuation)
    └── codex.ts    # Codex CLI adapter (with session continuation)

## Session File Structure

.thunk/sessions/swift-river/      # Human-friendly session ID
├── meta.yaml                     # Task description, timestamp
├── state.yaml                    # Turn, phase, agent_plan_ids mapping
├── sunny-glade.md                # Agent's persistent plan (plan_id)
├── amber-marsh.md                # Another agent's plan
├── turns/
│   ├── 001.md                    # Turn 1 synthesis (user edits this)
│   ├── 001.snapshot.md           # Pre-edit snapshot (for diffing)
│   ├── 001/                      # Debug snapshots
│   │   ├── sunny-glade-draft.md
│   │   └── sunny-glade-reviewed.md
│   └── ...
├── agents/
│   ├── sunny-glade.log           # Session-wide debug log (appended)
│   ├── sunny-glade/
│   │   └── cli_session_id.txt    # For --resume
│   ├── amber-marsh.log
│   └── synthesizer.log
└── PLAN.md                       # Symlink to approved turn
