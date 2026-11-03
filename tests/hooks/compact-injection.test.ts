/** Hook regressions: compact-injection. */
import { describe, test, expect, beforeAll } from "vitest";


// ═══════════════════════════════════════════════════════════════════════
// buildAutoInjection — compaction auto-injection logic
// ═══════════════════════════════════════════════════════════════════════

describe("buildAutoInjection", () => {
  let buildAutoInjection: (events: Array<{category: string; data: string}>) => string;
  let estimateTokens: (text: string) => number;

  beforeAll(async () => {
    const mod = await import("../../hooks/auto-injection.mjs");
    buildAutoInjection = mod.buildAutoInjection;
    estimateTokens = mod.estimateTokens;
  });

  test("returns empty for no events", () => {
    const result = buildAutoInjection([]);
    expect(result).toBe("");
  });

  test("includes role as behavioral_directive", () => {
    const events = [
      { category: "role", data: "You are a senior staff engineer" },
    ];
    const result = buildAutoInjection(events);
    expect(result).toContain("<behavioral_directive>");
    expect(result).toContain("senior staff engineer");
    expect(result).toContain("</behavioral_directive>");
  });

  test("includes decisions as rules", () => {
    const events = [
      { category: "decision", data: "Use ctx- prefix instead of cm-" },
      { category: "decision", data: "Never push to main without asking" },
    ];
    const result = buildAutoInjection(events);
    expect(result).toContain("<rules>");
    expect(result).toContain("ctx- prefix");
    expect(result).toContain("Never push");
    expect(result).toContain("</rules>");
  });

  test("includes skill names", () => {
    const events = [
      { category: "skill", data: "tdd" },
      { category: "skill", data: "commit" },
    ];
    const result = buildAutoInjection(events);
    expect(result).toContain("<active_skills>");
    expect(result).toContain("tdd");
    expect(result).toContain("commit");
    expect(result).toContain("</active_skills>");
  });

  test("token budget cap 500", () => {
    // Fill with many large events to test budget enforcement
    const events = [];
    for (let i = 0; i < 20; i++) {
      events.push({ category: "decision", data: "A".repeat(200) });
    }
    events.push({ category: "role", data: "B".repeat(400) });
    events.push({ category: "intent", data: "implement" });
    for (let i = 0; i < 50; i++) {
      events.push({ category: "skill", data: `skill-${i}` });
    }
    const result = buildAutoInjection(events);
    const tokens = estimateTokens(result);
    // The budget is 500 tokens. Role (P1) is never truncated but decisions
    // overflow to 3. Total should stay near or under budget.
    expect(tokens).toBeLessThanOrEqual(600); // allow small overshoot from structural XML
  });
});
