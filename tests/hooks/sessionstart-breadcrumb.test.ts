/** Hook regressions: sessionstart-breadcrumb. */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, cpSync, lstatSync, lutimesSync, mkdirSync, realpathSync, symlinkSync, utimesSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";


// ─────────────────────────────────────────────────────────
// Slice 5 — Issues #814 / #807: version-dir cleanup must leave a breadcrumb
//
// sessionstart.mjs age-gated cleanup (#181) deletes old plugin cache version
// dirs, but sessions that loaded hooks before an auto-update keep the old
// version's absolute paths baked into their hook configuration. Deleting the
// dir without leaving a forwarding link strands those sessions: every
// subsequent hook call fails with "Plugin directory does not exist" until the
// session is restarted (~3k errors over 6h observed in #807). These tests run
// the real sessionstart.mjs against a fake plugin-cache layout and assert the
// swept version dir is replaced by a symlink (junction on Windows) pointing at
// the live version.
// ─────────────────────────────────────────────────────────

const BREADCRUMB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");


describe("Issues #814/#807 — cleanup leaves a breadcrumb to the live version", () => {
  let fakeRoot: string;
  let cacheParent: string;
  let currentDir: string;
  let fakeProjectDir: string;
  let fakeHomeDir: string;

  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 3600_000);

  function runSessionStart(sessionId: string) {
    return spawnSync("node", [join(currentDir, "hooks", "sessionstart.mjs")], {
      input: JSON.stringify({ session_id: sessionId, source: "startup" }),
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: currentDir,
        CLAUDE_PROJECT_DIR: fakeProjectDir,
        CLAUDE_SESSION_ID: sessionId,
        CONTEXT_MODE_PLATFORM: "claude-code",
        HOME: fakeHomeDir,
        USERPROFILE: fakeHomeDir,
      },
    });
  }

  beforeAll(() => {
    fakeRoot = mkdtempSync(join(tmpdir(), "ctx-breadcrumb-"));
    // The cleanup only fires when CLAUDE_PLUGIN_ROOT matches
    // .../plugins/cache/<owner>/<plugin>/<version>.
    cacheParent = join(fakeRoot, "plugins", "cache", "context-mode", "context-mode");
    currentDir = join(cacheParent, "1.0.200");
    mkdirSync(currentDir, { recursive: true });

    // A working plugin install inside the current version dir.
    cpSync(join(BREADCRUMB_ROOT, "hooks"), join(currentDir, "hooks"), { recursive: true });
    cpSync(join(BREADCRUMB_ROOT, "package.json"), join(currentDir, "package.json"));
    if (existsSync(join(BREADCRUMB_ROOT, "node_modules"))) {
      symlinkSync(join(BREADCRUMB_ROOT, "node_modules"), join(currentDir, "node_modules"));
    }

    fakeProjectDir = mkdtempSync(join(tmpdir(), "ctx-breadcrumb-project-"));
    fakeHomeDir = mkdtempSync(join(tmpdir(), "ctx-breadcrumb-home-"));
  });

  afterAll(() => {
    for (const dir of [fakeRoot, fakeProjectDir, fakeHomeDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  test("an aged-out real version dir is replaced by a link to the current version", () => {
    const oldDir = join(cacheParent, "1.0.100");
    mkdirSync(join(oldDir, "hooks"), { recursive: true });
    writeFileSync(join(oldDir, "hooks", "pretooluse.mjs"), "// stale version\n");
    utimesSync(oldDir, TWO_HOURS_AGO, TWO_HOURS_AGO);

    const result = runSessionStart("breadcrumb-real-dir");
    expect(result.status).toBe(0);

    // The stale dir's contents are gone, but the path still resolves:
    // a session pinned to .../1.0.100/hooks/... follows the breadcrumb
    // into the live version instead of erroring.
    expect(lstatSync(oldDir).isSymbolicLink()).toBe(true);
    expect(realpathSync(oldDir)).toBe(realpathSync(currentDir));
    expect(existsSync(join(oldDir, "hooks", "sessionstart.mjs"))).toBe(true);
  });

  test("a stale breadcrumb pointing at a removed intermediate version is re-pointed at the live root", () => {
    // Simulate a chain of updates: 1.0.050's breadcrumb targets 1.0.150,
    // which has since been deleted itself — the link is dangling.
    const danglingTarget = join(cacheParent, "1.0.150");
    const oldLink = join(cacheParent, "1.0.050");
    symlinkSync(danglingTarget, oldLink, process.platform === "win32" ? "junction" : undefined);
    lutimesSync(oldLink, TWO_HOURS_AGO, TWO_HOURS_AGO);

    const result = runSessionStart("breadcrumb-stale-link");
    expect(result.status).toBe(0);

    expect(lstatSync(oldLink).isSymbolicLink()).toBe(true);
    expect(realpathSync(oldLink)).toBe(realpathSync(currentDir));
  });

  test("a fresh version dir is left alone (#644 age gate still respected)", () => {
    const freshDir = join(cacheParent, "1.0.199");
    mkdirSync(freshDir, { recursive: true });
    writeFileSync(join(freshDir, "marker.txt"), "fresh\n");

    const result = runSessionStart("breadcrumb-fresh-dir");
    expect(result.status).toBe(0);

    expect(lstatSync(freshDir).isDirectory()).toBe(true);
    expect(existsSync(join(freshDir, "marker.txt"))).toBe(true);
  });
});
