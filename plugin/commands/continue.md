---
description: Continue a planning session after user edits. Starts the next turn with agent refinement.
---

# Continue Planning Session

Continue planning session: **$ARGUMENTS**

## Prerequisites

If `pl4n` is not found (exit code 127), install it first:
```bash
bun install
```
Then continue with the steps below.

## Steps

1. Run `pl4n continue --session $ARGUMENTS`
2. Run `pl4n wait --session $ARGUMENTS` to wait for agents
3. When complete, tell the user:
   - The new turn number
   - The path to the updated plan file
   - They can edit again and `/pl4n:continue`, or `/pl4n:approve` if satisfied
