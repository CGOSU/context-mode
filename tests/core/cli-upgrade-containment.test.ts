import { readServerSource } from "../helpers/server-source.js";
import { readCliSource } from "../helpers/cli-source.js";
import { describe, test, expect } from "vitest";

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";





const ROOT = resolve(import.meta.dirname, "../..");

describe("ctx-upgrade swap loop supply-chain containment", () => {
  const CLI_SOURCE = readCliSource();
  const SERVER_SOURCE = readServerSource();

  // Both /ctx-upgrade swap loops iterate `pkg.files[]` read from a freshly
  // cloned upstream package.json. Without containment, a compromised
  // upstream tag shipping files: ["../../.ssh/authorized_keys"] (or, at
  // the cli.ts site, an absolute path) would let rmSync+cpSync escape
  // pluginRoot. Mirrors the lexical guard pattern that
  // hooks/heal-partial-install.mjs already uses (PR #699).

  test("cli.ts upgrade() rejects swap-loop items that escape pluginRoot or srcDir", () => {
    // The block of interest is bounded by the comment about reading
    // files from the cloned package.json and the next Issue #609 marker.
    const loopBlock = CLI_SOURCE.match(
      /Read files list from cloned repo's package\.json[\s\S]*?Issue #609/,
    );
    expect(loopBlock).not.toBeNull();
    expect(loopBlock![0]).toContain("resolve(pluginRoot) + sep");
    expect(loopBlock![0]).toContain("resolve(srcDir) + sep");
    expect(loopBlock![0]).toMatch(/\(to \+ sep\)\.startsWith\(pluginRootWithSep\)/);
    expect(loopBlock![0]).toMatch(/\(from \+ sep\)\.startsWith\(srcDirWithSep\)/);
    // The pre-fix unguarded form must not return.
    expect(loopBlock![0]).not.toMatch(
      /rmSync\(resolve\(pluginRoot, item\),[^)]*\);\s*\n\s*cpSync\(resolve\(srcDir, item\)/,
    );
    // sep must be imported from node:path.
    expect(CLI_SOURCE).toMatch(
      /import\s*\{[^}]*\bsep\b[^}]*\}\s*from\s*"node:path"/,
    );
    // F30 hardening: symlinks inside source items must be filtered, not
    // copied as destination symlinks. A planted symlink would otherwise
    // bypass the lexical containment at copy time.
    expect(loopBlock![0]).toContain("refuseSymlinks");
    expect(loopBlock![0]).toMatch(/lstatSync\(src\)\.isSymbolicLink\(\)/);
    expect(loopBlock![0]).toMatch(/cpSync\(from, to, \{ recursive: true, filter: refuseSymlinks \}\)/);
    // lstatSync must be imported from node:fs.
    expect(CLI_SOURCE).toMatch(
      /import\s*\{[^}]*\blstatSync\b[^}]*\}\s*from\s*"node:fs"/,
    );
  });

  test("server.ts inline-fallback upgrade script rejects swap-loop items that escape pluginRoot or srcDir", () => {
    // The inline-script lines are literal-string template segments inside
    // the ctx_upgrade handler's scriptLines array, so the guards land as
    // quoted lines in src/server.ts.
    expect(SERVER_SOURCE).toContain('import{join,resolve,sep}from"node:path"');
    expect(SERVER_SOURCE).toContain("const PW=resolve(P)+sep;const TW=resolve(T)+sep;");
    expect(SERVER_SOURCE).toContain("if(!(to+sep).startsWith(PW))continue;");
    expect(SERVER_SOURCE).toContain("if(!(from+sep).startsWith(TW))continue;");
    // The pre-fix unguarded join-only form must not return.
    expect(SERVER_SOURCE).not.toMatch(
      /for\(const item of items\)\{const from=join\(T,item\);const to=join\(P,item\);if\(existsSync\(from\)\)/,
    );
    // F30 hardening for the inline script.
    expect(SERVER_SOURCE).toMatch(
      /import\{[^}]*\blstatSync\b[^}]*\}from"node:fs"/,
    );
    expect(SERVER_SOURCE).toContain('const noSymlink=(src)=>{try{return !lstatSync(src).isSymbolicLink()}catch{return false}};');
    expect(SERVER_SOURCE).toContain("if(!noSymlink(from))continue;");
    expect(SERVER_SOURCE).toContain("filter:noSymlink");
  });

  test("algorithm: lexical containment guard rejects relative and absolute traversal items", async () => {
    // Sandbox replay of the guard logic. Two trees: pluginRoot/ and
    // srcDir/. Plant a victim file at base/OUTSIDE/victim.txt and an
    // absolute-path probe at base/etc/passwd. Run the same guard the
    // production swap loop uses; assert the malicious items are skipped
    // and the legitimate item is the only one accepted.
    const base = mkdtempSync(join(tmpdir(), "swap-loop-containment-"));
    try {
      const pluginRoot = join(base, "plugin", "root");
      const srcDir = join(base, "src", "dir");
      const outside = join(base, "OUTSIDE");
      const etc = join(base, "etc");
      mkdirSync(pluginRoot, { recursive: true });
      mkdirSync(srcDir, { recursive: true });
      mkdirSync(outside, { recursive: true });
      mkdirSync(etc, { recursive: true });
      writeFileSync(join(outside, "victim.txt"), "ATTACKER_WOULD_DELETE_ME");
      writeFileSync(join(etc, "passwd"), "PRETEND_PASSWD");
      mkdirSync(join(srcDir, "src"), { recursive: true });
      writeFileSync(join(srcDir, "src", "index.ts"), "ok");

      const { sep } = await import("node:path");
      const pluginRootWithSep = resolve(pluginRoot) + sep;
      const srcDirWithSep = resolve(srcDir) + sep;
      const items = [
        "../../OUTSIDE/victim.txt", // relative traversal
        join(etc, "passwd"),         // absolute-path bypass
        "src",                       // legitimate
      ];
      const accepted: string[] = [];
      for (const item of items) {
        const from = resolve(srcDir, item);
        const to = resolve(pluginRoot, item);
        if (!(to + sep).startsWith(pluginRootWithSep)) continue;
        if (!(from + sep).startsWith(srcDirWithSep)) continue;
        accepted.push(item);
      }
      expect(accepted).toEqual(["src"]);
      // Victim files must remain untouched.
      expect(existsSync(join(outside, "victim.txt"))).toBe(true);
      expect(existsSync(join(etc, "passwd"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("installed_plugins.json installPath containment", () => {
  // installed_plugins.json is written by Claude Code itself with installPath
  // values under <claudeRoot>/plugins/cache/<marketplace>/<plugin>/<version>.
  // Any installPath that resolves elsewhere has been tampered with by a co-
  // resident plugin, a malicious postinstall, or another local actor. cli.ts
  // consumes the field in two hot places: the upgrade() skills sync (cpSync
  // into installPath) and statuslineForward() (dynamic import from
  // installPath/bin/statusline.mjs, ~3-5 Hz while CC is open). Both sites
  // need the same lexical guard that server.ts:790 already uses on the
  // same field.

  const CLI_SOURCE = readCliSource();

  test("upgrade() skills cpSync gates installPath under <claudeRoot>/plugins/cache", () => {
    // Bound the slice to the upgrade() skills-sync block.
    const upgradeStart = CLI_SOURCE.indexOf("async function upgrade");
    expect(upgradeStart).toBeGreaterThan(0);
    const skillsBlock = CLI_SOURCE
      .slice(upgradeStart)
      .match(/Sync skills to the active install path[\s\S]*?best effort — registry may not exist or be malformed/);
    expect(skillsBlock).not.toBeNull();
    expect(skillsBlock![0]).toContain('resolve(claudeRoot, "plugins", "cache")');
    expect(skillsBlock![0]).toMatch(/\(resolvedInstallPath \+ sep\)\.startsWith\(cacheRootWithSep\)/);
    // The pre-fix shape passed installPath verbatim to cpSync without
    // normalizing or gating it.
    expect(skillsBlock![0]).not.toMatch(
      /cpSync\(srcSkills, resolve\(installPath, "skills"\),/,
    );
    // F30 hardening: realpathSync re-check defeats symlink-anchor bypasses
    // where the cacheRoot-anchored installPath is itself a symlink to an
    // attacker target.
    expect(skillsBlock![0]).toMatch(/realpathSync\(cacheRoot\)/);
    expect(skillsBlock![0]).toMatch(/realpathSync\(resolvedInstallPath\)/);
    expect(skillsBlock![0]).toMatch(/\(realInstallPath \+ sep\)\.startsWith\(cacheRootWithSep\)/);
    expect(skillsBlock![0]).toMatch(/cpSync\(srcSkills, resolve\(realInstallPath, "skills"\)/);
  });

  test("statuslineForward() candidate selection gates installPath under <claudeRoot>/plugins/cache", () => {
    // Slice to the statuslineForward() function body.
    const statuslineStart = CLI_SOURCE.indexOf("statuslineForward");
    expect(statuslineStart).toBeGreaterThan(0);
    const tail = CLI_SOURCE.slice(statuslineStart);
    // The candidate-building block runs between the candidates[] declaration
    // and the candidates.find() that picks the script to import.
    const candidateBlock = tail.match(
      /candidates: string\[\] = \[[\s\S]*?candidates\.find\(/,
    );
    expect(candidateBlock).not.toBeNull();
    expect(candidateBlock![0]).toContain('resolve(claudeRoot, "plugins", "cache")');
    expect(candidateBlock![0]).toMatch(/\(resolvedInstallPath \+ sep\)\.startsWith\(cacheRootWithSep\)/);
    // The pre-fix shape pushed any installPath string into candidates without
    // gating it.
    expect(candidateBlock![0]).not.toMatch(
      /candidates\.push\(resolve\(installPath, "bin", "statusline\.mjs"\)\)/,
    );
    // F30 hardening: realpathSync re-check on the candidate's installPath.
    expect(candidateBlock![0]).toMatch(/realpathSync\(cacheRoot\)/);
    expect(candidateBlock![0]).toMatch(/realpathSync\(resolvedInstallPath\)/);
    expect(candidateBlock![0]).toMatch(/\(realInstallPath \+ sep\)\.startsWith\(cacheRootWithSep\)/);
    expect(candidateBlock![0]).toMatch(/candidates\.push\(resolve\(realInstallPath, "bin", "statusline\.mjs"\)\)/);
    // realpathSync must be imported from node:fs.
    expect(CLI_SOURCE).toMatch(
      /import\s*\{[^}]*\brealpathSync\b[^}]*\}\s*from\s*"node:fs"/,
    );
  });

  test("algorithm: realpath re-check rejects symlink-anchor planted at cacheRoot/<owner>/<plugin>/<version>", async () => {
    // Sandbox: build <fakeClaudeRoot>/plugins/cache/owner/plugin/version
    // as a SYMLINK targeting an attacker-controlled directory outside
    // cacheRoot. The lexical resolve+startsWith check passes (the symlink
    // path itself is under cacheRoot). realpathSync follows the link and
    // returns the attacker target -- which then fails the post-realpath
    // startsWith gate.
    const fs = await import("node:fs");
    // Canonicalize the base directory up front: on macOS, mkdtempSync(tmpdir())
    // returns a path under /var/folders, which is itself a symlink to
    // /private/var/folders. Without realpathSync here, the legit-installPath
    // arm below trips the lexical startsWith gate (resolved input still
    // /var/folders/..., cacheRootCanon is /private/var/folders/...). Same
    // canonicalization production users get when ~/.claude lives on a real
    // (non-symlinked) path.
    const base = fs.realpathSync(
      mkdtempSync(join(tmpdir(), "installpath-symlink-anchor-")),
    );
    try {
      const cacheRoot = resolve(base, ".claude", "plugins", "cache");
      const legitVersionDir = resolve(cacheRoot, "owner", "plugin", "1.0.0");
      const attackerDir = resolve(base, "attacker-target");
      mkdirSync(legitVersionDir, { recursive: true });
      mkdirSync(attackerDir, { recursive: true });
      writeFileSync(join(attackerDir, "marker.txt"), "PWNED");

      // Planted symlink anchor: <cacheRoot>/owner/plugin/2.0.0 -> attackerDir.
      // On Windows without symlink privilege / Developer Mode, symlinkSync
      // with type "dir" fails with EPERM; "junction" works without privilege
      // and still reports isSymbolicLink()===true under lstatSync.
      const plantedAnchor = resolve(cacheRoot, "owner", "plugin", "2.0.0");
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(attackerDir, plantedAnchor, symlinkType);

      const cacheRootCanon = fs.realpathSync(cacheRoot);
      const cacheRootWithSep = cacheRootCanon + require("node:path").sep;

      const isAccepted = (installPath: string): boolean => {
        const resolvedInstallPath = resolve(installPath);
        if (!(resolvedInstallPath + require("node:path").sep).startsWith(cacheRootWithSep)) return false;
        let realInstallPath: string;
        try { realInstallPath = fs.realpathSync(resolvedInstallPath); }
        catch { return false; }
        return (realInstallPath + require("node:path").sep).startsWith(cacheRootWithSep);
      };

      // Legit version dir: accepted.
      expect(isAccepted(legitVersionDir)).toBe(true);
      // Symlink anchor: lexical passes, realpath escapes -> rejected.
      expect(isAccepted(plantedAnchor)).toBe(false);
      // Direct attacker path: lexical rejects immediately.
      expect(isAccepted(attackerDir)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("algorithm: containment rejects installPath values outside the cache root", async () => {
    // Sandbox a fake <claudeRoot> tree with a cache dir holding one
    // legitimate plugin entry, plus a malicious entry pointing at an
    // attacker-chosen directory outside the cache. Replay the production
    // guard; assert only the legitimate entry survives.
    const claudeRoot = mkdtempSync(join(tmpdir(), "installpath-containment-"));
    try {
      const cacheRoot = resolve(claudeRoot, "plugins", "cache");
      const legitCacheDir = resolve(cacheRoot, "context-mode", "context-mode", "1.0.0");
      const attackerDir = resolve(claudeRoot, "outside-cache", "evil");
      mkdirSync(legitCacheDir, { recursive: true });
      mkdirSync(attackerDir, { recursive: true });

      const { sep } = await import("node:path");
      const cacheRootWithSep = cacheRoot + sep;
      const inputs = [
        { installPath: legitCacheDir, label: "legit" },
        { installPath: attackerDir, label: "outside-cache" },
        { installPath: "/etc", label: "absolute-system" },
        // Relative-".." escape: legitimate prefix then ".." up and out.
        { installPath: join(legitCacheDir, "..", "..", "..", "..", "outside-cache", "evil"), label: "traversal" },
      ];
      const accepted: string[] = [];
      for (const { installPath, label } of inputs) {
        if (typeof installPath !== "string" || !installPath) continue;
        const resolvedInstallPath = resolve(installPath);
        if (!(resolvedInstallPath + sep).startsWith(cacheRootWithSep)) continue;
        accepted.push(label);
      }
      expect(accepted).toEqual(["legit"]);
    } finally {
      rmSync(claudeRoot, { recursive: true, force: true });
    }
  });

  // Issue #795: when ~/.claude is a symlink to another volume, the
  // healCacheMidSession traversal guard in server.ts compares a lexical
  // cacheRoot (symlink path, e.g. /Users/me/.claude/plugins/cache) against
  // a physical installPath from the plugin registry (e.g.
  // /Volumes/SSD/claude-code/plugins/cache/...). Without canonicalizing
  // cacheRoot via realpathSync, the startsWith check fails and the heal
  // is skipped for every user with a symlinked ~/.claude.
  //
  // RED→GREEN: the source-level assertion (realpathSync on cacheRoot inside
  // healCacheMidSession) FAILS when the fix is reverted. The algorithmic
  // assertions prove the lexical comparison rejects and the canonical
  // comparison accepts the symlinked-layout entry.

  const SERVER_SOURCE = readServerSource();

  test("server.ts: healCacheMidSession canonicalizes cacheRoot with realpathSync (#795)", () => {
    // Locate the healCacheMidSession function body.
    const healStart = SERVER_SOURCE.indexOf("function healCacheMidSession");
    expect(healStart).toBeGreaterThan(0);
    const healBody = SERVER_SOURCE.slice(healStart);
    // Bound to the end of the function (the next top-level "function").
    const nextFn = healBody.indexOf("\nfunction ");
    const fnSlice = nextFn > 0 ? healBody.slice(0, nextFn) : healBody;

    // The fix canonicalizes cacheRoot via realpathSync with a try/catch
    // fallback, matching the pattern already used in cli.ts.
    expect(fnSlice).toMatch(/realpathSync\(cacheRoot\)/);
    // The traversal guard must use the canonical cacheRootCanon, not the
    // lexical cacheRoot directly.
    expect(fnSlice).toMatch(/cacheRootCanon\s*\+\s*sep/);
    // Pre-fix shape: startsWith(cacheRoot + sep) without canonicalization.
    // This pattern MUST NOT appear in the traversal guard for installPath.
    // (It may still appear in comments or string literals, so we scope the
    // negative assertion to the line that checks installPath containment.)
    expect(fnSlice).toMatch(/resolve\(rp\)\.startsWith\(cacheRootCanon/);
  });

  test("algorithm: canonical cacheRoot accepts physical installPath when ~/.claude is a symlink (#795)", async () => {
    // Skip on Windows: symlink-permission requirements vary and the
    // scenario the issue targets (symlink-rehomed ~/.claude to another
    // volume) is a macOS/macOS-on-Linux-Desktop pattern.
    if (process.platform === "win32") return;

    const fs = await import("node:fs");

    // Build two directories: the "real" target (simulates the external volume)
    // and the symlink path (simulates ~/.claude → external).
    const sandbox = mkdtempSync(join(tmpdir(), "ctx-795-cache-root-symlink-"));
    try {
      const realTarget = join(sandbox, "real-claude-root");
      const symlinkPath = join(sandbox, "dot-claude");
      mkdirSync(realTarget, { recursive: true });

      // Create the cache tree inside the real target.
      const realCacheRoot = resolve(realTarget, "plugins", "cache");
      const versionDir = resolve(realCacheRoot, "context-mode", "context-mode", "1.0.161");
      mkdirSync(versionDir, { recursive: true });

      // Simulate ~/.claude → realTarget
      fs.symlinkSync(realTarget, symlinkPath, process.platform === "win32" ? "junction" : "dir");

      // The cacheRoot as computed by resolveClaudeConfigDir():
      // path.resolve does NOT dereference symlinks, so cacheRoot uses the
      // symlink path (NOT the real path).
      const lexicalCacheRoot = resolve(symlinkPath, "plugins", "cache");
      // The canonical cacheRoot (what the fix produces via realpathSync).
      const canonicalCacheRoot = fs.realpathSync(lexicalCacheRoot);
      const canonicalCacheRootWithSep = canonicalCacheRoot + sep;

      // installPath as stored by the plugin registry: the physical path
      // under the real target (not the symlink path).
      const physicalInstallPath = resolve(realTarget, "plugins", "cache", "context-mode", "context-mode", "1.0.161");

      // Verification 1 — OLD behaviour (lexical, no fix):
      // The lexical comparison fails because the physical installPath
      // (/.../real-claude-root/...) does not start with the symlink-path
      // cacheRoot (/.../dot-claude/...).
      const lexicalPasses = resolve(physicalInstallPath).startsWith(lexicalCacheRoot + sep);
      expect(lexicalPasses).toBe(false); // RED: would skip the heal

      // Verification 2 — FIXED behaviour (canonical cacheRoot):
      // After canonicalizing cacheRoot via realpathSync, the physical
      // installPath does start with the canonical prefix.
      // realpathSync is used on both sides because on macOS /var is itself a
      // symlink to /private/var — resolve() alone stays on the non-canonical
      // side and fails the startsWith check.
      const canonicalPasses = fs.realpathSync(resolve(physicalInstallPath)).startsWith(canonicalCacheRootWithSep);
      expect(canonicalPasses).toBe(true); // GREEN: heal proceeds
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
