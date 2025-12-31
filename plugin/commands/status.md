---
description: Check the status of a planning session without blocking.
---

# Status

Check status for session: **$ARGUMENTS**

## Prerequisites

If `pl4n` is not found (exit code 127), install it first:
```bash
bun install
```
Then continue with the steps below.

## Steps

1. Run `pl4n status --session $ARGUMENTS`
2. Report back to the user:
   - Current phase
   - Current turn
   - Plan file path (if available)
   - Whether there are unanswered questions
