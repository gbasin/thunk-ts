export const PLAN_FORMAT = `
## Clarifications

### Assumptions

| # | Assumption | Rationale |
|---|------------|-----------|
| A1 | [What you're assuming] | [Why you think this] |

_If revised: ~~old~~ → new_

### Questions

**Q1: [Question]?**
- Context: [Why this matters]
- My lean: [Your best guess]
- **Answer:**

---

## Notes for Agents

<!-- Add feedback for agents here. Delete this comment when adding notes. -->

---

## Summary

[2-3 sentence overview of the approach]

## Diagrams (optional)

When helpful, include ASCII diagrams to illustrate:
- Architecture or component relationships
- Data/control flow
- State transitions

\`\`\`
┌─────────┐     ┌─────────┐
│ Client  │────▶│ Server  │
└─────────┘     └─────────┘
\`\`\`

_(Delete this section if no diagrams are needed)_

## Tasks

- [ ] **Task 1**: [Description]
  - **Files:** \`path/to/file.py\` (create|modify)
  - **Rationale:** [Why this task]
  - **Dependencies:** none | Task N

## Risks

- **[Risk name]** (severity: high|medium|low)
  - **Mitigation:** [How to address]

## Alternatives Considered

- **[Alternative]**: Rejected because [reason]
`;

const DRAFT_PROMPT_INITIAL = `# Planning Task (Turn 1)

Create a plan for this task.

## Task
{task}

## Instructions
1. Explore the codebase - look for AGENTS.md, README.md, or documentation
2. Understand the project's conventions, architecture, and patterns
3. **Surface ambiguities early:**
   - List assumptions you're making (so the user can correct them before you waste effort)
   - Ask questions where you genuinely need input to proceed well
   - For EVERY question, include "My lean" — your best guess helps the user even if they're unsure
   - Think: what could derail this plan if I'm wrong about it?
4. Write a detailed plan

Write your plan to: \`{output_file}\`

{plan_format}
`;

const DRAFT_PROMPT = `# Planning Task (Turn {turn})

Refine the plan based on feedback.

## Task
{task}

## Your Working Plan
Read your current plan from: \`{plan_file}\`

This file contains the synthesized plan from the previous turn.

## User Feedback
{user_feedback}

## Instructions
1. Read your current plan file
2. Review the user feedback above
3. Update the plan incorporating the feedback
4. Write your updated plan to: \`{output_file}\`

{plan_format}
`;

const PEER_REVIEW_PROMPT = `# Peer Review Task

You wrote an initial draft. Now review your peer's draft and improve your plan.

## Task
{task}

## Your Draft
{own_draft}

## Peer's Draft ({peer_id})
{peer_draft}

## Instructions
1. Review your peer's approach
2. Identify ideas from their plan that improve yours
3. Note any conflicts and resolve them
4. Write an improved plan incorporating the best of both

Your final plan should be BETTER than your draft.

{plan_format}
`;

const SYNTHESIS_PROMPT = `# Synthesis Task

Combine multiple agent plans into a unified plan.

## Task
{task}
{user_changes_section}## Agent Plans

{agent_plans}

## Instructions
1. Identify common themes across plans
2. Note where plans diverge—pick the best approach or flag for user
3. Combine the best ideas from each plan
4. Merge into a coherent unified plan

If agents disagree, add a ## Conflicts section explaining the options.

Write your unified plan to: \`{output_file}\`

{plan_format}
`;

const SYNTHESIS_USER_CHANGES = `
## User's Changes From Previous Turn (IMPORTANT)

The user made these changes to the plan:

{user_diff}

**Interpret user intent:**
- **New requirements** (firm statements like "Must support X"): MUST appear in final plan
- **Questions** ("What about..?", "Should we..?"): Verify agents addressed them;
  include the ANSWER in the plan, not the question itself
- **Uncertain language** ("maybe", "consider", "could"): Treat as suggestions to
  evaluate against agent plans, not hard requirements
- **Comments/TODOs** (<!-- -->, TODO:, NOTE:): Notes for agents, not final plan content
- **Deletions**: Do NOT re-add deleted content under any circumstances

**Key principle:** Respect the user's INTENT, not just their exact words.
If the user asked a question, the agents should have answered it—synthesize their answer.
If the user deleted something, it stays deleted even if agents still mention it.

**Managing the Clarifications section:**
- **Assumptions:** If user corrects one, use strikethrough: ~~old~~ → new
- **Questions:** When answered, fill in the **Answer:** field
- **New user questions:** If user asks something anywhere in the doc, add it as a new Q
  in Clarifications with your "My lean" — don't leave raw questions scattered in the plan
`;

const REFINE_PROMPT = `# Plan Refinement Task (Turn {turn})

The user edited the plan. Interpret their changes and improve.

## Task
{task}

## Current Plan
Read the current synthesized plan from: \`{plan_file}\`

This is your starting point - it represents the merged consensus from all agents.

## User's Changes (Diff)
\`\`\`diff
{diff}
\`\`\`

## Instructions
Interpret the user's edits:
- **Deletions**: User doesn't want this. Remove or rethink.
- **Additions**: User added text. This is a requirement or question.
- **Questions in text**: User wants these answered. Address directly.
- **Comments**: User feedback. Incorporate and remove marker.
- **Unchanged sections**: User is satisfied. Keep unless you can improve.

User's direct edits are REQUIREMENTS - incorporate them exactly.
User's questions need your THINKING - address each thoroughly.

Write your updated plan to: \`{output_file}\`

{plan_format}
`;

function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ""));
}

export function getDraftPrompt(params: {
  task: string;
  turn: number;
  outputFile: string;
  planFile?: string;
  userFeedback?: string;
}): string {
  const { task, turn, outputFile, planFile, userFeedback } = params;
  if (turn === 1) {
    return format(DRAFT_PROMPT_INITIAL, {
      task,
      output_file: outputFile,
      plan_format: PLAN_FORMAT,
    });
  }

  return format(DRAFT_PROMPT, {
    task,
    turn,
    plan_file: planFile ?? "",
    user_feedback: userFeedback || "No specific feedback - improve as you see fit.",
    output_file: outputFile,
    plan_format: PLAN_FORMAT,
  });
}

export function getPeerReviewPrompt(params: {
  task: string;
  ownDraft: string;
  peerId: string;
  peerDraft: string;
}): string {
  const { task, ownDraft, peerId, peerDraft } = params;
  return format(PEER_REVIEW_PROMPT, {
    task,
    own_draft: ownDraft,
    peer_id: peerId,
    peer_draft: peerDraft,
    plan_format: PLAN_FORMAT,
  });
}

export function getSynthesisPrompt(params: {
  task: string;
  agentPlans: Record<string, string>;
  outputFile: string;
  userDiff?: string;
}): string {
  const { task, agentPlans, outputFile, userDiff } = params;

  let plansText = "";
  for (const [agentId, plan] of Object.entries(agentPlans)) {
    plansText += `### ${agentId}\n\n${plan}\n\n`;
  }

  const userChangesSection = userDiff
    ? format(SYNTHESIS_USER_CHANGES, { user_diff: userDiff })
    : "";

  return format(SYNTHESIS_PROMPT, {
    task,
    user_changes_section: userChangesSection,
    agent_plans: plansText,
    output_file: outputFile,
    plan_format: PLAN_FORMAT,
  });
}

export function getRefinePrompt(params: {
  task: string;
  turn: number;
  planFile: string;
  outputFile: string;
  diff: string;
}): string {
  const { task, turn, planFile, outputFile, diff } = params;
  return format(REFINE_PROMPT, {
    task,
    turn,
    plan_file: planFile,
    output_file: outputFile,
    diff,
    plan_format: PLAN_FORMAT,
  });
}
