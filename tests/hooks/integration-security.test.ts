/** Hook regressions: integration-security. */
import { describe, test, beforeAll, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runHook, rmSyncRobust, useHookIntegrationFixture } from "./integration-fixture.js";
useHookIntegrationFixture();


// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════
// initSecurity loud-failure regression (#466)
// ═══════════════════════════════════════════════════════════════════════
describe("initSecurity loud-failure (#466)", () => {
  test("warns to stderr when build/security.js is missing", async () => {
    const ROUTING_PATH = join(__dirname, "..", "..", "hooks", "core", "routing.mjs");
    const missingBuildDir = join(tmpdir(), `ctx-no-build-${Date.now()}`);
    // Subprocess so the warning isn't deduped by a prior call in this process.
    const code = `
      const { initSecurity } = await import(${JSON.stringify(pathToFileURL(ROUTING_PATH).href)});
      const ok = await initSecurity(${JSON.stringify(missingBuildDir)});
      process.stdout.write(JSON.stringify({ ok }));
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf-8",
      timeout: 10000,
      env: {
        ...process.env,
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "",
        // #558 v1.0.127: initSecurity is now bundle-first. To exercise the
        // "both missing → loud fail" contract, point the bundle test seam at
        // a non-existent path so neither the bundle nor build/security.js
        // can be loaded.
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: join(missingBuildDir, "no-bundle.mjs"),
      },
    });
    assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false, "initSecurity should return false when both bundle and security.js missing");
    assert.ok(
      r.stderr.includes("security deny patterns will NOT be enforced"),
      `expected loud warning on stderr, got: ${r.stderr}`,
    );
  });

  test("CONTEXT_MODE_SUPPRESS_SECURITY_WARNING silences the warning", async () => {
    const ROUTING_PATH = join(__dirname, "..", "..", "hooks", "core", "routing.mjs");
    const missingBuildDir = join(tmpdir(), `ctx-no-build-${Date.now()}-silent`);
    const code = `
      const { initSecurity } = await import(${JSON.stringify(pathToFileURL(ROUTING_PATH).href)});
      await initSecurity(${JSON.stringify(missingBuildDir)});
    `;
    const r = spawnSync("node", ["--input-type=module", "-e", code], {
      encoding: "utf-8",
      timeout: 10000,
      env: {
        ...process.env,
        CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1",
        // #558 v1.0.127: bundle-first — hide the bundle so the warn-or-suppress
        // codepath actually runs (otherwise bundle loads and warning never fires).
        CONTEXT_MODE_SECURITY_BUNDLE_PATH: join(missingBuildDir, "no-bundle.mjs"),
      },
    });
    assert.equal(r.status, 0);
    assert.ok(
      !r.stderr.includes("security deny patterns will NOT be enforced"),
      `expected suppressed warning, got: ${r.stderr}`,
    );
  });
});


describe("Security Policy Enforcement", () => {
  let ISOLATED_HOME: string;
  let MOCK_PROJECT_DIR: string;
  let secEnv: Record<string, string>;

  beforeAll(() => {
    // Set up isolated temp dirs for security tests
    ISOLATED_HOME = join(tmpdir(), `hook-sec-home-${Date.now()}`);
    MOCK_PROJECT_DIR = join(tmpdir(), `hook-sec-project-${Date.now()}`);
    const mockClaudeDir = join(MOCK_PROJECT_DIR, ".claude");
    mkdirSync(join(ISOLATED_HOME, ".claude"), { recursive: true });
    mkdirSync(mockClaudeDir, { recursive: true });

    // Write deny/allow patterns to project settings
    writeFileSync(
      join(mockClaudeDir, "settings.json"),
      JSON.stringify({
        permissions: {
          deny: ["Bash(sudo *)", "Bash(rm -rf /*)", "Read(.env)", "Read(**/.env*)"],
          allow: ["Bash(git:*)", "Bash(ls:*)"],
        },
      }),
    );

    secEnv = { HOME: ISOLATED_HOME, CLAUDE_PROJECT_DIR: MOCK_PROJECT_DIR };
  });

  afterAll(() => {
    try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch {}
    try { rmSync(MOCK_PROJECT_DIR, { recursive: true, force: true }); } catch {}
  });

  test("Security: Bash + sudo denied by deny pattern", () => {
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "sudo apt install vim" } },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("deny pattern"));
  });

  test("Security: Bash + git allowed, falls through to Stage 2", () => {
    // Use an unbounded command — `git status` now short-circuits via the
    // #463 allowlist before reaching the guidance branch, so it would no
    // longer exercise "falls through to Stage 2 routing → context guidance".
    const result = runHook(
      { tool_name: "Bash", tool_input: { command: "git diff" } },
      secEnv,
    );
    // git is in allow list -> falls through to Stage 2 routing
    // Stage 2: git diff is not in the structurally-bounded allowlist
    // (raw diff can be huge) -> additionalContext with BASH_GUIDANCE
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext, "Allowed Bash command should get additionalContext");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> in Bash additionalContext",
    );
  });

  test("Security: MCP execute + shell + sudo denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute",
        tool_input: { language: "shell", code: "sudo rm -rf /" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  test("Security: MCP execute + python (non-shell) passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute",
        tool_input: { language: "python", code: "print('hello')" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Non-shell language should passthrough");
  });

  test("MCP execute + shell pins cwd from hook input over stale CLAUDE_PROJECT_DIR (#756)", () => {
    const mainRepo = mkdtempSync(join(tmpdir(), "ctx-756-main-"));
    const worktree = mkdtempSync(join(tmpdir(), "ctx-756-worktree-"));
    try {
      const result = runHook(
        {
          cwd: worktree,
          tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute",
          tool_input: { language: "shell", code: "pwd" },
        },
        { ...secEnv, CLAUDE_PROJECT_DIR: mainRepo },
      );
      assert.equal(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput.updatedInput.cwd, worktree);
      assert.equal(parsed.hookSpecificOutput.updatedInput.code, "pwd");
    } finally {
      rmSyncRobust(mainRepo);
      rmSyncRobust(worktree);
    }
  });

  test("Security: MCP execute_file + .env path denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        tool_input: { path: ".env", language: "shell", code: "cat" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(parsed.hookSpecificOutput.permissionDecisionReason.includes("Read deny pattern"));
  });

  test("Security: MCP execute_file + safe path passthrough", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        tool_input: { path: "src/app.ts", language: "javascript", code: "console.log('ok')" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "", "Safe path should passthrough");
  });

  test("Security: MCP execute_file + safe path but sudo in shell code denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        tool_input: { path: "src/app.sh", language: "shell", code: "sudo rm -rf /" },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  test("Security: MCP batch_execute with sudo in one command denied", () => {
    const result = runHook(
      {
        tool_name: "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        tool_input: {
          commands: [
            { label: "list", command: "ls -la" },
            { label: "evil", command: "sudo rm -rf /" },
          ],
        },
      },
      secEnv,
    );
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
  });

  test("MCP batch_execute with allowed commands pins cwd from hook input (#756)", () => {
    const worktree = mkdtempSync(join(tmpdir(), "ctx-756-batch-worktree-"));
    try {
      const result = runHook(
        {
          cwd: worktree,
          tool_name: "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
          tool_input: {
            commands: [
              { label: "list", command: "ls -la" },
              { label: "git", command: "git log --oneline -5" },
            ],
          },
        },
        secEnv,
      );
      assert.equal(result.exitCode, 0);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.hookSpecificOutput.updatedInput.cwd, worktree);
    } finally {
      rmSyncRobust(worktree);
    }
  });
});
