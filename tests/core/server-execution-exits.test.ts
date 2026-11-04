/** Server regressions: execution-exits. */


import { describe, test, expect } from "vitest";
import { classifyNonZeroExit } from "../../src/exit-classify.js";




// ═══════════════════════════════════════════════════════════════════════════
// 1. Non-zero Exit Code Classification (preserve failures)
// ═══════════════════════════════════════════════════════════════════════════

describe("Non-zero Exit Code Classification", () => {
  // Shell exit 1 cannot distinguish grep no-match from failed tests.

  test("shell exit 1 with stdout remains an error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "file1.ts:10: writeRouting\nfile2.ts:20: writeRouting",
      stderr: "",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("file1.ts:10: writeRouting\nfile2.ts:20: writeRouting");
  });

  test("shell exit 1 with empty stdout → real error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "",
      stderr: "",
    });
    expect(result.isError).toBe(true);
  });

  test("shell exit 1 with whitespace-only stdout → real error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "   \n  ",
      stderr: "",
    });
    expect(result.isError).toBe(true);
  });

  // ── Hard errors: exit code >= 2 ──

  test("shell exit 2 (grep bad regex) → always error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 2,
      stdout: "",
      stderr: "grep: Invalid regular expression",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 2");
    expect(result.output).toContain("grep: Invalid regular expression");
  });

  test("shell exit 127 (command not found) → always error", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 127,
      stdout: "",
      stderr: "bash: nonexistent: command not found",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 127");
  });

  // ── Non-shell languages: always error ──

  test("javascript exit 1 with stdout → still an error (not shell)", () => {
    const result = classifyNonZeroExit({
      language: "javascript",
      exitCode: 1,
      stdout: "some output before crash",
      stderr: "TypeError: x is not a function",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 1");
  });

  test("python exit 1 with stdout → still an error (not shell)", () => {
    const result = classifyNonZeroExit({
      language: "python",
      exitCode: 1,
      stdout: "partial output",
      stderr: "Traceback (most recent call last):",
    });
    expect(result.isError).toBe(true);
  });

  test("typescript exit 1 with stdout → still an error (not shell)", () => {
    const result = classifyNonZeroExit({
      language: "typescript",
      exitCode: 1,
      stdout: "output",
      stderr: "",
    });
    expect(result.isError).toBe(true);
  });

  // ── Output format ──

  test("failed shell tests preserve exit code and stderr even with stdout", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "1 test failed",
      stderr: "AssertionError: expected true",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 1");
    expect(result.output).toContain("1 test failed");
    expect(result.output).toContain("AssertionError: expected true");
  });

  test("hard error output includes exit code, stdout, and stderr", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 2,
      stdout: "partial",
      stderr: "error msg",
    });
    expect(result.output).toContain("Exit code: 2");
    expect(result.output).toContain("partial");
    expect(result.output).toContain("error msg");
  });

  test("hard-fail with empty stdout still forwards stderr in output", () => {
    const result = classifyNonZeroExit({
      language: "shell",
      exitCode: 1,
      stdout: "",
      stderr: "command not found",
    });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("Exit code: 1");
    expect(result.output).toContain("command not found");
  });

  test("hard-fail output has labeled 'stdout:' and 'stderr:' sections", () => {
    const result = classifyNonZeroExit({
      language: "node",
      exitCode: 137,
      stdout: "S",
      stderr: "E",
    });
    expect(result.output).toMatch(/stdout:\s*\nS/);
    expect(result.output).toMatch(/stderr:\s*\nE/);
  });
});
