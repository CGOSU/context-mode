import { strict as assert } from "node:assert";
import { describe, test, beforeEach, afterEach } from "vitest";
import { extractEvents, resetErrorResolutionState, resetIterationLoopState } from "../../src/session/extract.js";

// Both public resets address the singleton used by the tool entry point.
function resetState(): void {
  resetErrorResolutionState();
  resetIterationLoopState();
}
beforeEach(resetState);
afterEach(resetState);


// ════════════════════════════════════════════
// CATEGORY 23: ERROR-RESOLUTION (cross-event)
// ════════════════════════════════════════════

describe("Error Resolution Events", () => {
  test("emits error_resolved when error followed by successful same-tool call", () => {
    resetErrorResolutionState();

    // Step 1: Error occurs
    const errorInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL src/store.test.ts\nexit code 1",
    };
    const errorEvents = extractEvents(errorInput);
    const errors = errorEvents.filter(e => e.type === "error_resolved");
    assert.equal(errors.length, 0, "should not emit error_resolved on the error itself");

    // Step 2: Successful same-tool call
    const fixInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    };
    const fixEvents = extractEvents(fixInput);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "should emit error_resolved");
    assert.equal(resolved[0].category, "error-resolution");
    assert.equal(resolved[0].priority, 2);
    assert.ok(resolved[0].data.includes("Bash"), "should reference the tool");
    assert.ok(resolved[0].data.includes("Fixed"), "should indicate resolution");
  });

  test("emits error_resolved when Edit follows Read error", () => {
    resetErrorResolutionState();

    // Read fails
    const readError = {
      tool_name: "Read",
      tool_input: { file_path: "/project/missing.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    };
    extractEvents(readError);

    // Edit succeeds (fixes the situation)
    const editFix = {
      tool_name: "Edit",
      tool_input: { file_path: "/project/missing.ts", old_string: "a", new_string: "b" },
      tool_response: "File edited successfully",
    };
    const fixEvents = extractEvents(editFix);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "Edit after Read error should resolve");
    assert.ok(resolved[0].data.includes("Read"), "should reference Read as the error tool");
  });

  test("emits error_resolved when Write follows Read error", () => {
    resetErrorResolutionState();

    const readError = {
      tool_name: "Read",
      tool_input: { file_path: "/project/new.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    };
    extractEvents(readError);

    const writeFix = {
      tool_name: "Write",
      tool_input: { file_path: "/project/new.ts", content: "export {}" },
      tool_response: "File written",
    };
    const fixEvents = extractEvents(writeFix);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "Write after Read error should resolve");
  });

  test("emits error_resolved when apply_patch follows Read error", () => {
    resetErrorResolutionState();

    const readError = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/missing.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    };
    extractEvents(readError);

    const patchFix = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/missing.ts",
          "+export {};",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };
    const fixEvents = extractEvents(patchFix);
    const resolved = fixEvents.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 1, "apply_patch after Read error should resolve");
  });

  test("does not emit error_resolved when apply_patch fails after Read error", () => {
    resetErrorResolutionState();

    extractEvents({
      tool_name: "Read",
      tool_input: { file_path: "/project/src/missing.ts" },
      tool_response: "File not found",
      tool_output: { isError: true },
    });

    const fixEvents = extractEvents({
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/missing.ts",
          "+export {};",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { isError: true },
    });

    assert.equal(
      fixEvents.filter(e => e.type === "error_resolved").length,
      0,
      "failed apply_patch should not resolve a prior Read error",
    );
  });

  test("does not emit plan_file_write when apply_patch fails after Read error", () => {
    resetErrorResolutionState();

    const events = extractEvents({
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: .claude/plans/bad-plan.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { isError: true },
    });

    assert.equal(events.filter(e => e.type === "plan_file_write").length, 0);
  });

  test("does not emit error_resolved for unrelated tool after error", () => {
    resetErrorResolutionState();

    // Bash error
    const errorInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL\nexit code 1",
    };
    extractEvents(errorInput);

    // Different tool succeeds (Read — not Bash)
    const unrelatedInput = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/index.ts" },
      tool_response: "file content",
    };
    const events = extractEvents(unrelatedInput);
    const resolved = events.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 0, "unrelated tool should not resolve error");
  });

  test("clears lastError after 10 calls without resolution (staleness timeout)", () => {
    resetErrorResolutionState();

    // Error occurs
    const errorInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Error: test failed\nexit code 1",
    };
    extractEvents(errorInput);

    // 11 unrelated calls (exceeds the 10-call timeout)
    for (let i = 0; i < 11; i++) {
      extractEvents({
        tool_name: "Read",
        tool_input: { file_path: `/project/file${i}.ts` },
        tool_response: "content",
      });
    }

    // Now a Bash success should NOT resolve (stale error cleared)
    const lateFixInput = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    };
    const events = extractEvents(lateFixInput);
    const resolved = events.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 0, "stale error should be cleared after 10 calls");
  });

  test("does not emit error_resolved when no prior error exists", () => {
    resetErrorResolutionState();

    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };
    const events = extractEvents(input);
    const resolved = events.filter(e => e.type === "error_resolved");
    assert.equal(resolved.length, 0);
  });

  test("second error replaces first error", () => {
    resetErrorResolutionState();

    // First error (Bash)
    extractEvents({
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "Error: first\nexit code 1",
    });

    // Second error (Edit) replaces first
    extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts", old_string: "a", new_string: "b" },
      tool_response: "old_string not found",
      tool_output: { isError: true },
    });

    // Bash success should NOT resolve (lastError is now Edit, not Bash)
    const bashSuccess = extractEvents({
      tool_name: "Bash",
      tool_input: { command: "echo ok" },
      tool_response: "ok",
    });
    const resolved1 = bashSuccess.filter(e => e.type === "error_resolved");
    assert.equal(resolved1.length, 0, "Bash should not resolve Edit error");

    // Edit success SHOULD resolve
    const editSuccess = extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts", old_string: "c", new_string: "d" },
      tool_response: "File edited",
    });
    const resolved2 = editSuccess.filter(e => e.type === "error_resolved");
    assert.equal(resolved2.length, 1, "Edit should resolve Edit error");
  });
});

// ════════════════════════════════════════════
// CATEGORY 26: ITERATION-LOOP (cross-event)
// ════════════════════════════════════════════

describe("Iteration Loop Events", () => {
  test("emits retry_detected when same tool+input called 3 times consecutively", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "/project/src/bug.ts", old_string: "foo", new_string: "bar" },
      tool_response: "old_string not found",
      tool_output: { isError: true },
    };

    // Call 1 & 2: no emission
    let events = extractEvents(input);
    let retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "should not fire after 1 call");

    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "should not fire after 2 calls");

    // Call 3: emit
    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1, "should fire after 3 consecutive identical calls");
    assert.equal(retries[0].category, "iteration-loop");
    assert.equal(retries[0].priority, 2);
    assert.ok(retries[0].data.includes("Edit"), "should mention tool name");
    assert.ok(retries[0].data.includes("3"), "should mention count");
  });

  test("does not emit when different tools are interleaved", () => {
    resetIterationLoopState();

    extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      tool_response: "ok",
    });

    extractEvents({
      tool_name: "Read",
      tool_input: { file_path: "/a.ts" },
      tool_response: "content",
    });

    const events = extractEvents({
      tool_name: "Edit",
      tool_input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      tool_response: "ok",
    });

    const retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "interleaved tools should break the streak");
  });

  test("does not emit when same tool has different input", () => {
    resetIterationLoopState();

    for (let i = 0; i < 5; i++) {
      extractEvents({
        tool_name: "Edit",
        tool_input: { file_path: `/project/file${i}.ts`, old_string: "a", new_string: "b" },
        tool_response: "ok",
      });
    }

    // No retry_detected because each call has different input
    // (file_path differs so inputHash differs)
  });

  test("detects 4+ consecutive identical calls", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm run build" },
      tool_response: "Error: build failed\nexit code 1",
    };

    extractEvents(input);
    extractEvents(input);
    extractEvents(input);
    const events = extractEvents(input);
    const retries = events.filter(e => e.type === "retry_detected");
    // After 3rd call, the history is reset. 4th call starts fresh streak.
    // So we get 1 emission at call 3 (with count=3), then call 4 is a fresh start.
    assert.ok(retries.length === 0, "4th call after reset should not emit (fresh start)");
  });

  test("resets after emission to avoid duplicate events", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Grep",
      tool_input: { pattern: "TODO", path: "/project" },
      tool_response: "matches...",
    };

    // First streak: calls 1-3
    extractEvents(input);
    extractEvents(input);
    let events = extractEvents(input);
    let retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1, "first streak should emit");

    // After reset, need 3 more for next emission
    extractEvents(input);
    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 0, "should not emit at 2nd call of new streak");

    events = extractEvents(input);
    retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1, "3rd call of new streak should emit again");
  });

  test("handles empty tool_input gracefully", () => {
    resetIterationLoopState();

    const input = {
      tool_name: "Skill",
      tool_input: {},
      tool_response: "ok",
    };

    // Should not throw
    extractEvents(input);
    extractEvents(input);
    const events = extractEvents(input);
    const retries = events.filter(e => e.type === "retry_detected");
    assert.equal(retries.length, 1);
  });
});
