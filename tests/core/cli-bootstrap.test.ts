import { describe, it, test, expect } from "vitest";

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";







const ROOT = resolve(import.meta.dirname, "../..");

// ── Shared dep bootstrap (#172) ──────────────────────────────────────

describe("hooks/ensure-deps.mjs — shared bootstrap", () => {
  it("ensure-deps.mjs exists and exports ensureDeps function", async () => {
    expect(existsSync(resolve(ROOT, "hooks", "ensure-deps.mjs"))).toBe(true);
    const mod = await import("../../hooks/ensure-deps.mjs");
    expect(typeof mod.ensureDeps).toBe("function");
  });

  it("start.mjs uses ensure-deps.mjs for native deps", () => {
    const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
    expect(src).toContain("ensure-deps.mjs");
    // better-sqlite3 should NOT be in start.mjs inline loop (handled by ensure-deps)
    expect(src).not.toMatch(/for.*\[.*"better-sqlite3"/s);
  });

  it("all session hooks bootstrap ensure-deps via runHook wrapper (#414)", () => {
    // After #414 fix: top-level static `import "./ensure-deps.mjs"` was a
    // parse-time crash vector on Windows (loader:1479 bypassed try/catch).
    // ensure-deps is now dynamic-imported inside hooks/run-hook.mjs.
    const runHookSrc = readFileSync(resolve(ROOT, "hooks", "run-hook.mjs"), "utf-8");
    expect(runHookSrc).toContain("ensure-deps.mjs");

    const sessionHooks = [
      "hooks/sessionstart.mjs",
      "hooks/posttooluse.mjs",
      "hooks/precompact.mjs",
      "hooks/userpromptsubmit.mjs",
      "hooks/pretooluse.mjs",
    ];
    for (const hook of sessionHooks) {
      const src = readFileSync(resolve(ROOT, hook), "utf-8");
      expect(src).toContain("run-hook.mjs");
      // Top-level static side-effect import must NOT remain (would bypass uncaughtException).
      expect(src).not.toMatch(/^import\s+["']\.\/ensure-deps\.mjs["'];?$/m);
    }
  });
});

// ── session-loaders.mjs fallback ──────────────────────────────────────

describe("session-loaders.mjs fallback to build/session/*.js", () => {
  test("session-loaders.mjs has loadModule fallback function", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Must have a loadModule helper that checks existsSync
    expect(src).toContain("loadModule");
    expect(src).toContain("existsSync");
  });

  test("session-loaders.mjs falls back to build/session/*.js paths", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Must reference the build/session fallback directory
    expect(src).toContain("build");
    expect(src).toContain("session");
    // Must reference specific build fallback filenames
    expect(src).toContain("db.js");
    expect(src).toContain("extract.js");
    expect(src).toContain("snapshot.js");
  });

  test("session-loaders.mjs still tries bundles first", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    // Bundle names must still be present
    expect(src).toContain("session-db.bundle.mjs");
    expect(src).toContain("session-extract.bundle.mjs");
    expect(src).toContain("session-snapshot.bundle.mjs");
  });

  test("session-loaders.mjs imports existsSync", () => {
    const src = readFileSync(resolve(ROOT, "hooks", "session-loaders.mjs"), "utf-8");
    expect(src).toMatch(/import\s*\{[^}]*existsSync[^}]*\}\s*from\s*["']node:fs["']/);
  });
});

// Native repair has been replaced by read-only health checks.
// Failure/no-install regressions live in tests/util/sqlite-health.test.ts.

describe("Windows nvm4w junction remains available", () => {
  it("preserves the unrelated junction repair", () => {
    const source = readFileSync(resolve(ROOT, "scripts/postinstall.mjs"), "utf-8");
    expect(/mklink\s+\/J/.test(source)).toBe(true);
  });
});
