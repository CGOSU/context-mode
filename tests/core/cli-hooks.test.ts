import { readCliSource } from "../helpers/cli-source.js";
import { describe, test, expect } from "vitest";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";







const ROOT = resolve(import.meta.dirname, "../..");

// ── PR #183 fix: path traversal prevention in OpenClaw sessionKey ──

describe("OpenClaw sessionKey safety (#183)", () => {
  const WR_SOURCE = readFileSync(resolve(ROOT, "src/adapters/openclaw/workspace-router.ts"), "utf-8");

  test("workspace regex only allows safe characters (no path traversal)", () => {
    // Must use [a-zA-Z0-9_-]+ not [^:]+ to prevent ../../ in agent name
    expect(WR_SOURCE).toContain('[a-zA-Z0-9_-]+');
  });

  test("workspace path is scoped to /openclaw/workspace- prefix", () => {
    // extractWorkspace must only match recognised /openclaw/workspace-<name> paths
    expect(WR_SOURCE).toContain('/openclaw/workspace-');
    // workspaceFromKey derives workspace from sessionKey agent:<name>:<channel>
    expect(WR_SOURCE).toContain('`/openclaw/workspace-');
  });
});

// ── Issue #225: Codex CLI hook dispatch ──────────────────────────────────

describe("Codex CLI hook dispatch (#225)", () => {
  const CLI_SOURCE = readCliSource();

  test("HOOK_MAP includes codex platform", () => {
    // Extract HOOK_MAP definition
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    expect(hookMap).toContain('"codex"');
  });

  test("codex HOOK_MAP has all Codex hook dispatches", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    // Extract codex block
    const codexStart = hookMap.indexOf('"codex"');
    const codexEnd = hookMap.indexOf("}", codexStart + 10) + 1;
    const codexBlock = hookMap.slice(codexStart, codexEnd);
    expect(codexBlock).toContain("pretooluse");
    expect(codexBlock).toContain("posttooluse");
    expect(codexBlock).toContain("precompact");
    expect(codexBlock).toContain("sessionstart");
    expect(codexBlock).toContain("userpromptsubmit");
    expect(codexBlock).toContain("stop");
  });

  test("codex hooks point to dedicated hooks/codex/ directory", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    const codexStart = hookMap.indexOf('"codex"');
    const codexEnd = hookMap.indexOf("}", codexStart + 10) + 1;
    const codexBlock = hookMap.slice(codexStart, codexEnd);
    expect(codexBlock).toContain("hooks/codex/pretooluse.mjs");
    expect(codexBlock).toContain("hooks/codex/posttooluse.mjs");
    expect(codexBlock).toContain("hooks/codex/precompact.mjs");
    expect(codexBlock).toContain("hooks/codex/sessionstart.mjs");
    expect(codexBlock).toContain("hooks/codex/userpromptsubmit.mjs");
    expect(codexBlock).toContain("hooks/codex/stop.mjs");
  });

  test("hooks/codex/pretooluse.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/pretooluse.mjs"))).toBe(true);
  });

  test("hooks/codex/posttooluse.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/posttooluse.mjs"))).toBe(true);
  });

  test("hooks/codex/sessionstart.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/sessionstart.mjs"))).toBe(true);
  });

  test("hooks/codex/precompact.mjs exists", () => {
    expect(existsSync(resolve(ROOT, "hooks/codex/precompact.mjs"))).toBe(true);
  });

  test("session-helpers.mjs exports CODEX_OPTS", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    expect(helpers).toContain("export const CODEX_OPTS");
  });

  test("CODEX_OPTS uses .codex config dir", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    const optsStart = helpers.indexOf("CODEX_OPTS");
    const optsEnd = helpers.indexOf("};", optsStart) + 2;
    const optsBlock = helpers.slice(optsStart, optsEnd);
    expect(optsBlock).toContain('".codex"');
  });

  test("configs/codex/hooks.json commands match HOOK_MAP platform name", () => {
    const hooksJson = JSON.parse(readFileSync(resolve(ROOT, "configs/codex/hooks.json"), "utf-8"));
    for (const [eventType, entries] of Object.entries(hooksJson.hooks)) {
      for (const entry of entries as any[]) {
        for (const hook of entry.hooks) {
          // Command must use "context-mode hook codex <event>"
          expect(hook.command).toMatch(/context-mode hook codex \w+/);
        }
      }
    }
  });

  test("CODEX_OPTS.projectDirEnv is undefined (Codex passes cwd in stdin, not env)", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    const optsStart = helpers.indexOf("CODEX_OPTS");
    const optsEnd = helpers.indexOf("};", optsStart) + 2;
    const optsBlock = helpers.slice(optsStart, optsEnd);
    expect(optsBlock).toMatch(/projectDirEnv:\s*undefined/);
  });

  test("codex hooks include hookEventName in output (required by codex-rs)", () => {
    const posttooluse = readFileSync(resolve(ROOT, "hooks/codex/posttooluse.mjs"), "utf-8");
    expect(posttooluse).toContain('hookEventName: "PostToolUse"');

    const sessionstart = readFileSync(resolve(ROOT, "hooks/codex/sessionstart.mjs"), "utf-8");
    expect(sessionstart).toContain('hookEventName: "SessionStart"');
  });

  test("codex pretooluse formatter includes hookEventName in deny response", () => {
    const formatters = readFileSync(resolve(ROOT, "hooks/core/formatters.mjs"), "utf-8");
    const codexStart = formatters.indexOf('"codex"');
    const codexEnd = formatters.indexOf("},", codexStart + 50);
    const codexBlock = formatters.slice(codexStart, codexEnd);
    expect(codexBlock).toContain('hookEventName: "PreToolUse"');
  });
});

// ── Kimi Code CLI hook dispatch (#729) ───────────────────────────────────

describe("Kimi Code CLI hook dispatch (#729)", () => {
  const CLI_SOURCE = readCliSource();

  test("HOOK_MAP includes kimi platform", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    expect(hookMap).toContain('"kimi"');
  });

  test("kimi HOOK_MAP has all Kimi hook dispatches including sessionend", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    const kimiStart = hookMap.indexOf('"kimi"');
    const kimiEnd = hookMap.indexOf("}", kimiStart + 10) + 1;
    const kimiBlock = hookMap.slice(kimiStart, kimiEnd);
    expect(kimiBlock).toContain("pretooluse");
    expect(kimiBlock).toContain("posttooluse");
    expect(kimiBlock).toContain("precompact");
    expect(kimiBlock).toContain("sessionstart");
    expect(kimiBlock).toContain("sessionend");
    expect(kimiBlock).toContain("userpromptsubmit");
    expect(kimiBlock).toContain("stop");
  });

  test("kimi hooks point to dedicated hooks/kimi/ directory", () => {
    const mapStart = CLI_SOURCE.indexOf("const HOOK_MAP");
    const mapEnd = CLI_SOURCE.indexOf("};", mapStart) + 2;
    const hookMap = CLI_SOURCE.slice(mapStart, mapEnd);
    const kimiStart = hookMap.indexOf('"kimi"');
    const kimiEnd = hookMap.indexOf("}", kimiStart + 10) + 1;
    const kimiBlock = hookMap.slice(kimiStart, kimiEnd);
    expect(kimiBlock).toContain("hooks/kimi/pretooluse.mjs");
    expect(kimiBlock).toContain("hooks/kimi/posttooluse.mjs");
    expect(kimiBlock).toContain("hooks/kimi/precompact.mjs");
    expect(kimiBlock).toContain("hooks/kimi/sessionstart.mjs");
    expect(kimiBlock).toContain("hooks/kimi/sessionend.mjs");
    expect(kimiBlock).toContain("hooks/kimi/userpromptsubmit.mjs");
    expect(kimiBlock).toContain("hooks/kimi/stop.mjs");
  });

  test("configs/kimi/hooks.json commands match HOOK_MAP platform name", () => {
    const hooksJson = JSON.parse(readFileSync(resolve(ROOT, "configs/kimi/hooks.json"), "utf-8"));
    for (const [eventType, entries] of Object.entries(hooksJson.hooks)) {
      for (const entry of entries as any[]) {
        for (const hook of entry.hooks) {
          expect(hook.command).toMatch(/context-mode hook kimi \w+/);
        }
      }
    }
  });

  test("session-helpers.mjs exports KIMI_OPTS", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    expect(helpers).toContain("export const KIMI_OPTS");
  });

  test("KIMI_OPTS uses .kimi-code config dir", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    const optsStart = helpers.indexOf("KIMI_OPTS");
    const optsEnd = helpers.indexOf("};", optsStart) + 2;
    const optsBlock = helpers.slice(optsStart, optsEnd);
    expect(optsBlock).toContain('".kimi-code"');
  });

  test("KIMI_OPTS honours KIMI_CODE_HOME env var", () => {
    const helpers = readFileSync(resolve(ROOT, "hooks/session-helpers.mjs"), "utf-8");
    const optsStart = helpers.indexOf("KIMI_OPTS");
    const optsEnd = helpers.indexOf("};", optsStart) + 2;
    const optsBlock = helpers.slice(optsStart, optsEnd);
    expect(optsBlock).toContain('configDirEnv: "KIMI_CODE_HOME"');
  });

  test("kimi pretooluse formatter includes hookEventName in deny response", () => {
    const formatters = readFileSync(resolve(ROOT, "hooks/core/formatters.mjs"), "utf-8");
    const kimiStart = formatters.indexOf('"kimi"');
    const kimiEnd = formatters.indexOf("},", kimiStart + 50);
    const kimiBlock = formatters.slice(kimiStart, kimiEnd);
    expect(kimiBlock).toContain('hookEventName: "PreToolUse"');
  });
});

// ── Cursor stop hook (#HOOK_MAP cursor stop) ─────────────────────────────

describe("Cursor CLI hook dispatch — stop event", () => {
  const CLI_SOURCE = readCliSource();

  test("HOOK_MAP cursor entry includes stop event", () => {
    const cursorEntry = CLI_SOURCE.match(/"cursor"\s*:\s*\{[\s\S]*?\}/);
    expect(cursorEntry).not.toBeNull();
    expect(cursorEntry![0]).toContain("stop");
    expect(cursorEntry![0]).toContain("hooks/cursor/stop.mjs");
  });
});
