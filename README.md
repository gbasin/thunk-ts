# Thunk (Bun + TypeScript)

Multi-agent ensemble planning CLI. Orchestrates multiple AI agents (Claude Code, OpenAI Codex) to collaboratively create implementation plans with human-in-the-loop review.

## Why Thunk?

"A droid is only as good as its plan." Planning with multiple models produces more robust plans through:

- **Diversity**: Different models notice different things when exploring codebases
- **Peer review**: Agents critique each other's drafts before synthesis
- **Iteration**: Human feedback refines plans across multiple turns

## Install

From source:

```bash
bun install
bun run src/index.ts --help
```

## Quick Start

```bash
# Start a planning session
bun run src/index.ts init "Add user authentication"

# Wait for agents to complete first turn
bun run src/index.ts wait --session <session_id>

# Review and edit the plan
# Edit .thunk/sessions/<id>/turns/001.md

# Continue to next turn (incorporates your edits)
bun run src/index.ts continue --session <session_id>

# Approve when satisfied
bun run src/index.ts approve --session <session_id>
```

## How It Works

### Turn-Based Planning

Each turn follows this flow:

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   DRAFT     │ -> │ PEER REVIEW │ -> │  SYNTHESIS  │ -> │ USER REVIEW │
│             │    │             │    │             │    │             │
│ Each agent  │    │ Agents      │    │ Merge into  │    │ Human edits │
│ writes plan │    │ review peer │    │ unified     │    │ turns/001.md│
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

1. **Draft**: Each agent explores the codebase and writes an independent plan
2. **Peer Review**: Agents review each other's drafts and refine their own
3. **Synthesis**: Plans are merged into a unified proposal
4. **User Review**: Human edits `turns/NNN.md`, then calls `continue` or `approve`

### Session Continuation

Agents maintain context across turns via CLI session continuation:
- Claude Code: `--resume <session_id>`
- Codex: `resume <thread_id>`

This means agents accumulate codebase knowledge rather than starting fresh each turn.

### User Feedback as Diff

When you edit `turns/001.md` and call `continue`, agents receive your changes as a diff. They interpret your edits naturally:
- Deletions = remove this
- Additions = add this requirement
- Comments = feedback to address

## Commands

| Command | Description |
|---------|-------------|
| `thunk init "task"` | Start new planning session |
| `thunk wait --session <id>` | Block until current turn completes |
| `thunk status --session <id>` | Check progress without blocking |
| `thunk continue --session <id>` | Start next turn after your edits |
| `thunk approve --session <id>` | Lock plan as final |
| `thunk list` | List all sessions |
| `thunk clean --session <id>` | Remove session data |
| `thunk diff --session <id>` | Show changes between turns |

## File Structure

```
.thunk/sessions/swift-river/          # Human-friendly session ID
├── meta.yaml                         # Task description, timestamp
├── state.yaml                        # Turn, phase, agent_plan_ids mapping
│
├── sunny-glade.md                    # Agent's persistent plan (plan_id)
├── amber-marsh.md                    # Another agent's plan
│
├── turns/
│   ├── 001.md                        # Turn 1 synthesis (USER EDITS THIS)
│   ├── 001.snapshot.md               # Pre-edit snapshot (for diffing)
│   ├── 001/                          # Debug snapshots
│   │   ├── sunny-glade-draft.md
│   │   └── sunny-glade-reviewed.md
│   ├── 002.md
│   └── ...
│
├── agents/
│   ├── sunny-glade.log               # Session-wide debug log (appended)
│   ├── sunny-glade/
│   │   └── cli_session_id.txt        # For --resume
│   ├── amber-marsh.log
│   └── synthesizer.log
│
└── PLAN.md                           # Symlink to approved turn
```

**Key points:**
- Plan IDs (`sunny-glade`, `amber-marsh`) are opaque names mapped to agents in `state.yaml`
- Agents read/write their persistent plan file (e.g., `sunny-glade.md`)
- After synthesis, all agent plan files are synced to the canonical state
- Debug logs span the entire session (appended each turn)

## Configuration

Default agents (in code):
- **opus**: Claude Code with Opus 4.5
- **codex**: OpenAI Codex CLI

Both run from the project root with full read access and limited tool permissions for safe exploration.

## Architecture

```
src/
├── cli.ts          # CLI commands (sade)
├── models.ts       # Data models (SessionState, Phase, AgentConfig)
├── session.ts      # Session lifecycle management
├── orchestrator.ts # Turn orchestration (draft -> peer review -> synthesis)
├── prompts.ts      # Agent prompt templates
├── names.ts        # Human-friendly name generator
└── adapters/
    ├── base.ts     # AgentAdapter interface
    ├── claude.ts   # Claude Code adapter (subprocess, --resume)
    └── codex.ts    # Codex CLI adapter (subprocess, resume)
```

## Development

```bash
bun install
```

Run tests and checks:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

## Design Decisions

- **File-based protocol**: Agents communicate via files, making the system agent-agnostic
- **Turn-based iteration**: Each turn produces a numbered synthesis file
- **Opaque plan IDs**: Prevents models from confusing which file belongs to which agent
- **Session continuation**: Agents preserve codebase exploration context across turns
- **No special syntax**: Users edit plans naturally; agents interpret the diff
