import { readServerSource } from "../helpers/server-source.js";
import { readCliSource } from "../helpers/cli-source.js";
import { describe, it, test, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";


import { spawnSync } from "node:child_process";




const ROOT = resolve(import.meta.dirname, "../..");

describe("hook dispatch fails OPEN on a missing hook (version-skew brick fix)", () => {
  // A non-zero exit + empty stdout makes GitHub Copilot CLI DENY the tool
  // ("Denied by preToolUse hook (hook errored)"), bricking the agent when a
  // newer adapter's hook command runs against an older global that predates it.
  // context-mode has no hook for an unknown platform/event, so it MUST exit 0
  // (allow). Locks src/cli.ts hookDispatch's missing-script branch.
  const CLI = resolve(ROOT, "cli.bundle.mjs");

  it("exits 0 for an unknown platform (does not block the host's tool)", () => {
    const r = spawnSync("node", [CLI, "hook", "__no_such_platform__", "pretooluse"], {
      input: "{}",
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  });

  it("exits 0 for a known platform with an unmapped event", () => {
    // antigravity-cli maps PreToolUse/PostToolUse/Stop, but not PreCompact.
    const r = spawnSync("node", [CLI, "hook", "antigravity-cli", "precompact"], {
      input: "{}",
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
  });
});

// ── Cross-OS compatibility ────────────────────────────────────────────

describe("Cross-OS compatibility", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));
  const src = readCliSource();

  it("build script does not shell out to POSIX chmod command", () => {
    // Shell `chmod +x` is not available on Windows cmd.exe
    // Node.js fs.chmodSync is cross-platform and acceptable
    expect(pkg.scripts.build).not.toMatch(/\bchmod\s+\+x\b/);
  });

  it("postinstall script uses node for cross-platform compatibility", () => {
    // POSIX [ -n ... ] && printf || true fails on Windows cmd.exe
    expect(pkg.scripts.postinstall).not.toMatch(/\[ -n/);
    expect(pkg.scripts.postinstall).not.toContain("printf");
    expect(pkg.scripts.postinstall).toMatch(/^node /);
    // postinstall.mjs must be in files array for npm publish
    expect(pkg.files).toContain("scripts/postinstall.mjs");
  });

  it("install:openclaw gracefully handles missing bash on Windows", () => {
    // Direct 'bash' invocation fails on Windows without Git Bash
    expect(pkg.scripts["install:openclaw"]).not.toMatch(/^bash /);
  });

  it("cli.ts chmodSync in setup/upgrade is guarded by platform check", () => {
    // chmodSync must only run on non-Windows
    const chmodIdx = src.indexOf('chmodSync(binPath');
    expect(chmodIdx).toBeGreaterThan(-1);
    // Must have a platform guard before the chmodSync call
    const contextBefore = src.slice(Math.max(0, chmodIdx - 500), chmodIdx);
    expect(contextBefore).toMatch(/process\.platform\s*!==\s*["']win32["']/);
  });
});

// ── Bin entry: cli.bundle.mjs ─────────────────────────────────────────

describe("Bin entry uses cli.bundle.mjs", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8"));

  it("package.json bin points to cli.bundle.mjs, not build/cli.js", () => {
    expect(pkg.bin["context-mode"]).toBe("./cli.bundle.mjs");
  });

  it("package.json exports ./cli points to cli.bundle.mjs", () => {
    expect(pkg.exports["./cli"]).toBe("./cli.bundle.mjs");
  });

  it("server.ts ctx_doctor runs diagnostics in-process (no CLI dependency)", () => {
    const src = readServerSource();
    const doctorSection = src.slice(src.indexOf("ctx_doctor"), src.indexOf("ctx_upgrade"));
    // Must NOT delegate to CLI — runs server-side
    expect(doctorSection).not.toContain('node "');
    // Must run actual checks
    expect(doctorSection).toContain("PolyglotExecutor");
    expect(doctorSection).toContain("FTS5");
  });

  it("doctor hook script discovery supports flat and nested hook config entries", () => {
    const helperSrc = readFileSync(resolve(ROOT, "src", "util", "hook-config.ts"), "utf-8");
    expect(helperSrc).toContain("export function getCommandsFromHookEntry");
    expect(helperSrc).toContain("(entry as { command?: unknown }).command");
    expect(helperSrc).toContain("Array.isArray(hooks)");
    expect(helperSrc).toContain("getCommandsFromHookEntry(entry)");
    expect(helperSrc).not.toContain("entry.hooks");

    for (const rel of ["src/cli.ts", "src/server.ts"]) {
      const src = rel === "src/cli.ts" ? readCliSource() : readServerSource();
      expect(src).toContain('import { getHookScriptPaths } from "./util/hook-config.js";');
      expect(src).not.toContain("function getCommandsFromHookEntry");
      expect(src).not.toContain("function getHookScriptPaths");
    }
  });

  // ── Algo-D1: doctor consumes adapter.getHealthChecks ──
  //
  // The HookAdapter contract grew an OPTIONAL `getHealthChecks(pluginRoot)`
  // returning HealthCheck[] (src/adapters/types.ts). Doctor must iterate
  // `adapter.getHealthChecks?.(pluginRoot) ?? []` so claude-code's
  // direct-existsSync hook checks are surfaced WITHOUT going back through
  // the regex round-trip that produced the #548 doubled-path FAIL.
  // Adapters that don't override the optional method get nothing — they
  // don't have this class of check today.
  it("cli doctor invokes adapter.getHealthChecks(pluginRoot) (Algo-D1)", () => {
    const src = readCliSource();
    const doctorStart = src.indexOf("async function doctor");
    const doctorBody = src.slice(doctorStart, doctorStart + 8000);
    // Wiring: doctor must call the optional method via the safe-call
    // operator so adapters that don't override it are untouched.
    expect(doctorBody).toMatch(/adapter\.getHealthChecks\?\.\(pluginRoot\)/);
    // The result must be iterated and rendered with status branches —
    // not silently dropped. Match the same `result.status === "OK"`
    // shape the HealthCheck contract uses.
    expect(doctorBody).toContain('result.status === "OK"');
  });

  it("cli doctor renders hook warnings as WARN instead of FAIL", () => {
    const src = readCliSource();
    const loopStart = src.indexOf("for (const result of hookResults)");
    const loopEnd = src.indexOf("// Hook scripts exist", loopStart);
    const loop = src.slice(loopStart, loopEnd);

    expect(loop).toContain('result.status === "warn"');
    expect(loop).toContain("p.log.warn");
    expect(loop).toContain(": WARN");
  });

  it("cli doctor treats standalone adapters as not version-comparable", () => {
    const src = readCliSource();
    const versionStart = src.indexOf("Checking versions");
    const versionBlock = src.slice(versionStart, versionStart + 1800);

    expect(versionBlock).toContain('installedVersion === "standalone"');
    expect(versionBlock).toContain("standalone MCP mode");
    expect(versionBlock).toContain("no platform plugin version to compare");
    expect(versionBlock.indexOf('installedVersion === "standalone"'))
      .toBeLessThan(versionBlock.indexOf('installedVersion === "not installed"'));
  });

  it("upgrade still reaches hook configuration when already on latest", () => {
    const src = readCliSource();
    const alreadyLatestIdx = src.indexOf("Already on latest");
    const configureIdx = src.indexOf("Configuring ${adapter.name} hooks");

    expect(alreadyLatestIdx).toBeGreaterThan(-1);
    expect(configureIdx).toBeGreaterThan(alreadyLatestIdx);

    const alreadyLatestBlock = src.slice(alreadyLatestIdx, configureIdx);
    expect(alreadyLatestBlock).not.toContain("return;");
  });

  it("server.ts ctx_upgrade uses cli.bundle.mjs with fallback", () => {
    const src = readServerSource();
    // ctx_upgrade handler must prefer cli.bundle.mjs
    const upgradeStart = src.indexOf('server.registerTool(\n  "ctx_upgrade"');
    const upgradeEnd = src.indexOf("// ── ctx-purge", upgradeStart);
    const upgradeSection = src.slice(upgradeStart, upgradeEnd);
    expect(upgradeSection).toContain("cli.bundle.mjs");
  });

  it("server.ts registers empty prompts/resources handlers to avoid -32601 (#168)", () => {
    const src = readServerSource();
    // Must register prompts capability so clients don't get Method not found
    expect(src).toContain("ListPromptsRequestSchema");
    // Must register resources capability
    expect(src).toContain("ListResourcesRequestSchema");
    // Must return empty arrays
    expect(src).toContain("prompts: []");
    expect(src).toContain("resources: []");
  });

  it("openclaw-plugin.ts doctor/upgrade use cli.bundle.mjs with fallback", () => {
    const src = readFileSync(resolve(ROOT, "src", "adapters", "openclaw", "plugin.ts"), "utf-8");
    expect(src).toContain("cli.bundle.mjs");
    // Find the registerCommand blocks, not comments
    const doctorIdx = src.indexOf('name: "ctx-doctor"');
    const upgradeIdx = src.indexOf('name: "ctx-upgrade"');
    expect(doctorIdx).toBeGreaterThan(-1);
    expect(upgradeIdx).toBeGreaterThan(-1);
    const doctorSection = src.slice(doctorIdx, doctorIdx + 500);
    const upgradeSection = src.slice(upgradeIdx, upgradeIdx + 500);
    expect(doctorSection).toContain("cli.bundle.mjs");
    expect(upgradeSection).toContain("cli.bundle.mjs");
  });
});

// ── SKILL.md MCP-first pattern ────────────────────────────────────────

describe("SKILL.md prefers MCP tool over Bash", () => {
  it("ctx-doctor SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-doctor", "SKILL.md"), "utf-8");
    // Must mention the MCP tool
    expect(skill).toContain("ctx_doctor");
    expect(skill).toContain("MCP tool");
    // MCP tool instruction must appear BEFORE the Bash fallback
    const mcpIdx = skill.indexOf("ctx_doctor");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });

  it("ctx-upgrade SKILL.md prefers MCP tool over Bash", () => {
    const skill = readFileSync(resolve(ROOT, "skills", "ctx-upgrade", "SKILL.md"), "utf-8");
    // Must mention the MCP tool
    expect(skill).toContain("ctx_upgrade");
    expect(skill).toContain("MCP tool");
    // MCP tool instruction must appear BEFORE the Bash fallback
    const mcpIdx = skill.indexOf("ctx_upgrade");
    const fallbackIdx = skill.indexOf("Fallback");
    expect(mcpIdx).toBeGreaterThan(-1);
    expect(fallbackIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeLessThan(fallbackIdx);
  });
});

// ── Package exports ───────────────────────────────────────────────────

describe("Package exports", () => {
  test("named export exposes ContextModePlugin factory", async () => {
    const mod = await import("../../src/adapters/opencode/plugin.js");
    expect(mod.ContextModePlugin).toBeDefined();
    expect(typeof mod.ContextModePlugin).toBe("function");
  });

  test("default export has KiloCode PluginModule shape { server }", async () => {
    const mod = (await import("../../src/adapters/opencode/plugin.js")) as any;
    expect(mod.default).toBeDefined();
    expect(typeof mod.default.server).toBe("function");
  });

  test("default export does not leak CLI internals", async () => {
    const mod = (await import("../../src/adapters/opencode/plugin.js")) as any;
    expect(mod.toUnixPath).toBeUndefined();
    expect(mod.doctor).toBeUndefined();
    expect(mod.upgrade).toBeUndefined();
  });
});
