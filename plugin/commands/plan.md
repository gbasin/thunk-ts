---
description: Start a multi-agent planning session for a task. Creates a pl4n session and waits for agents to complete the first turn.
---

# Plan Task

The user wants to start a planning session.

## Step 1: Ask How to Proceed

**FIRST**, use the AskUserQuestion tool to ask how they want to provide the task:

```
Question: "How would you like to describe what you want to plan?"
Options:
1. "Interview me" - I'll ask detailed questions to understand your requirements
2. "I have a spec file" - Provide a path to an existing file (e.g., SPEC.md)
3. "I'll paste a description" - You'll paste in the task description
```

## Step 2: Handle Based on Response

### Option 1: Interview Mode

Interview the user in depth using the AskUserQuestion tool to understand what they want to plan.

**Interview guidelines:**
- Start by asking what feature/system they want to build
- Go deep on technical implementation details: architecture, data models, APIs, state management
- Explore UI & UX concerns: user flows, edge cases, error states, accessibility
- Probe for tradeoffs: performance vs simplicity, build vs buy, scope decisions
- Ask about constraints: timeline, team size, existing systems to integrate with
- Uncover concerns: security, scalability, maintenance, testing strategy
- Ask non-obvious questions - don't ask things with obvious answers
- Continue asking questions until you have a comprehensive understanding
- Each round, ask 2-4 focused questions on different aspects

When the interview is complete, write a comprehensive spec to `.pl4n/task-temp.md` summarizing everything discussed, then proceed to Step 3.

### Option 2: Spec File

Ask for the file path, then proceed to Step 3 using that file directly with `--file`.

### Option 3: Paste Description

Ask the user to paste their description. Once received, write it to `.pl4n/task-temp.md`, then proceed to Step 3.

## Step 3: Initialize and Run

Prerequisites: If `pl4n` is not found (exit code 127), run `bun install` first.

1. Run pl4n init:
   - For spec file: `pl4n init --file "<filepath>"`
   - For interview/paste: `pl4n init --file .pl4n/task-temp.md`

2. Capture the `session_id` from the JSON output

3. Run `pl4n wait --session <session_id>` to wait for agents to complete

4. When complete, tell the user:
   - The path to the plan file (`.pl4n/sessions/<id>/turns/001.md`)
   - They should review and edit the file
   - When done editing, use `/pl4n:continue <session_id>` to start the next turn
   - Or `/pl4n:approve <session_id>` if satisfied
