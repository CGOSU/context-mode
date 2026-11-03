/** Shared protocol runner/assertions; lifecycle is explicitly installed per suite. */
import { afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync, rmdirSync, readdirSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { useMcpReadyFixture } from "./mcp-ready-fixture.js";


// Robust recursive delete — fs.rmSync silently no-ops on Windows when the
// target path lives under a tmpdir whose name contains non-ASCII chars (#454).
export function rmSyncRobust(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  if (!existsSync(dir)) return;
  try {
    for (const name of readdirSync(dir)) {
      try { unlinkSync(resolve(dir, name)); } catch {}
    }
    rmdirSync(dir);
  } catch {}
}


// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOOK_PATH = join(__dirname, "..", "..", "hooks", "pretooluse.mjs");


// Clean guidance throttle markers before each test so guidance fires fresh.
// Subprocess hooks scope markers two ways (#298): the legacy ppid-based dir
// (kept as fallback when no sessionId is passed) and the sessionId-scoped dir
// (derived from getSessionId which falls back to `pid-${process.ppid}` when
// the hook payload has no session_id).
const _wid = process.env.VITEST_WORKER_ID;

const _guidanceSuffix = _wid ? `${process.pid}-w${_wid}` : String(process.pid);

const _guidanceDir = resolve(tmpdir(), `context-mode-guidance-${_guidanceSuffix}`);

const _sessionGuidanceDir = resolve(tmpdir(), `context-mode-guidance-s-pid-${process.pid}`);


interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}


export function runHook(input: Record<string, unknown>, env?: Record<string, string>, { bom = false } = {}): HookResult {
  const json = JSON.stringify(input);
  const result = spawnSync("node", [HOOK_PATH], {
    input: bom ? "\uFEFF" + json : json,
    encoding: "utf-8",
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}


/**
 * Assert hook redirects Bash command via `permissionDecision: "deny"` + reason.
 *
 * CC v2.1.x Bash tool ignores `updatedInput.command` substitution under
 * `permissionDecision: "allow"` — original command runs unchanged. Only
 * `permissionDecision: "deny"` is honored for Bash blocking (verified via
 * /diagnose Phase 4 forced-deny probe). The claude-code formatter now emits
 * a deny shape for modify intent and surfaces the routing guidance via
 * `permissionDecisionReason`.
 */
export function assertRedirect(result: HookResult, substringInReason: string) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.ok(result.stdout.length > 0, "Expected non-empty stdout for redirect");
  const parsed = JSON.parse(result.stdout);
  const hso = parsed.hookSpecificOutput;
  assert.ok(hso, "Expected hookSpecificOutput in response");
  assert.equal(
    hso.permissionDecision,
    "deny",
    `Expected permissionDecision="deny" (CC Bash ignores updatedInput on allow), got: ${hso.permissionDecision}`,
  );
  assert.ok(
    typeof hso.permissionDecisionReason === "string" && hso.permissionDecisionReason.length > 0,
    "Expected non-empty permissionDecisionReason",
  );
  assert.ok(
    hso.permissionDecisionReason.includes(substringInReason),
    `Expected reason to contain "${substringInReason}", got: ${hso.permissionDecisionReason}`,
  );
  assert.equal(
    hso.updatedInput,
    undefined,
    "updatedInput MUST NOT appear alongside deny — CC ignores it for Bash",
  );
}


/** Assert hook denies with permissionDecision: deny */
export function assertDeny(result: HookResult, substringInReason: string) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.ok(result.stdout.length > 0, "Expected non-empty stdout for deny");
  const parsed = JSON.parse(result.stdout);
  const hso = parsed.hookSpecificOutput;
  assert.ok(hso, "Expected hookSpecificOutput in response");
  assert.equal(hso.permissionDecision, "deny", `Expected permissionDecision=deny`);
  assert.ok(
    hso.permissionDecisionReason.includes(substringInReason),
    `Expected permissionDecisionReason to contain "${substringInReason}", got: ${hso.permissionDecisionReason}`,
  );
}


export function assertPassthrough(result: HookResult) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.equal(result.stdout, "", `Expected empty stdout for passthrough, got: "${result.stdout}"`);
}


export function assertHookSpecificOutput(result: HookResult, key: string) {
  assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
  assert.ok(result.stdout.length > 0, "Expected non-empty stdout for hookSpecificOutput");
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.hookSpecificOutput, "Expected hookSpecificOutput in response");
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.ok(
    parsed.hookSpecificOutput[key] !== undefined,
    `Expected hookSpecificOutput.${key} to be defined`,
  );
}

export function useHookIntegrationFixture() {
  useMcpReadyFixture(() => {
    rmSyncRobust(_guidanceDir);
    rmSyncRobust(_sessionGuidanceDir);
  });
  afterAll(() => {
    rmSyncRobust(_guidanceDir);
    rmSyncRobust(_sessionGuidanceDir);
  });
}
