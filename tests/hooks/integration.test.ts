/** Hook regressions: integration. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { runHook, assertRedirect, assertDeny, assertPassthrough, assertHookSpecificOutput, useHookIntegrationFixture } from "./integration-fixture.js";
useHookIntegrationFixture();


// ═══════════════════════════════════════════════════════════════════════
// Hook Integration Tests -- pretooluse.mjs
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));


describe("Bash: Redirected Commands", () => {
  test("Bash + curl: redirected to echo via updatedInput", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "curl -s http://example.com" },
    });
    assertRedirect(result, "context-mode");
  });

  test("Bash + wget: redirected to echo via updatedInput", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "wget http://example.com/file.tar.gz" },
    });
    assertRedirect(result, "context-mode");
  });

  test("Bash + node -e with inline HTTP call: redirected to echo", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: `node -e "fetch('http://api.example.com/data')"` },
    });
    assertRedirect(result, "context-mode");
  });

  test("Bash + ./gradlew build: redirected to execute sandbox (Issue #38)", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "./gradlew build --info" },
    });
    assertRedirect(result, "Build tool redirected");
  });

  test("Bash + mvn package: redirected to execute sandbox (Issue #38)", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "mvn clean package -DskipTests" },
    });
    assertRedirect(result, "Build tool redirected");
  });
});


describe("Bash: Allowed Commands", () => {
  // After #463 the Bash routing nudge is short-circuited for structurally-
  // bounded commands (pwd, whoami, git status, mkdir, --version probes,
  // etc.) — those return null. Use unbounded commands here so we still pin
  // the "normal Bash command → context guidance" path end-to-end.
  test("Bash + npm install: additionalContext with BASH_GUIDANCE", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "npm install" },
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext, "Expected additionalContext for Bash");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> in Bash additionalContext",
    );
  });

  test("Bash + find /: additionalContext with BASH_GUIDANCE", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "find /etc -name '*.conf'" },
    });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.hookSpecificOutput.additionalContext, "Expected additionalContext for Bash");
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> in Bash additionalContext",
    );
  });

  test("Bash + git status: short-circuited by #463 allowlist (no nudge)", () => {
    // Pre-#463 this returned BASH_GUIDANCE context. Now it short-circuits
    // before the throttle: result is null and the hook emits nothing.
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "git status" },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "", "Expected empty stdout — null decision should not emit a hook payload");
  });
});


describe("WebFetch", () => {
  test("WebFetch + any URL: denied with sandbox redirect", () => {
    const result = runHook({
      tool_name: "WebFetch",
      tool_input: { url: "https://docs.example.com/api" },
    });
    assertDeny(result, "fetch_and_index");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.permissionDecisionReason.includes("https://docs.example.com/api"),
      "Expected original URL in reason",
    );
    // PR #683 follow-up (ADR-0003 amendment): the deny reason was reframed
    // affirmatively. The negative "Do NOT retry with curl" hint was replaced
    // by a positive imperative retry hint scoped to transient DNS errors and
    // by the ctx_fetch_and_index call instruction. Assert on the affirmative
    // wording instead of the dropped negation.
    assert.ok(
      /Retry the same call on a transient DNS error/.test(parsed.hookSpecificOutput.permissionDecisionReason),
      "Expected positive transient-DNS retry hint in reason",
    );
    assert.ok(
      /Call .*ctx_fetch_and_index/.test(parsed.hookSpecificOutput.permissionDecisionReason),
      "Expected explicit ctx_fetch_and_index call instruction in reason",
    );
  });
});


describe("Task (#241: no longer routed)", () => {
  test("Task tool returns empty stdout (passthrough, no routing)", () => {
    const result = runHook({
      tool_name: "Task",
      tool_input: { prompt: "Analyze this codebase and summarize the architecture." },
    });
    assert.equal(result.exitCode, 0, `Expected exit 0, got ${result.exitCode}`);
    // Task is no longer intercepted — hook produces no hookSpecificOutput
    assert.equal(result.stdout.trim(), "", "Expected empty stdout for passthrough");
  });

  test("TaskCreate returns empty stdout (passthrough)", () => {
    const result = runHook({
      tool_name: "TaskCreate",
      tool_input: { title: "my task" },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "", "Expected empty stdout for passthrough");
  });

  test("TaskUpdate returns empty stdout (passthrough)", () => {
    const result = runHook({
      tool_name: "TaskUpdate",
      tool_input: { id: "123", status: "done" },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "", "Expected empty stdout for passthrough");
  });
});


describe("Read", () => {
  test("Read + file_path: hookSpecificOutput with additionalContext nudge", () => {
    const result = runHook({
      tool_name: "Read",
      tool_input: { file_path: "/some/path/to/file.ts" },
    });
    assertHookSpecificOutput(result, "additionalContext");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("context-mode"),
      "Expected nudge to mention context-mode",
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> XML wrapper in Read nudge",
    );
  });
});


describe("Grep", () => {
  test("Grep + pattern: hookSpecificOutput with additionalContext nudge", () => {
    const result = runHook({
      tool_name: "Grep",
      tool_input: { pattern: "TODO", path: "/src" },
    });
    assertHookSpecificOutput(result, "additionalContext");
    const parsed = JSON.parse(result.stdout);
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("context-mode"),
      "Expected nudge to mention context-mode",
    );
    assert.ok(
      parsed.hookSpecificOutput.additionalContext.includes("<context_guidance>"),
      "Expected <context_guidance> XML wrapper in Grep nudge",
    );
  });
});


describe("Passthrough Tools", () => {
  test("Glob + pattern: passthrough", () => {
    const result = runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    });
    assertPassthrough(result);
  });

  test("WebSearch: passthrough", () => {
    const result = runHook({
      tool_name: "WebSearch",
      tool_input: { query: "typescript best practices" },
    });
    assertPassthrough(result);
  });

  test("Unknown tool (Edit): passthrough", () => {
    const result = runHook({
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/test.ts", old_string: "foo", new_string: "bar" },
    });
    assertPassthrough(result);
  });
});


describe("Plugin Tool Name Format in ROUTING_BLOCK", () => {
  // When installed via Claude Code plugin marketplace, tool names follow:
  //   mcp__plugin_<plugin-id>_<server-name>__<tool-name>
  // For context-mode: mcp__plugin_context-mode_context-mode__<tool-name>
  // The short form mcp__context-mode__* only works for direct MCP registration.

  const PLUGIN_PREFIX = "mcp__plugin_context-mode_context-mode__";
  const SHORT_PREFIX = "mcp__context-mode__";

  test("Agent routing block uses plugin-format tool names", () => {
    const result = runHook({ tool_name: "Agent", tool_input: { prompt: "Do something." } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const prompt = parsed.hookSpecificOutput.updatedInput.prompt;
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_batch_execute"), "Expected plugin-format ctx_batch_execute");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_search"), "Expected plugin-format ctx_search");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_execute"), "Expected plugin-format ctx_execute");
    assert.ok(prompt.includes(PLUGIN_PREFIX + "ctx_fetch_and_index"), "Expected plugin-format ctx_fetch_and_index");
    assert.ok(!prompt.includes(SHORT_PREFIX + "ctx_batch_execute"), "Must not contain short-form ctx_batch_execute");
  });

  test("Read nudge uses plugin-format execute_file tool name", () => {
    const result = runHook({ tool_name: "Read", tool_input: { file_path: "/some/file.ts" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PLUGIN_PREFIX + "ctx_execute_file"), "Expected plugin-format ctx_execute_file in Read nudge");
    assert.ok(!ctx.includes(SHORT_PREFIX + "ctx_execute_file"), "Read nudge must not contain short-form ctx_execute_file");
  });

  test("Grep nudge uses plugin-format execute tool name", () => {
    const result = runHook({ tool_name: "Grep", tool_input: { pattern: "TODO" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const ctx = parsed.hookSpecificOutput.additionalContext;
    assert.ok(ctx.includes(PLUGIN_PREFIX + "ctx_execute"), "Expected plugin-format ctx_execute in Grep nudge");
    assert.ok(!ctx.includes(SHORT_PREFIX + "ctx_execute"), "Grep nudge must not contain short-form ctx_execute");
  });

  test("WebFetch deny reason uses plugin-format fetch_and_index tool name", () => {
    const result = runHook({ tool_name: "WebFetch", tool_input: { url: "https://example.com" } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(PLUGIN_PREFIX + "ctx_fetch_and_index"), "Expected plugin-format ctx_fetch_and_index in WebFetch deny");
    assert.ok(!reason.includes(SHORT_PREFIX + "ctx_fetch_and_index"), "WebFetch deny must not contain short-form");
  });

  test("Bash inline-HTTP redirect uses plugin-format execute tool name (in deny reason)", () => {
    // CC v2.1.x Bash tool ignores updatedInput.command — the formatter now
    // emits deny + permissionDecisionReason. The plugin-format tool name
    // assertion moves from updatedInput.command to permissionDecisionReason.
    const bashCmd = "python3 -c 'import requests; requests.get(url)'";
    const result = runHook({ tool_name: "Bash", tool_input: { command: bashCmd } });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.stdout);
    const reason = parsed.hookSpecificOutput.permissionDecisionReason;
    assert.ok(typeof reason === "string" && reason.length > 0, "Expected non-empty permissionDecisionReason");
    assert.ok(reason.includes(PLUGIN_PREFIX + "ctx_execute"), "Expected plugin-format ctx_execute in inline-HTTP redirect reason");
    assert.ok(!reason.includes(SHORT_PREFIX + "ctx_execute"), "Inline-HTTP redirect must not contain short-form ctx_execute");
  });
});


describe("Skill Commands", () => {
  const SKILLS_DIR = join(__dirname, "..", "..", "skills");

  test("ctx-doctor skill directory exists with valid SKILL.md", () => {
    const skillMd = join(SKILLS_DIR, "ctx-doctor", "SKILL.md");
    assert.ok(existsSync(skillMd), "skills/ctx-doctor/SKILL.md must exist");
    const content = readFileSync(skillMd, "utf-8");
    assert.ok(content.includes("name: ctx-doctor"), "SKILL.md name must be ctx-doctor");
    assert.ok(content.includes("/context-mode:ctx-doctor"), "Trigger must reference ctx-doctor");
  });

  test("ctx-upgrade skill directory exists with valid SKILL.md", () => {
    const skillMd = join(SKILLS_DIR, "ctx-upgrade", "SKILL.md");
    assert.ok(existsSync(skillMd), "skills/ctx-upgrade/SKILL.md must exist");
    const content = readFileSync(skillMd, "utf-8");
    assert.ok(content.includes("name: ctx-upgrade"), "SKILL.md name must be ctx-upgrade");
    assert.ok(content.includes("/context-mode:ctx-upgrade"), "Trigger must reference ctx-upgrade");
  });

  test("ctx-stats skill directory exists with valid SKILL.md", () => {
    const skillMd = join(SKILLS_DIR, "ctx-stats", "SKILL.md");
    assert.ok(existsSync(skillMd), "skills/ctx-stats/SKILL.md must exist");
    const content = readFileSync(skillMd, "utf-8");
    assert.ok(content.includes("name: ctx-stats"), "SKILL.md name must be ctx-stats");
    assert.ok(content.includes("/context-mode:ctx-stats"), "Trigger must reference ctx-stats");
  });

  test("old skill directories (doctor, upgrade, stats) no longer exist", () => {
    for (const old of ["doctor", "upgrade", "stats"]) {
      assert.ok(
        !existsSync(join(SKILLS_DIR, old)),
        `Old skill directory skills/${old} must not exist`,
      );
    }
  });
});


describe("UTF-8 BOM handling (core/stdin.mjs path)", () => {
  test("pretooluse.mjs parses BOM-prefixed stdin without error", () => {
    const result = runHook({
      tool_name: "Glob",
      tool_input: { pattern: "**/*.ts" },
    }, undefined, { bom: true });
    assertPassthrough(result);
  });

  test("pretooluse.mjs handles BOM-prefixed Bash input correctly", () => {
    const result = runHook({
      tool_name: "Bash",
      tool_input: { command: "curl -s http://example.com" },
    }, undefined, { bom: true });
    assertRedirect(result, "context-mode");
  });
});
