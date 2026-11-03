import { readServerSource } from "../helpers/server-source.js";
import { readCliSource } from "../helpers/cli-source.js";
import { describe, test, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";







const ROOT = resolve(import.meta.dirname, "../..");

// ── Issue #181: upgrade must not delete sibling version dirs mid-session ──

describe("Cache dir safety (#181)", () => {
  const CLI_SOURCE = readCliSource();
  const PRETOOLUSE_SOURCE = readFileSync(resolve(ROOT, "hooks/pretooluse.mjs"), "utf-8");

  test("cli.ts upgrade does not rmSync sibling cache version dirs", () => {
    // The upgrade function must NOT contain a loop that deletes sibling version dirs.
    // Old pattern: filter dirs !== myDir → rmSync each in a loop
    const hasStaleCleanup = CLI_SOURCE.includes("stale cache dir");
    expect(hasStaleCleanup).toBe(false);
  });

  test("pretooluse.mjs does not nuke stale version dirs", () => {
    // Step 4 "Nuke stale version dirs" must not exist
    const hasNukeBlock = PRETOOLUSE_SOURCE.includes("Nuke stale version dirs");
    expect(hasNukeBlock).toBe(false);
  });

  test("sessionstart.mjs has age-gated lazy cleanup for old cache dirs", () => {
    const SESSION_SOURCE = readFileSync(resolve(ROOT, "hooks/sessionstart.mjs"), "utf-8");
    // Must contain age-gated cleanup logic (>1 hour check)
    expect(SESSION_SOURCE).toContain("lazy cleanup");
    expect(SESSION_SOURCE).toContain("3600000"); // 1 hour in ms
  });

  // #644: statSync follows symlinks → fresh symlinks pointing at stale targets
  // were deleted, breaking sessions whose CLAUDE_PLUGIN_ROOT was pinned to one
  // of those linked versions. lstatSync evaluates the link's own mtime, so a
  // freshly-created symlink survives the gate even when its target is old.
  test("sessionstart.mjs cleanup uses lstatSync to age-check entries (#644)", () => {
    const SESSION_SOURCE = readFileSync(resolve(ROOT, "hooks/sessionstart.mjs"), "utf-8");

    // Isolate the lazy-cleanup block so we don't get false-positives from
    // unrelated stat calls elsewhere in the file.
    const blockStart = SESSION_SOURCE.indexOf("Age-gated lazy cleanup");
    expect(blockStart, "lazy cleanup block must exist").toBeGreaterThan(-1);
    const block = SESSION_SOURCE.slice(blockStart, blockStart + 1500);

    // The age check MUST use lstatSync (does not follow symlinks). The path may
    // be held in a local variable as long as it is derived from cacheParent + d.
    expect(block).toMatch(/const\s+oldDir\s*=\s*join\(\s*cacheParent\s*,\s*d\s*\)/);
    expect(block).toMatch(/lstatSync\(\s*oldDir\s*\)/);

    // The age check MUST NOT use statSync (follows symlinks → wrongly evaluates
    // the link target's mtime, causing fresh symlinks to be deleted).
    expect(block).not.toMatch(/(^|[^l])statSync\(\s*(?:join\(\s*cacheParent\s*,\s*d\s*\)|oldDir)\s*\)/);
  });
});

// ── Issue #418: ctx-upgrade must refresh the marketplace clone ──────

describe("ctx-upgrade syncs marketplace clone (#418)", () => {
  const CLI_SOURCE = readCliSource();
  const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
  const upgradeBody = CLI_SOURCE.slice(upgradeStart);

  test("upgrade() targets ~/.claude/plugins/marketplaces/context-mode for git refresh", () => {
    // CC's marketplace clone (separate from cache dir) was previously left
    // pinned at the install-time commit; users running /ctx-upgrade never
    // received upstream changes through the marketplace metadata path.
    expect(upgradeBody).toMatch(/marketplaces[\\/]+["']?\s*,\s*["']?context-mode["']?|"marketplaces"\s*,\s*"context-mode"/);
  });

  test("upgrade() runs git fetch + reset against marketplace dir", () => {
    // Required: actual git invocation against the marketplace path.
    // Look for fetch and reset --hard in the upgrade body.
    expect(upgradeBody).toMatch(/execFileSync\(\s*["']git["']\s*,\s*\[\s*["']-C["']/);
    expect(upgradeBody).toMatch(/["']fetch["']/);
    expect(upgradeBody).toMatch(/["']reset["'].*?["']--hard["']/s);
  });

  test("upgrade() guards on .git existence so tarball installs do not fail", () => {
    // Defensive guard — non-git install paths must not error out.
    expect(upgradeBody).toMatch(/existsSync\([^)]*marketplaceDir[^)]*\.git/);
  });

  test("upgrade() preserves user dev edits via git status --porcelain check", () => {
    // Mert-class users symlink the marketplace clone to a dev worktree.
    // Destructive `reset --hard` would wipe in-progress work — must skip
    // when uncommitted changes exist.
    expect(upgradeBody).toMatch(/["']status["'].*?["']--porcelain["']/s);
  });
});

describe("Shell-free upgrade (#185)", () => {
  const CLI_SOURCE = readCliSource();
  const SERVER_SOURCE = readServerSource();

  test("cli.ts upgrade function uses execFileSync, not execSync", () => {
    // Extract upgrade function body (from "async function upgrade" to end of file)
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);

    // Must not contain execSync( calls (but execFileSync is fine)
    const execSyncCalls = upgradeBody.match(/(?<!File)execSync\s*\(/g);
    expect(execSyncCalls).toBeNull();
  });

  test("cli.ts uses chmodSync instead of execSync chmod", () => {
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);

    // Must not shell out for chmod
    expect(upgradeBody).not.toContain('chmod +x');
    // Must use fs.chmodSync instead
    expect(upgradeBody).toContain("chmodSync");
  });

  test("cli.ts upgrade aborts when hook configuration fails instead of reporting success", () => {
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);

    expect(upgradeBody).toContain("Hook configuration failed");
    expect(upgradeBody).toMatch(/try\s*\{\s*const hookChanges = adapter\.configureAllHooks\(pluginRoot\)/s);
    expect(upgradeBody).toMatch(/\}\s*catch\s*\(err: unknown\)\s*\{[\s\S]*throw new Error\(`Hook configuration failed: \$\{message\}`\);/s);
  });

  test("cli.ts entrypoint catches upgrade() rejection and exits non-zero", () => {
    const entryStart = CLI_SOURCE.indexOf("const args = process.argv.slice(2);");
    expect(entryStart).toBeGreaterThan(-1);
    const entryBody = CLI_SOURCE.slice(entryStart, CLI_SOURCE.indexOf("/* -------------------------------------------------------", entryStart + 20));

    expect(entryBody).toContain('} else if (args[0] === "upgrade") {');
    // Issue #542 — entrypoint now forwards optional --platform <id> from
    // the ctx_upgrade MCP handler. Match either invocation shape:
    //   upgrade().catch(...)                      (legacy)
    //   upgrade(... ? { platform: ... } : ...).catch(...)  (issue #542)
    expect(entryBody).toMatch(/upgrade\([^)]*\)\.catch\(\(err: unknown\) => \{/);
    expect(entryBody).toContain("process.exit(1);");
  });

  test("cli.ts already-latest path still configures hooks", () => {
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);

    const alreadyLatestIdx = upgradeBody.indexOf('p.log.success(color.green("Already on latest")');
    expect(alreadyLatestIdx).toBeGreaterThan(-1);
    const configureIdx = upgradeBody.indexOf("adapter.configureAllHooks(pluginRoot)");
    expect(configureIdx).toBeGreaterThan(-1);
    expect(configureIdx).toBeGreaterThan(alreadyLatestIdx);
  });

  test("cli.ts swap loop guards rm/cp with existsSync(from)", () => {
    // Regression test for the partial-install vector: the rm/cp loop's
    // catch-all was swallowing cpSync failures, so a `files[]` entry
    // that didn't exist in the cloned source dropped the corresponding
    // pluginRoot path without replacement. Mirrors the safe pattern in
    // server.ts:3820 inline-fallback (`if (existsSync(from))` before any
    // rm or cp). Same architectural-lock as the rest of #609.
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(-1);
    const upgradeBody = CLI_SOURCE.slice(upgradeStart);
    const loopIdx = upgradeBody.indexOf("for (const item of items) {");
    expect(loopIdx, "swap loop missing in upgrade()").toBeGreaterThan(-1);
    const loopBody = upgradeBody.slice(loopIdx, loopIdx + 1200);
    // Source must exist before any rm/cp fires.
    expect(loopBody).toMatch(/if\s*\(!existsSync\(from\)\)\s*continue/);
    // The existsSync probe must come BEFORE rmSync inside the loop, not
    // after; otherwise it's a no-op guard against the actual vector.
    const guardIdx = loopBody.indexOf("if (!existsSync(from)) continue");
    const rmIdx = loopBody.indexOf("rmSync");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(rmIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(rmIdx);
  });

  test("server.ts inline fallback uses execFileSync, not execSync", () => {
    // The inline script template must use execFileSync
    const inlineStart = SERVER_SOURCE.indexOf("Inline fallback");
    expect(inlineStart).toBeGreaterThan(-1);
    const inlineSection = SERVER_SOURCE.slice(inlineStart, SERVER_SOURCE.indexOf("cmd =", inlineStart + 500));

    // Generated script lines must import execFileSync
    expect(inlineSection).toContain("execFileSync");
    expect(inlineSection).not.toMatch(/(?<!File)execSync/);
  });

  test("server.ts inline fallback copies package files including bin", () => {
    const inlineStart = SERVER_SOURCE.indexOf("Inline fallback");
    expect(inlineStart).toBeGreaterThan(-1);
    const inlineSection = SERVER_SOURCE.slice(inlineStart, SERVER_SOURCE.indexOf("cmd =", inlineStart + 500));

    expect(inlineSection).toContain('readFileSync(join(T,"package.json"),"utf8")');
    expect(inlineSection).toContain("pkg.files");
    expect(inlineSection).toContain("Array.isArray(pkg.files)");
    expect(inlineSection).toContain("for(const item of items)");
    // Issue #609: server.ts inline-fallback MUST NOT write `.mcp.json` either.
    // Same architectural-lock as cli.ts upgrade(). The inline-fallback was the
    // OTHER producer of per-version `.mcp.json` files — both writers had to go
    // for the carry-forward bug class to be structurally impossible.
    expect(inlineSection).not.toContain('writeFileSync(join(P,".mcp.json")');
    expect(inlineSection).not.toContain("copyDirs");
    expect(inlineSection).not.toContain("copyFiles");
  });
});

// ── Issue #186: temp dirs must be dot-prefixed to hide from VS Code ──

describe("Hidden temp dirs (#186)", () => {
  test("executor.ts uses dot-prefixed temp dir to avoid VS Code auto-open", () => {
    const EXEC_SOURCE = readFileSync(resolve(ROOT, "src/executor.ts"), "utf-8");
    // Must use .ctx-mode- prefix (dot-hidden) not ctx-mode-
    expect(EXEC_SOURCE).toContain('.ctx-mode-');
    expect(EXEC_SOURCE).not.toMatch(/tmpdir\(\),\s*"ctx-mode-"/);
  });
});

// ── Issue #187 follow-up: self-heal must fix ALL hook types, not just PreToolUse ──

describe("Self-heal hook-path rewriting (#187 + #415 follow-up)", () => {
  const PRETOOLUSE_SOURCE = readFileSync(resolve(ROOT, "hooks/pretooluse.mjs"), "utf-8");

  test("pretooluse.mjs no longer mutates settings.json from runtime hot path (#415)", () => {
    // v1.0.107 had a destructive `entries.filter(e => !e.hooks?.some(isCtxMode))`
    // block that wiped co-located user hooks. Removed in v1.0.108 — settings.json
    // mutation must only happen at install/upgrade time via configureAllHooks().
    expect(PRETOOLUSE_SOURCE).not.toContain("hooks.json owns hook registration");
    expect(PRETOOLUSE_SOURCE).not.toMatch(/entries\.filter\([^)]*!entry\.hooks\?\.some/);
  });

  test("pretooluse.mjs legacy stale-path rewrite still iterates ALL hook types (#187)", () => {
    // The legacy else-branch (rewrites stale context-mode hook paths to current
    // version dir when hooks.json is absent) must cover all hook types, not just
    // PreToolUse — that was the original #187 fix and remains intact.
    expect(PRETOOLUSE_SOURCE).not.toContain("settings.hooks?.PreToolUse");
    expect(PRETOOLUSE_SOURCE).toMatch(/for\s*\(\s*const\s+hookType\s+of\s+Object\.keys/);
  });
});

// ── Upgrade skill sync to marketplace/cache directories ───────────────────

describe("Upgrade syncs skills to active install path (#228)", () => {
  const CLI_SOURCE = readCliSource();
  const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
  // Bound the slice to the upgrade() function only — without this the slice
  // includes downstream helpers (statuslineForward, etc.) and assertions like
  // "no marketplace ref" fire on UNRELATED code added later in the file.
  const upgradeEnd = CLI_SOURCE.indexOf("\n/* ---", upgradeStart);
  const upgradeBody = CLI_SOURCE.slice(upgradeStart, upgradeEnd > 0 ? upgradeEnd : undefined);

  test("upgrade reads installed_plugins.json to find active install path", () => {
    expect(upgradeBody).toContain("installed_plugins.json");
    expect(upgradeBody).toContain("context-mode@context-mode");
    expect(upgradeBody).toContain("installPath");
  });

  test("upgrade only syncs when installPath differs from pluginRoot", () => {
    // Must short-circuit when installPath === pluginRoot before copying.
    // Accept either the original `installPath !== pluginRoot` conjunction
    // form OR the refactored early-continue form (`if (installPath ===
    // pluginRoot) continue;`).
    expect(upgradeBody).toMatch(
      /installPath.*!==.*pluginRoot|installPath\s*===\s*pluginRoot/,
    );
  });

  test("upgrade does NOT blindly copy to marketplace or cache directories", () => {
    // No hardcoded marketplace/cache paths — only installPath from registry
    const syncSection = upgradeBody.slice(upgradeBody.indexOf("installed_plugins.json"));
    expect(syncSection).not.toContain('"marketplaces"');
    expect(syncSection).not.toContain("readdirSync");
  });

  test("upgrade warns user to restart for new MCP tools", () => {
    expect(upgradeBody).toMatch(/[Rr]estart.*MCP|new MCP tools/i);
  });

  test("restart hint is adapter-aware (Claude Code gets /reload-plugins)", () => {
    expect(upgradeBody).toContain("reload-plugins");
    expect(upgradeBody).toContain('adapter.name === "Claude Code"');
  });
});
