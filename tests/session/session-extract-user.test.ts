import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractUserEvents } from "../../src/session/extract.js";


// ════════════════════════════════════════════
// SLICE 7: DECISION EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Decision Events", () => {
  test("extracts decision from user correction", () => {
    const events = extractUserEvents("no, use ctx- prefix instead of cm-");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 1);
    assert.ok(decisionEvents[0].data.includes("ctx-"));
  });

  test("extracts decision from a negation+alternative correction", () => {
    // Universal-rule detector (issue #535) treats a clause-separated
    // non-question message in the corrective length range as a decision.
    const events = extractUserEvents("never push to main, ask me first");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 1);
  });

  test("extracts decision from Turkish corrections", () => {
    const events = extractUserEvents("hayır, böyle değil, yerine ctx- kullan");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 1);
  });

  test("does not extract decision from regular messages", () => {
    const events = extractUserEvents("Can you read the server.ts file?");
    const decisionEvents = events.filter(e => e.type === "decision");
    assert.equal(decisionEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 8: RULE EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Role Events", () => {
  test("extracts role from persona directive", () => {
    const events = extractUserEvents("Act as a senior staff engineer for this review");
    const roleEvents = events.filter(e => e.type === "role");
    assert.equal(roleEvents.length, 1);
    assert.ok(roleEvents[0].data.includes("senior staff engineer"));
  });

  test("extracts role from 'you are' pattern", () => {
    const events = extractUserEvents("You are a principal architect. Review this design.");
    const roleEvents = events.filter(e => e.type === "role");
    assert.equal(roleEvents.length, 1);
  });
});

// ════════════════════════════════════════════
// SLICE 12: INTENT EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Intent Events", () => {
  test("extracts investigation intent", () => {
    const events = extractUserEvents("Why is the test failing? Can you debug this?");
    const intentEvents = events.filter(e => e.type === "intent");
    assert.equal(intentEvents.length, 1);
    assert.equal(intentEvents[0].data, "investigate");
  });

  test("extracts implementation intent", () => {
    const events = extractUserEvents("Create a new PostToolUse hook for event extraction");
    const intentEvents = events.filter(e => e.type === "intent");
    assert.equal(intentEvents.length, 1);
    assert.equal(intentEvents[0].data, "implement");
  });

  // The `review` and `discuss` modes were keyword-only and could not be
  // expressed as a robust universal-rule detector (issue #535). They are
  // intentionally dropped from the intent schema — the renderer now
  // surfaces the raw user message via <recent_user_messages> so the
  // next LLM can still distinguish review/discuss tone end-to-end.
});

// ════════════════════════════════════════════
// SLICE 13: DATA EVENT EXTRACTION (user messages)
// ════════════════════════════════════════════

describe("Data Events", () => {
  test("extracts data event from large user message", () => {
    const largeMessage = "Here is the config:\n" + "x".repeat(2000);
    const events = extractUserEvents(largeMessage);
    const dataEvents = events.filter(e => e.type === "data");
    assert.equal(dataEvents.length, 1);
    assert.equal(dataEvents[0].priority, 4);
    // data field preserves full message (no truncation)
    assert.equal(dataEvents[0].data, largeMessage);
  });

  test("does not extract data event from short message", () => {
    const events = extractUserEvents("Fix the bug please");
    const dataEvents = events.filter(e => e.type === "data");
    assert.equal(dataEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// CATEGORY 25: BLOCKED-ON (user messages)
// ════════════════════════════════════════════

describe("Blocked-On Events", () => {
  // Migrated to universal-rule detectors (issue #535). The old English
  // and Turkish keyword fixtures ("blocked on", "waiting for",
  // "bekliyor", "unblocked", ...) are intentionally no longer matched —
  // the universal-rule design relies on language-neutral
  // programming-domain markers (Error: / Exception: / Traceback / stack
  // frames) and Unicode checkmark / "fixed:" / "resolved:" prefixes.
  // For raw-message preservation see the <recent_user_messages>
  // safety-net section in tests/session/extract-multilang.test.ts.

  test("extracts blocker from 'Error:' programming-domain marker", () => {
    const events = extractUserEvents("Error: cannot read property of undefined");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(blockerEvents.length, 1);
    assert.equal(blockerEvents[0].category, "blocked-on");
    assert.equal(blockerEvents[0].priority, 2);
    assert.ok(blockerEvents[0].data.includes("cannot read property"));
  });

  test("extracts blocker from 'Exception:' marker", () => {
    const events = extractUserEvents("Exception: NullPointerException at line 42");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(blockerEvents.length, 1);
    assert.equal(blockerEvents[0].category, "blocked-on");
  });

  test("extracts blocker from Python 'Traceback' marker", () => {
    const events = extractUserEvents("Traceback (most recent call last):");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(blockerEvents.length, 1);
  });

  test("extracts blocker_resolved from Unicode checkmark", () => {
    const events = extractUserEvents("✅ unblocked now, got the credentials");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    assert.equal(resolvedEvents.length, 1);
    assert.equal(resolvedEvents[0].category, "blocked-on");
    assert.equal(resolvedEvents[0].priority, 2);
  });

  test("extracts blocker_resolved from 'fixed:' marker prefix", () => {
    const events = extractUserEvents("fixed: the cache miss in dev");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    assert.equal(resolvedEvents.length, 1);
  });

  test("extracts blocker_resolved from 'resolved:' marker prefix", () => {
    const events = extractUserEvents("resolved: deploy queue cleared");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    assert.equal(resolvedEvents.length, 1);
  });

  test("resolution takes priority over blocker when both shapes match", () => {
    // checkmark wins over Error: marker in the same message
    const events = extractUserEvents("✅ Error: was a stale build, fixed it");
    const resolvedEvents = events.filter(e => e.type === "blocker_resolved");
    const blockerEvents = events.filter(e => e.type === "blocker");
    assert.equal(resolvedEvents.length, 1, "should emit resolved");
    assert.equal(blockerEvents.length, 0, "should NOT emit blocker when resolved");
  });

  test("does not extract blocker from unrelated messages", () => {
    const events = extractUserEvents("Can you read the server.ts file?");
    const blockerEvents = events.filter(e => e.category === "blocked-on");
    assert.equal(blockerEvents.length, 0);
  });
});
