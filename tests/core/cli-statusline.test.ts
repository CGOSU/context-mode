import { readCliSource } from "../helpers/cli-source.js";
import { describe, test, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";







const ROOT = resolve(import.meta.dirname, "../..");

// ── Issue #185: upgrade must not use execSync (shell) ──

// ── Statusline self-locate: survive plugin-root staleness post-upgrade ──

describe("statuslineForward survives stale getPluginRoot() (post-upgrade)", () => {
  const CLI_SOURCE = readCliSource();
  const fnStart = CLI_SOURCE.indexOf("function statuslineForward");
  // Slice through end-of-file rather than a fixed-width window so pattern
  // lookups stay valid as the function picks up defensive checks.
  const fnBody = CLI_SOURCE.slice(fnStart);

  test("statuslineForward falls back to the marketplace clone path", () => {
    // After ctx-upgrade, the running CLI binary may live in a cache dir that
    // sessionstart.mjs (#181) has already cleaned, so getPluginRoot() resolves
    // to a directory whose bin/statusline.mjs has been removed. Falling back
    // to the marketplace clone (~/.claude/plugins/marketplaces/context-mode)
    // keeps the statusline alive — that path is stable across upgrades and is
    // now refreshed every /ctx-upgrade per #418.
    expect(fnBody).toMatch(/marketplaces[\\/]+["']?\s*,\s*["']?context-mode["']?|"marketplaces"\s*,\s*"context-mode"/);
  });

  test("statuslineForward also tries installed_plugins.json install path", () => {
    // Defence in depth — if the marketplace clone is also missing (manual
    // cleanup, custom install), use the path Claude Code actually loads from.
    expect(fnBody).toMatch(/installed_plugins\.json/);
  });

  test("statuslineForward exits silently on total failure (no stderr noise)", () => {
    // Statusline writes to CC's status bar. Stderr from this process surfaces
    // visibly. When NO candidate exists, exit 0 quietly — the user already
    // sees the empty bar, an error message would be redundant noise.
    expect(fnBody).toMatch(/process\.exit\(0\)/);
  });
});

// ── Statusline staleness fix: server emits a periodic stats heartbeat ──

describe("server emits periodic stats heartbeat (statusline liveness fix)", () => {
  const SERVER_SOURCE = readFileSync(resolve(ROOT, "src/server.ts"), "utf-8");

  test("server.ts schedules a setInterval that calls persistStats", () => {
    // bin/statusline.mjs flags the session as "stale — restart to resume saving"
    // when stats.updated_at is >30min old. Pre-fix, updated_at only advanced on
    // MCP tool calls — long Bash/Read/Edit stretches (or post-/compact pauses)
    // would falsely flip the statusline to red even though the MCP server was
    // alive. Server must refresh the stats file on a timer regardless of tool
    // activity so updated_at reflects true server liveness.
    expect(SERVER_SOURCE).toMatch(/setInterval\([\s\S]*?persistStats[\s\S]*?,\s*\d/);
  });

  test("heartbeat interval is shorter than the statusline staleness threshold", () => {
    // statusline threshold: 30min (bin/statusline.mjs:272). Heartbeat must fire
    // well below this — allow up to 5min so the file refresh is frequent enough
    // that one missed tick (sleep, host pause) still keeps us below the cliff.
    const m = SERVER_SOURCE.match(/setInterval\(\s*\(\)\s*=>\s*persistStats\(\)\s*,\s*(\d[\d_]*)\s*\)/);
    expect(m, "Expected `setInterval(() => persistStats(), <ms>)` in server.ts").not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ""));
    expect(ms).toBeGreaterThanOrEqual(10_000);   // not absurdly chatty
    expect(ms).toBeLessThanOrEqual(5 * 60_000);  // safely under the 30min cliff
  });

  test("heartbeat setInterval is .unref()ed so it does not block process exit", () => {
    // Matches the pattern of the existing version-check interval (~3115).
    expect(SERVER_SOURCE).toMatch(/setInterval\(\s*\(\)\s*=>\s*persistStats\(\)[^.]*\.unref\(\)/s);
  });
});
