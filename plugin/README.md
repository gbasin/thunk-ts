# Pl4n Claude Code Plugin (Bun)

Claude Code plugin for the pl4n multi-agent ensemble planning CLI.

## Installation

```bash
# Add the pl4n marketplace
/plugin marketplace add gbasin/pl4n

# Install the plugin
/plugin install pl4n@pl4n
```

Or install directly:
```bash
/plugin install github:gbasin/pl4n
```

## Commands

| Command | Description |
|---------|-------------|
| `/pl4n:plan <feature>` | Start a planning session |
| `/pl4n:continue <session_id>` | Continue after editing |
| `/pl4n:approve <session_id>` | Lock plan as final |
| `/pl4n:status <session_id>` | Check session status |
| `/pl4n:list` | List all sessions |

## Example

```
> /pl4n:plan Add rate limiting to API endpoints

Started planning session `swift-river` for "Add rate limiting to API endpoints"
Agents are working...

Done! Plan ready at: .pl4n/sessions/swift-river/turns/001.md

> [edit the file]

> /pl4n:continue swift-river

Turn 2 complete. Plan at: .pl4n/sessions/swift-river/turns/002.md

> /pl4n:approve swift-river

Plan approved! Final plan: .pl4n/sessions/swift-river/PLAN.md
```

## Skill

The plugin includes a skill that teaches Claude about pl4n syntax and workflow. It activates automatically when discussing planning sessions.

## Prerequisites

Requires the pl4n CLI to be available:

```bash
bun install
bun run src/index.ts --help
```
