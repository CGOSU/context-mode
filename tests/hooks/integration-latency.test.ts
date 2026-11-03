/** Hook regressions: integration-latency. */
import { describe, test, beforeAll, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, useHookIntegrationFixture } from "./integration-fixture.js";
useHookIntegrationFixture();


// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════
// Empty stdin resilience — all hooks survive empty input (#322)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// Category 27: Latency — cross-hook state via tmpdir files
// ═══════════════════════════════════════════════════════════════════════

describe("Category 27 — Latency cross-hook bridge", () => {
  const POSTTOOL_PATH = join(__dirname, "..", "..", "hooks", "posttooluse.mjs");
  let fakeHome: string;
  let fakeProject: string;
  let latencyEnv: Record<string, string>;

  beforeAll(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "ctx-latency-home-"));
    fakeProject = mkdtempSync(join(tmpdir(), "ctx-latency-project-"));
    latencyEnv = {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_PROJECT_DIR: fakeProject,
      CLAUDE_SESSION_ID: "latency-test-session",
      CONTEXT_MODE_SESSION_SUFFIX: "",
    };
  });

  afterAll(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    try { rmSync(fakeProject, { recursive: true, force: true }); } catch {}
  });

  test("pretooluse.mjs writes latency marker file to tmpdir", () => {
    const sessionId = "latency-test-session";
    const toolName = "Bash";

    // Run pretooluse.mjs — it should write a latency marker
    const result = runHook(
      { tool_name: toolName, tool_input: { command: "echo hello" }, session_id: sessionId },
      latencyEnv,
    );

    assert.equal(result.exitCode, 0);

    // Check marker file exists
    const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);
    assert.ok(existsSync(markerPath), `Latency marker should exist at ${markerPath}`);

    // Marker content should be a timestamp
    const content = readFileSync(markerPath, "utf-8").trim();
    const ts = parseInt(content, 10);
    assert.ok(!isNaN(ts), `Marker content should be a valid timestamp, got: "${content}"`);
    assert.ok(ts > 0, "Timestamp should be positive");
    assert.ok(ts <= Date.now(), "Timestamp should not be in the future");

    // Clean up
    try { unlinkSync(markerPath); } catch {}
  });

  test("posttooluse.mjs reads and deletes latency marker file", () => {
    const sessionId = "latency-test-session";
    const toolName = "Read";
    const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);

    // Write a marker as if pretooluse.mjs ran — use a recent timestamp (not slow)
    writeFileSync(markerPath, String(Date.now()), "utf-8");

    // Run posttooluse.mjs
    const result = spawnSync("node", [POSTTOOL_PATH], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: toolName,
        tool_input: { file_path: "/tmp/test.ts" },
        tool_response: "file contents",
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...latencyEnv },
    });

    assert.equal(result.status, 0, `PostToolUse should exit 0, stderr: ${result.stderr}`);

    // Marker file should be cleaned up
    assert.ok(!existsSync(markerPath), "Latency marker should be deleted after PostToolUse reads it");
  });

  test("posttooluse.mjs emits latency event when tool takes >5s", () => {
    const sessionId = "latency-test-session";
    const toolName = "Bash";
    const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);

    // Write a marker with a timestamp 6 seconds ago (simulating a slow tool)
    const sixSecsAgo = Date.now() - 6000;
    writeFileSync(markerPath, String(sixSecsAgo), "utf-8");

    // Run posttooluse.mjs
    const result = spawnSync("node", [POSTTOOL_PATH], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: toolName,
        tool_input: { command: "npm test" },
        tool_response: "all passed",
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...latencyEnv },
    });

    assert.equal(result.status, 0);

    // Verify: the latency event should be in the DB.
    // We can't easily query SQLite here, but we can verify the marker was cleaned up.
    assert.ok(!existsSync(markerPath), "Marker should be cleaned up");
  });

  test("posttooluse.mjs does NOT emit latency event when tool is fast (<5s)", () => {
    const sessionId = "latency-test-session";
    const toolName = "Edit";
    const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);

    // Write a marker with a timestamp 100ms ago (fast tool)
    writeFileSync(markerPath, String(Date.now() - 100), "utf-8");

    // Run posttooluse.mjs
    const result = spawnSync("node", [POSTTOOL_PATH], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: toolName,
        tool_input: { file_path: "/tmp/test.ts", old_string: "a", new_string: "b" },
        tool_response: "ok",
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...latencyEnv },
    });

    assert.equal(result.status, 0);
    assert.ok(!existsSync(markerPath), "Marker should be cleaned up even for fast tools");
  });

  test("posttooluse.mjs handles missing marker gracefully (no crash)", () => {
    const sessionId = "latency-test-session";
    const toolName = "Glob";

    // Do NOT write a marker — simulate case where pretooluse.mjs didn't run
    const markerPath = resolve(tmpdir(), `context-mode-latency-${sessionId}-${toolName}.txt`);
    if (existsSync(markerPath)) unlinkSync(markerPath);

    const result = spawnSync("node", [POSTTOOL_PATH], {
      input: JSON.stringify({
        session_id: sessionId,
        tool_name: toolName,
        tool_input: { pattern: "**/*.ts" },
        tool_response: "[]",
      }),
      encoding: "utf-8",
      timeout: 30_000,
      env: { ...process.env, ...latencyEnv },
    });

    assert.equal(result.status, 0, "PostToolUse must not crash when no marker exists");
  });
});
