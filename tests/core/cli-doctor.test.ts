import { readCliSource } from "../helpers/cli-source.js";
import { describe, it, test, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";







const ROOT = resolve(import.meta.dirname, "../..");

// ── PR #190 fix: getRuntimeSummary handles full bun path ──

describe("Runtime summary bun detection (#190)", () => {
  const RT_SOURCE = readFileSync(resolve(ROOT, "src", "runtime.ts"), "utf-8");

  test("getRuntimeSummary does not use exact === bun comparison", () => {
    // Full path like /home/user/.bun/bin/bun must be detected
    const summaryStart = RT_SOURCE.indexOf("getRuntimeSummary");
    const summaryBody = RT_SOURCE.slice(summaryStart, RT_SOURCE.indexOf("\nexport", summaryStart + 10));
    expect(summaryBody).not.toContain('=== "bun"');
  });
});

// ── Plugin root detection for Opencode/Kilocode platforms ────────────────

describe("Plugin root detection (#PR refactor/opencode-improvements)", () => {
  const CLI_SOURCE = readCliSource();

  test("cachePluginRoot uses LOCALAPPDATA on Windows", () => {
    const cacheRootStart = CLI_SOURCE.indexOf("function cachePluginRoot");
    const cacheRootBody = CLI_SOURCE.slice(cacheRootStart, cacheRootStart + 500);
    expect(cacheRootBody).toContain("process.env.LOCALAPPDATA");
    expect(cacheRootBody).toContain('process.platform === "win32"');
  });

  test("cachePluginRoot uses ~/.cache as default on non-Windows", () => {
    const cacheRootStart = CLI_SOURCE.indexOf("function cachePluginRoot");
    const cacheRootBody = CLI_SOURCE.slice(cacheRootStart, cacheRootStart + 500);
    expect(cacheRootBody).toContain('".cache"');
    expect(cacheRootBody).toContain("homedir");
  });

  test("getPluginRoot uses cache path for opencode/kilo platform", () => {
    const getPluginRootStart = CLI_SOURCE.indexOf("function getPluginRoot");
    const getPluginRootBody = CLI_SOURCE.slice(getPluginRootStart, getPluginRootStart + 300);
    expect(getPluginRootBody).toContain("isInProcessPluginPlatform(platform)");
    expect(getPluginRootBody).toContain("cachePluginRoot");
  });
});

// ── Issue #564 — docs sync to hasModernSqlite() source of truth ────────
// README and docs/platform-support.md historically promised "Node 18+"
// (9 spots in README) and "Node >= 22.13" (platform-support), while the
// runtime gate (`hasModernSqlite()` in src/db-base.ts:226-244) uses 22.5.
// Three numbers, three contracts. v1.0.132 collapses them to one — the
// runtime gate is the canonical source.
describe("Issue #564 — docs match hasModernSqlite() source of truth", () => {
  const DB_BASE_SRC = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");

  it("src/db-base.ts hasModernSqlite() uses the 22.5 floor (sanity / source of truth)", () => {
    // If this fails, the floor moved — the README + docs assertions
    // below need their threshold updated in lockstep. This test pins the
    // contract so the docs assertions can not silently drift.
    expect(DB_BASE_SRC).toContain("export function hasModernSqlite");
    // Inline major/minor compare must reference 22 and 5.
    expect(DB_BASE_SRC).toMatch(/major\s*===\s*22\s*&&\s*minor\s*>=\s*5/);
  });

  it("README.md does NOT promise Node.js 18+ on platforms where Linux is unsafe", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf-8");
    // The literal string "Node.js 18+" must be gone from prerequisites
    // lines — it's a false promise on Linux.
    const nodeJs18PrereqLines = readme
      .split("\n")
      .filter((l) => /Node\.js\s+18\s*\+/.test(l));
    expect(nodeJs18PrereqLines).toEqual([]);
    // README must positively state the 22.5 (or Bun) floor somewhere.
    expect(readme).toMatch(/22\.5/);
  });

  it("docs/platform-support.md SQLite Backend Selection table uses 22.5, not 22.13", () => {
    const doc = readFileSync(resolve(ROOT, "docs", "platform-support.md"), "utf-8");
    // The literal "22.13" must be gone — it disagrees with hasModernSqlite().
    expect(doc).not.toMatch(/22\.13/);
    // The 22.5 floor must be present.
    expect(doc).toMatch(/22\.5/);
  });
});

// ── Issue #564 — doctor RED FAIL on Linux + Node < 22.5 + no Bun ──────
// Six prior fixes (#228, #331, #461, #540, #551, #556) silently assumed
// Node >= 22.5 on Linux. Reporter #564 hit SIGSEGV on Node 20 because
// engines.node was absent and doctor never flagged the unsafe config.
//
// Architect contract for v1.0.132: doctor MUST emit an explicit RED FAIL
// (not a warn / not a passing note) for the predicate
//   process.platform === "linux" && !hasModernSqlite() && globalThis.Bun === undefined
// linking to issue #564.
//
// Static-analysis assertion (same pattern as cli.test.ts:289, :820, :970):
// runtime spawning would need a fake-Linux fake-Node-20 environment that
// is not portable; asserting the gate exists in source catches the
// regression at PR time and is the precedent used elsewhere in this file.
describe("Issue #564 — doctor() flags Linux + Node < 22.5 + no Bun", () => {
  const CLI_SRC = readCliSource();

  function doctorBody(): string {
    const start = CLI_SRC.indexOf("async function doctor(");
    expect(start).toBeGreaterThan(-1);
    // doctor() spans ~300 lines; grab a generous window that ends before
    // the next top-level function declaration (`async function insight`).
    const end = CLI_SRC.indexOf("async function insight", start);
    expect(end).toBeGreaterThan(start);
    return CLI_SRC.slice(start, end);
  }

  it("doctor fails on Linux + Node < 22.5 + no bun (RED FAIL line)", () => {
    const body = doctorBody();
    // The Linux predicate must be in doctor().
    expect(body).toMatch(/process\.platform\s*===\s*["']linux["']/);
    // Must consult the 22.5 gate via hasModernSqlite (the source of truth
    // in src/db-base.ts:226-244) OR an equivalent inline major/minor check.
    const usesHelper = /hasModernSqlite/.test(body);
    const usesInlineGate =
      /process\.versions\.node/.test(body) && /22(?:\.5|[^0-9])/.test(body);
    expect(usesHelper || usesInlineGate).toBe(true);
    // Bun must be allowed through (Linux + Bun is fine).
    expect(body).toMatch(/globalThis\.Bun|hasBunRuntime|process\.versions\.bun/);
    // Must be a RED FAIL (architect mandate) — not a warn/info. Reuses
    // the existing FAIL surface: `p.log.error(color.red(... FAIL ...`.
    // We assert FAIL appears in the new block by matching against an
    // anchor unique to it (issue #564 reference).
    const issueIdx = body.indexOf("#564");
    expect(issueIdx).toBeGreaterThan(-1);
    // Look at a wide window around the #564 anchor — the comment block
    // sits above the predicate and the FAIL emission sits below, so we
    // grab text on both sides.
    const surrounding = body.slice(
      Math.max(0, issueIdx - 1500),
      issueIdx + 2000,
    );
    expect(surrounding).toMatch(/p\.log\.error/);
    expect(surrounding).toMatch(/FAIL/);
    // The block must increment criticalFails so the doctor exits non-zero.
    expect(surrounding).toMatch(/criticalFails\+\+/);
    // Remediation: must point users at 22.5+ (or Bun).
    expect(body).toMatch(/22\.5/);
  });
});

// Upgrade health verification is covered by tests/cli/upgrade-verifies-binding.test.ts.

// ── Issue #613/#609 — doctor() surfaces persistence-tier bug class ─────
// PR #620 (Family A) shipped the architectural fixes:
//   - #609: stop writing per-version cache `.mcp.json` + post-bump sweep
//   - #613: vscode/jetbrains-copilot hook commands ship CLI-dispatcher form
//           (no absolute `process.execPath` + script path baked into
//           workspace-committed `.github/hooks/context-mode.json`)
//
// These two slices are the *prevention* surface — root-cause fixes that
// stop the bug from being written. But users on the field can still be
// holding pre-PR-620 poisoned state:
//   - already-committed `.github/hooks/context-mode.json` in their repo
//     with absolute Windows fnm shim paths from v1.0.136 or earlier
//   - leftover `.mcp.json` in `~/.claude/plugins/cache/.../<version>/`
//     from /ctx-upgrade flows that ran before PR #620
//
// Doctor's job per the verdict family ("silent-green doctor while hooks
// are dead is itself a P0 trust bug" — ISSUE-604-VERDICT §11) is to
// SURFACE that pre-PR state BEFORE the user hits a runtime failure.
//
// Architect contract for PR #620 + slice 4:
//   CHECK A: doctor scans workspace Tier C files (`.github/hooks/context-mode.json`,
//            `.cursor/hooks.json`, `.jetbrains/copilot/hooks.json` under
//            process.cwd()) — for each that exists, parse JSON, recurse
//            into all string values, FAIL if any matches absolute path
//            patterns (unix `/`, Windows `[A-Z]:[/\\]`, `\\`, fnm_multishells).
//            Remediation: "run `ctx_upgrade` to rewrite to portable form".
//            Missing config → SKIP (no false fail).
//
//   CHECK B: doctor scans `~/.claude/plugins/cache/context-mode/context-mode/*/`
//            for `.mcp.json` files (post-PR-620 these should not exist).
//            Found → WARN (not fail) with remediation:
//            "ctx_upgrade will sweep on next run".
//
// Same static-analysis assertion pattern as Issue #564 doctor test (above)
// and lines 962, 997, 1010 — runtime spawning would need fixture
// workspaces on three OSes and is not portable; asserting the gate
// exists in doctor() source catches the regression at PR time.
describe("PR #620 slice 4 — doctor() surfaces persistence-tier bug class", () => {
  const CLI_SRC = readCliSource();

  function doctorBody(): string {
    const start = CLI_SRC.indexOf("async function doctor(");
    expect(start).toBeGreaterThan(-1);
    const end = CLI_SRC.indexOf("async function insight", start);
    expect(end).toBeGreaterThan(start);
    return CLI_SRC.slice(start, end);
  }

  it("doctor scans workspace Tier C config files for absolute paths (#613 proactive)", () => {
    const body = doctorBody();
    // Must reference all three Tier C path shapes that PR #620 covers
    // (vscode-copilot writes `.github/hooks/context-mode.json`,
    //  cursor writes `.cursor/hooks.json`,
    //  jetbrains-copilot writes `.jetbrains/copilot/hooks.json`
    //  — workspace-committed per ISSUE-613-VERDICT §6.1 Tier C table).
    expect(body).toContain(".github/hooks/context-mode.json");
    expect(body).toContain(".cursor/hooks.json");
    expect(body).toContain(".jetbrains/copilot/hooks.json");
    // Must detect the fnm-shim pattern (reporter's stderr literally shows
    // `fnm_multishells/<pid>_<ts>/node.exe` per ISSUE-613-VERDICT §2 H2).
    expect(body).toMatch(/fnm_multishells/);
    // Must surface the failure with remediation pointing at ctx_upgrade.
    // The Tier C section is identifiable by the issue anchor `#613`.
    const anchorIdx = body.indexOf("#613");
    expect(anchorIdx).toBeGreaterThan(-1);
    const window_ = body.slice(
      Math.max(0, anchorIdx - 500),
      anchorIdx + 3000,
    );
    // The check must use p.log.error or p.log.warn (not info) AND
    // mention ctx_upgrade so the user knows the remediation.
    expect(window_).toMatch(/p\.log\.(error|warn)/);
    expect(window_).toMatch(/ctx[_-]?upgrade/i);
  });

  it("doctor warns on stale `.mcp.json` files in cache version dirs (#609 proactive)", () => {
    const body = doctorBody();
    // Must reference the cache plugin path shape that PR #620 sweeps.
    // The path nests `context-mode/context-mode` (marketplace/plugin
    // nesting per ISSUE-609-VERDICT path examples). cli.ts uses
    // path.join() so the literal appears as adjacent string args:
    //   join(homedir(), ".claude", "plugins", "cache",
    //        "context-mode", "context-mode")
    // We assert on both the cache anchor segments AND the join args
    // (Mert standing rule — use platform-neutral path joins, not literal
    // separators that fail on Windows).
    expect(body).toMatch(/"plugins"\s*,\s*"cache"/);
    expect(body).toMatch(/"context-mode"\s*,\s*"context-mode"/);
    // Must check for `.mcp.json` (the file that should not exist after
    // PR #620's architectural untrack — ISSUE-609-VERDICT §H1 → PR #618 → #620).
    const anchorIdx = body.indexOf("#609");
    expect(anchorIdx).toBeGreaterThan(-1);
    const window_ = body.slice(
      Math.max(0, anchorIdx - 500),
      anchorIdx + 2500,
    );
    expect(window_).toContain(".mcp.json");
    // WARN (not FAIL) — the verdict spec is explicit that this is
    // recoverable: "ctx_upgrade will sweep on next run".
    expect(window_).toMatch(/p\.log\.warn/);
    expect(window_).toMatch(/ctx[_-]?upgrade/i);
  });

  it("doctor uses homedir() (cross-platform) not literal '~' for cache scan", () => {
    const body = doctorBody();
    // Mert standing rule: Windows safety. Cache path must resolve via
    // os.homedir() — not a literal `~/` prefix which fails on Windows.
    const anchorIdx = body.indexOf("#609");
    expect(anchorIdx).toBeGreaterThan(-1);
    const window_ = body.slice(anchorIdx, anchorIdx + 2500);
    // The scan must use homedir() (already imported at the top of cli.ts).
    expect(window_).toMatch(/homedir\(\)|process\.env\.HOME/);
    // And must NOT use a literal `~/` path string (would be treated
    // literally on Windows).
    expect(window_).not.toMatch(/["']~\//);
  });
});
