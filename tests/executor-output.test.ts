/** Executor regressions: executor-output. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { PolyglotExecutor } from "../src/executor.js";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe("Output Truncation", () => {
  test("stdout is returned in full without truncation", async () => {
    const small = new PolyglotExecutor({ runtimes });
    const r = await small.execute({
      language: "javascript",
      code: 'for (let i = 0; i < 100; i++) console.log(`line ${i}: ${"x".repeat(20)}`);',
    });
    assert.ok(!r.stdout.includes("truncated"), "stdout should NOT be truncated");
    assert.ok(r.stdout.includes("line 0"), "Should contain first line");
    assert.ok(r.stdout.includes("line 50"), "Should contain middle line (previously lost)");
    assert.ok(r.stdout.includes("line 99"), "Should contain last line");
    assert.ok(!r.stdout.includes("showing first"), "Should have no truncation marker");
  });

  test("does not truncate under limit", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("small output");',
    });
    assert.ok(!r.stdout.includes("truncated"));
  });

  test("stderr is also returned in full without truncation", async () => {
    const small = new PolyglotExecutor({ runtimes });
    const r = await small.execute({
      language: "javascript",
      code: `
        for (let i = 0; i < 50; i++) console.error("warn " + i);
        console.error("FINAL ERROR: something broke");
      `,
    });
    assert.ok(r.stderr.includes("FINAL ERROR"), "Should contain last error line");
    assert.ok(r.stderr.includes("warn 0"), "Should contain first warning");
    assert.ok(r.stderr.includes("warn 25"), "Should contain middle warning (previously lost)");
    assert.ok(!r.stderr.includes("truncated"), "stderr should NOT be truncated");
  });
});


describe("hardCapBytes Enforcement", () => {
  test("kills process when combined output exceeds byte cap", async () => {
    const cappedExecutor = new PolyglotExecutor({
      runtimes,
      hardCapBytes: 1024,
    });
    const r = await cappedExecutor.execute({
      language: "javascript",
      code: `for (let i = 0; i < 10000; i++) console.log("x".repeat(100));`,
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped at"), "Should indicate cap was hit");
    assert.notEqual(r.exitCode, 0, "Process should be killed (non-zero exit)");
  }, 15_000);

  test("stderr contributes to byte cap", async () => {
    const cappedExecutor = new PolyglotExecutor({
      runtimes,
      hardCapBytes: 1024,
    });
    const r = await cappedExecutor.execute({
      language: "javascript",
      code: `for (let i = 0; i < 10000; i++) console.error("e".repeat(100));`,
      timeout: 10_000,
    });
    assert.ok(r.stderr.includes("output capped at"), "stderr should trigger cap");
  }, 15_000);
});
