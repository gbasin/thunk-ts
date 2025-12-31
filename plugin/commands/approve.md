---
description: Approve and finalize a planning session. Locks the current plan and creates PLAN.md.
---

# Approve Planning Session

Approve planning session: **$ARGUMENTS**

## Prerequisites

If `pl4n` is not found (exit code 127), install it first:
```bash
bun install
```
Then continue with the steps below.

## Steps

1. Run `pl4n approve --session $ARGUMENTS`
2. If approval succeeds, tell the user:
   - The plan is final
   - The path to `PLAN.md`
3. If it fails due to unanswered questions, tell them to answer the questions in the plan file and retry
