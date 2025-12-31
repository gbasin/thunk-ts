---
description: Multi-agent ensemble planning with pl4n CLI. Use when discussing implementation plans, task planning, or when user mentions pl4n sessions. Knows pl4n CLI syntax and workflow.
---

# Pl4n Planning Workflow

## Setup (if pl4n command not found)

If the `pl4n` command is not available, install it first:

```bash
cd /path/to/pl4n/repo
bun install
```

Pl4n orchestrates multiple AI agents (Claude Code + OpenAI Codex) to create implementation plans through iterative refinement.

## Quick Reference

| Command | Purpose |
|---------|---------|
| `pl4n init "task"` | Start new planning session (short description) |
| `pl4n init --file spec.md` | Start session from file (for large specs) |
| `pl4n wait --session <id>` | Block until turn complete |
| `pl4n status --session <id>` | Check progress |
| `pl4n continue --session <id>` | Start next turn after edits |
| `pl4n approve --session <id>` | Lock plan as final |
| `pl4n list` | List all sessions |
| `pl4n clean --session <id>` | Remove session |
| `pl4n diff --session <id>` | Show changes between turns |

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/pl4n:plan` | Interactive planning - choose interview, spec file, or paste |
| `/pl4n:continue <id>` | Continue after editing turn file |
| `/pl4n:approve <id>` | Lock plan as final |
| `/pl4n:status <id>` | Check session status |
| `/pl4n:list` | List all sessions |

## Workflow

```
init → wait → [user edits] → continue → wait → ... → approve
```

1. **init**: Creates session, agents start exploring codebase
2. **wait**: Blocks until agents complete draft → peer review → synthesis
3. **User edits**: Human reviews `.pl4n/sessions/<id>/turns/NNN.md`
4. **continue**: Starts next turn, agents refine based on edits
5. **approve**: Locks plan, creates PLAN.md symlink

## Session Phases

- `initializing` - Session just created
- `drafting` - Agents creating initial drafts
- `peer_review` - Agents reviewing each other's work
- `synthesizing` - Combining into unified plan
- `user_review` - Waiting for human feedback
- `approved` - Plan locked and final

## Plan File Format

```markdown
## Questions
### Q1: [Question needing user input]
**Context:** Why this matters
**Answer:** [User fills this in]

## Summary
[2-3 sentence overview]

## Tasks
- [ ] **Task 1**: Description
  - **Files:** `path/file.ts` (create|modify)
  - **Rationale:** Why needed
  - **Dependencies:** none | Task N

## Risks
- **Risk name** (severity: high|medium|low)
  - **Mitigation:** How to address

## Alternatives Considered
- **Alternative**: Rejected because [reason]
```

## Session File Structure

```
.pl4n/sessions/swift-river/       # Human-friendly session ID
├── meta.yaml           # Task, created_at
├── state.yaml          # turn, phase, agent_plan_ids
├── bold-peak.md        # Agent's working plan (opaque name)
├── calm-forest.md      # Another agent's plan
├── turns/
│   ├── 001.md          # Turn 1 synthesis (user edits this)
│   └── 002.md          # Turn 2
├── agents/
│   ├── opus/cli_session_id.txt
│   ├── codex/cli_session_id.txt
│   └── turn-001/
│       ├── opus-draft.md
│       └── opus-final.md
└── PLAN.md             # Symlink to approved turn
```

## Session Continuation

Agents preserve context across turns:
- Claude Code: `--resume <session_id>`
- Codex: `codex resume <thread_id>`

First turn exploration (reading files, understanding patterns) is remembered in subsequent turns.
