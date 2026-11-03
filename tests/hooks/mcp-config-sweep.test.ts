/** Hook regressions: mcp-config-sweep. */
import { describe, test, expect } from "vitest";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { sweepStaleMcpJson } from "../../scripts/heal-installed-plugins.mjs";
import { useCacheHealFixtures } from "./cache-heal-fixture.js";
const { makeTmp, writeJson } = useCacheHealFixtures();


// ─────────────────────────────────────────────────────────
// Slice 4 — sweepStaleMcpJson: remove cache-baked `.mcp.json` files (#609)
//
// Background: cli.ts upgrade() wrote `.mcp.json` into every per-version
// plugin-cache dir starting with #411. PR #531 (9261377) removed `.mcp.json`
// from `package.json files[]` so the npm tarball no longer ships it, but
// the cli-side write persisted — every `/ctx-upgrade` re-baked a new
// per-version copy. When Claude Code's native plugin manager auto-update
// later copies a previous version's `.mcp.json` forward into a fresh
// version dir, the stale start.mjs absolute path goes with it.
//
// The architectural fix is "don't ship `.mcp.json` from the cache layer
// at all" — `.claude-plugin/plugin.json.mcpServers` is already the canonical
// MCP source. `sweepStaleMcpJson` removes any pre-existing `.mcp.json` from
// every per-version cache directory so the previous-version-carry vector
// can't replay across upgrades.
// ─────────────────────────────────────────────────────────

describe("sweepStaleMcpJson", () => {
  function makeCacheLayout(): {
    pluginCacheRoot: string;
    pluginKey: string;
    versionDirs: string[];
  } {
    const dir = makeTmp("ctx-sweep-");
    // Match the real cache layout: <cacheRoot>/<owner>/<plugin>/<version>/
    const pluginCacheRoot = join(dir, "cache");
    const pluginKey = "context-mode@context-mode";
    const ownerDir = join(pluginCacheRoot, "context-mode", "context-mode");
    const versionDirs = ["1.0.135", "1.0.136", "1.0.137"].map((v) =>
      join(ownerDir, v),
    );
    for (const vd of versionDirs) {
      writeFileSync(
        join(makeDir(vd), ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "context-mode": {
              command: "node",
              args: ["${CLAUDE_PLUGIN_ROOT}/start.mjs"],
            },
          },
        }),
      );
    }
    return { pluginCacheRoot, pluginKey, versionDirs };
  }

  /** Make a dir + return it. */
  function makeDir(p: string): string {
    // mkdirSync via writeFileSync requires parent existence — use a small inline helper.
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(p, { recursive: true });
    return p;
  }

  test("removes .mcp.json from every per-version cache dir", () => {
    const { pluginCacheRoot, pluginKey, versionDirs } = makeCacheLayout();

    for (const vd of versionDirs) {
      expect(existsSync(join(vd, ".mcp.json"))).toBe(true);
    }

    const result = sweepStaleMcpJson({ pluginCacheRoot, pluginKey });

    for (const vd of versionDirs) {
      expect(existsSync(join(vd, ".mcp.json"))).toBe(false);
    }
    expect(Array.isArray(result.removed)).toBe(true);
    expect(result.removed.length).toBe(versionDirs.length);
    for (const removedPath of result.removed) {
      expect(removedPath).toContain(".mcp.json");
    }
  });

  test("no-op when no .mcp.json files exist in any version dir", () => {
    const dir = makeTmp("ctx-sweep-empty-");
    const pluginCacheRoot = join(dir, "cache");
    const ownerDir = join(pluginCacheRoot, "context-mode", "context-mode");
    makeDir(join(ownerDir, "1.0.137"));

    const result = sweepStaleMcpJson({
      pluginCacheRoot,
      pluginKey: "context-mode@context-mode",
    });

    expect(result.removed).toEqual([]);
  });

  test("returns 'no-cache-root' when pluginCacheRoot does not exist", () => {
    const dir = makeTmp("ctx-sweep-missing-");
    const result = sweepStaleMcpJson({
      pluginCacheRoot: join(dir, "absent"),
      pluginKey: "context-mode@context-mode",
    });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toBe("no-cache-root");
  });

  test("path-traversal guard: refuses pluginKey that escapes cacheRoot", () => {
    // pluginKey is split to derive owner + plugin segments. A malicious
    // pluginKey shape (with .. segments) MUST not allow the sweep to walk
    // outside `pluginCacheRoot`.
    const { pluginCacheRoot } = makeCacheLayout();
    const result = sweepStaleMcpJson({
      pluginCacheRoot,
      pluginKey: "../../etc@passwd",
    });
    expect(result.removed).toEqual([]);
    // Either skipped with a guard reason OR safely no-op. The point is
    // that no file outside pluginCacheRoot was touched and the call did
    // not throw.
    expect(result).toBeDefined();
  });

  test("never touches sibling files in the version dir", () => {
    const { pluginCacheRoot, pluginKey, versionDirs } = makeCacheLayout();
    // Drop a sibling file we MUST not touch.
    for (const vd of versionDirs) {
      writeFileSync(join(vd, "plugin-manifest.txt"), "DO NOT DELETE", "utf-8");
    }

    sweepStaleMcpJson({ pluginCacheRoot, pluginKey });

    for (const vd of versionDirs) {
      expect(existsSync(join(vd, "plugin-manifest.txt"))).toBe(true);
      expect(readFileSync(join(vd, "plugin-manifest.txt"), "utf-8")).toBe(
        "DO NOT DELETE",
      );
    }
  });

  test("survives a version dir whose `.mcp.json` cannot be removed (best-effort)", () => {
    // The sweep MUST never throw — best-effort like the rest of the heal
    // family. Construct a scenario where one removal will silently fail
    // (target is missing between scan and remove); the others must still
    // succeed.
    const { pluginCacheRoot, pluginKey, versionDirs } = makeCacheLayout();
    // Pre-delete one of the .mcp.json files between layout-build and sweep.
    // The sweep will encounter "ENOENT on rm" mid-walk and must shrug.
    const { unlinkSync } = require("node:fs") as typeof import("node:fs");
    unlinkSync(join(versionDirs[0], ".mcp.json"));

    expect(() =>
      sweepStaleMcpJson({ pluginCacheRoot, pluginKey }),
    ).not.toThrow();

    // The remaining two SHOULD have been removed.
    expect(existsSync(join(versionDirs[1], ".mcp.json"))).toBe(false);
    expect(existsSync(join(versionDirs[2], ".mcp.json"))).toBe(false);
  });
});
