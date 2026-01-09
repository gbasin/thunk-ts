import { describe, expect, it } from "bun:test";

import {
  PLAN_FORMAT,
  getDraftPrompt,
  getPeerReviewPrompt,
  getSynthesisPrompt,
} from "../src/prompts";

describe("getDraftPrompt", () => {
  it("includes instructions for turn 1", () => {
    const prompt = getDraftPrompt({
      task: "Add caching layer",
      turn: 1,
      outputFile: "/path/to/plan.md",
    });

    expect(prompt).toContain("Add caching layer");
    expect(prompt).toContain("Turn 1");
    expect(prompt).toContain("/path/to/plan.md");
    expect(prompt).toContain("Explore the codebase");
    expect(prompt).toContain(PLAN_FORMAT.trim());
  });

  it("includes feedback for later turns", () => {
    const prompt = getDraftPrompt({
      task: "Add caching layer",
      turn: 2,
      outputFile: "/path/to/plan.md",
      planFile: "/path/to/working.md",
      userFeedback: "Please add Redis support",
    });

    expect(prompt).toContain("Turn 2");
    expect(prompt).toContain("/path/to/working.md");
    expect(prompt).toContain("Please add Redis support");
  });

  it("defaults feedback when missing", () => {
    const prompt = getDraftPrompt({
      task: "Add caching layer",
      turn: 2,
      outputFile: "/path/to/plan.md",
      planFile: "/path/to/working.md",
    });

    expect(prompt).toContain("No specific feedback");
  });
});

describe("getPeerReviewPrompt", () => {
  it("includes peer review data", () => {
    const prompt = getPeerReviewPrompt({
      task: "Add caching layer",
      ownDraft: "My plan",
      peerId: "sunny-glade",
      peerDraft: "Peer plan",
    });

    expect(prompt).toContain("Add caching layer");
    expect(prompt).toContain("My plan");
    expect(prompt).toContain("sunny-glade");
    expect(prompt).toContain("Peer plan");
  });
});

describe("getSynthesisPrompt", () => {
  it("includes agent plans", () => {
    const prompt = getSynthesisPrompt({
      task: "Add caching layer",
      agentPlans: {
        opus: "Opus plan content",
        codex: "Codex plan content",
      },
      outputFile: "/path/to/synthesis.md",
    });

    expect(prompt).toContain("Opus plan content");
    expect(prompt).toContain("Codex plan content");
    expect(prompt).toContain("/path/to/synthesis.md");
  });

  it("includes user diff when provided", () => {
    const userDiff = "```diff\n- Task 3\n+ Task 3: Redis\n```";
    const prompt = getSynthesisPrompt({
      task: "Add caching layer",
      agentPlans: { opus: "Opus plan" },
      outputFile: "/path/to/synthesis.md",
      userDiff,
    });

    expect(prompt).toContain("User's Changes From Previous Turn");
    expect(prompt).toContain("Redis");
  });
});

describe("PLAN_FORMAT", () => {
  it("includes required sections", () => {
    expect(PLAN_FORMAT).toContain("## Questions");
    expect(PLAN_FORMAT).toContain("## Summary");
    expect(PLAN_FORMAT).toContain("## Tasks");
    expect(PLAN_FORMAT).toContain("## Risks");
  });
});
