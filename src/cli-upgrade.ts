/** CLI upgrade implementation; importing this module never dispatches commands. */


import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync } from "node:child_process";
import { readFileSync, cpSync, accessSync, existsSync, rmSync, chmodSync, lstatSync, realpathSync, constants } from "node:fs";
import { resolve, join, sep } from "node:path";
import { tmpdir, homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { resolveClaudeConfigDir } from "./util/claude-config.js";
// v1.0.128 — Issue #559 sibling MCP kill helpers (see PR-559-560-FIX-DESIGN.md).
import { discoverSiblingMcpPids, killSiblingMcpServers } from "./util/sibling-mcp.js";
// v1.0.119 — Issue #523 Layer 5 heal: post-bump assertion on .claude-plugin/plugin.json
// mcpServers args. Single source of truth shared with start.mjs HEAL block + postinstall.
// @ts-expect-error — JS module, no TS declarations
import { healPluginJsonMcpServers, sweepStaleMcpJson } from "../scripts/heal-installed-plugins.mjs";
// @ts-expect-error — JS module, no TS declarations
import { detectWindowsVsYear } from "../scripts/heal-better-sqlite3.mjs";
// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";
import { isInProcessPluginPlatform } from "./adapters/types.js";
import { npmExecFile, getPluginRoot, getLocalVersion } from "./cli-shared.js";


/* -------------------------------------------------------
 * Upgrade — adapter-aware hook configuration
 * ------------------------------------------------------- */

async function upgrade(opts?: { platform?: string }) {
  if (process.stdout.isTTY) console.clear();

  // Issue #542 — when the MCP ctx_upgrade handler threads through an
  // explicit --platform <id> (resolved from live clientInfo), trust it
  // over the local heuristic chain. detectPlatform() with no args cannot
  // see the MCP handshake and falls through to the config-dir tier,
  // which misdetects Pi/OMP installs as Cursor on systems where both
  // ~/.cursor/ and ~/.pi/ exist.
  const detection = opts?.platform
    ? { platform: opts.platform as Parameters<typeof getAdapter>[0], confidence: "high" as const, reason: `--platform ${opts.platform} from ctx_upgrade handler` }
    : detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgCyan(color.black(" context-mode upgrade ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence)`),
  );

  let pluginRoot = getPluginRoot();
  const changes: string[] = [];
  const s = p.spinner();

  // Step 0: Sync the marketplace clone (#418).
  // Claude Code reads plugin metadata from ~/.claude/plugins/marketplaces/context-mode/.
  // Without a git pull there, the marketplace stays pinned at the install-time
  // commit and CC keeps reporting the old version even after our cache dir is
  // updated — users then see "ctx-upgrade succeeded" but nothing actually
  // changed at the plugin-system level.
  // Issue #460 round-3: route through resolveClaudeConfigDir so users who
  // relocate their CC config root keep the marketplace clone in the same tree.
  const marketplaceDir = resolve(resolveClaudeConfigDir(), "plugins", "marketplaces", "context-mode");
  if (existsSync(join(marketplaceDir, ".git"))) {
    s.start("Syncing marketplace clone");
    try {
      // Preserve user dev edits (Mert-class users symlink the clone to a worktree).
      const statusOut = execFileSync(
        "git", ["-C", marketplaceDir, "status", "--porcelain"],
        { stdio: "pipe", encoding: "utf-8", timeout: 5000 },
      );
      if (statusOut.trim()) {
        s.stop(color.yellow("Marketplace clone has local edits — skipping git pull"));
        p.log.info(
          color.dim(`  Run manually: git -C "${marketplaceDir}" stash && git pull --ff-only`),
        );
      } else {
        execFileSync(
          "git", ["-C", marketplaceDir, "fetch", "--tags", "origin"],
          { stdio: "pipe", timeout: 30000 },
        );
        execFileSync(
          "git", ["-C", marketplaceDir, "reset", "--hard", "origin/HEAD"],
          { stdio: "pipe", timeout: 10000 },
        );
        s.stop(color.green("Marketplace clone synced"));
        changes.push("Marketplace clone updated to upstream");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      s.stop(color.yellow("Marketplace sync skipped"));
      p.log.warn(color.yellow("git refresh on marketplace failed") + ` — ${message}`);
      p.log.info(color.dim("  Continuing — cache dir update will still happen."));
    }
  }

  // Step 1: Pull latest from GitHub
  p.log.step("Pulling latest from GitHub...");
  const localVersion = getLocalVersion();
  const tmpDir = join(tmpdir(), `context-mode-upgrade-${Date.now()}`);

  s.start("Cloning mksglu/context-mode");
  try {
    execFileSync(
      "git", ["clone", "--depth", "1", "https://github.com/mksglu/context-mode.git", tmpDir],
      { stdio: "pipe", timeout: 30000 },
    );
    s.stop("Downloaded");

    const srcDir = tmpDir;
    const newPkg = JSON.parse(
      readFileSync(resolve(srcDir, "package.json"), "utf-8"),
    );
    const newVersion = newPkg.version ?? "unknown";

    if (newVersion === localVersion) {
      p.log.success(color.green("Already on latest") + ` — v${localVersion}`);
      rmSync(tmpDir, { recursive: true, force: true });
    } else {
      p.log.info(
        `Update available: ${color.yellow("v" + localVersion)} → ${color.green("v" + newVersion)}`,
      );

      // v1.0.128 — Issue #559: terminate sibling MCP servers BEFORE installing
      // new files. Historically /ctx-upgrade rsynced new code over the old
      // tree but never signalled the running MCP server, so the previous
      // version stayed alive holding stdio + DB handles. Across enough
      // upgrades users observed 5+ context-mode start.mjs processes pinned
      // to RAM. Discovery + kill must happen before npm install to avoid
      // racing against the EXCLUSIVE lock the new server claims on first
      // ctx_search (see #560 fix). Wrapped in try/catch so a missing pgrep
      // (stripped Linux distro) or unavailable PowerShell (weird Windows)
      // can never block the upgrade itself.
      try {
        const siblingPids = discoverSiblingMcpPids({
          ownPid: process.pid,
          ownPpid: process.ppid,
        });
        if (siblingPids.length > 0) {
          const killReport = await killSiblingMcpServers({ pids: siblingPids });
          if (killReport.totalKilled > 0) {
            // Concise summary only — no PIDs in the user-facing log to keep
            // the line readable. Plural-aware so "1 sibling MCP server" reads
            // naturally alongside "3 sibling MCP servers".
            const noun = killReport.totalKilled === 1
              ? "sibling MCP server"
              : "sibling MCP servers";
            p.log.info(
              color.dim(
                `Stopped ${killReport.totalKilled} ${noun} (SIGTERM: ${killReport.terminatedBySigterm}, SIGKILL: ${killReport.terminatedBySigkill})`,
              ),
            );
          }
        }
      } catch { /* never block upgrade on discovery/kill failure */ }

      // Step 2: Install dependencies + build
      s.start("Installing dependencies & building");
      const vsYear = detectWindowsVsYear();
      npmExecFile(["install", "--no-audit", "--no-fund"], {
        cwd: srcDir,
        stdio: "pipe",
        timeout: 120000,
        ...(vsYear ? { env: { ...process.env, npm_config_msvs_version: vsYear } } : {}),
      });
      npmExecFile(["run", "build"], {
        cwd: srcDir,
        stdio: "pipe",
        timeout: 60000,
      });
      s.stop("Built successfully");

      // Step 3: Update in-place
      s.start("Updating files in-place");

      // Old version dirs are cleaned lazily by sessionstart.mjs (age-gated >1h)
      // to avoid breaking active sessions that still reference them (#181).

      // Read files list from cloned repo's package.json so new directories
      // (like insight/) are automatically included without chicken-and-egg issues
      // where the old CLI doesn't know about new directories.
      const clonedPkg = JSON.parse(readFileSync(resolve(srcDir, "package.json"), "utf-8"));
      const items = [
        ...(clonedPkg.files || []),
        "src", "package.json",
      ];
      // Supply-chain containment on items[]. A compromised upstream tag
      // shipping files: ["../../.ssh/authorized_keys"] or an absolute
      // path would, without a guard, hand rmSync+cpSync an arbitrary
      // destination under the user's UID. resolve(P, "/abs") discards P,
      // so the absolute-path variant escapes too. Reject items whose
      // resolved path escapes either srcDir or pluginRoot. Mirrors the
      // pattern hooks/heal-partial-install.mjs already uses for its own
      // files[] expansion (PR #699).
      //
      // Also refuse to copy any symlink encountered anywhere under a
      // source item. cpSync's default is to preserve source symlinks as
      // destination symlinks; a compromised upstream tag committing a
      // symlink to /etc inside src/ would plant that link in pluginRoot,
      // and the next Claude Code session that loads pluginRoot/src/*
      // would dereference through to the attacker target. Filtering at
      // copy time keeps pluginRoot symlink-free regardless of what the
      // clone shipped.
      const pluginRootWithSep = resolve(pluginRoot) + sep;
      const srcDirWithSep = resolve(srcDir) + sep;
      const refuseSymlinks = (src: string): boolean => {
        try { return !lstatSync(src).isSymbolicLink(); } catch { return false; }
      };
      for (const item of items) {
        const from = resolve(srcDir, item);
        const to = resolve(pluginRoot, item);
        if (!(to + sep).startsWith(pluginRootWithSep)) continue;
        if (!(from + sep).startsWith(srcDirWithSep)) continue;
        if (!refuseSymlinks(from)) continue;
        // Existence-check the source BEFORE the rm so a `files[]` entry that
        // doesn't exist in srcDir can never delete-without-replace at
        // pluginRoot. The catch-all below swallows cpSync failures too, and
        // a swallowed cp after a successful rm is exactly how a partial
        // install lands silently. Mirrors the safe pattern in
        // server.ts's inline-fallback upgrade path (PR #699).
        if (!existsSync(from)) continue;
        try {
          rmSync(to, { recursive: true, force: true });
          cpSync(from, to, { recursive: true, filter: refuseSymlinks });
        } catch { /* best effort, next /ctx-upgrade retries */ }
      }

      // Issue #609 — DO NOT write `.mcp.json` into the plugin cache dir.
      //
      // Historical context: #411 fixed an absolute-path bake by writing the
      // ${CLAUDE_PLUGIN_ROOT} placeholder form here. #531 (commit 9261377)
      // removed `.mcp.json` from `package.json files[]` so the npm tarball
      // stopped shipping it. But the cli-side write persisted, so every
      // /ctx-upgrade re-baked one. When Claude Code's native plugin manager
      // auto-update later carries a previous version's `.mcp.json` forward
      // into a fresh version dir, the stale start.mjs absolute path goes
      // with it → MODULE_NOT_FOUND on every MCP boot.
      //
      // Architectural fix: Claude Code reads `.claude-plugin/plugin.json`
      // .mcpServers as the canonical source (upstream:
      // refs/platforms/claude-code/src/utils/plugins/mcpPluginIntegration.ts:131-212).
      // `.mcp.json` is a redundant per-version artifact whose only role
      // historically was to be a write-time poison vector. Don't write it.
      // The post-bump cache-sweep below removes any pre-existing copies so
      // the previous-version-carry vector cannot replay.

      // Issue #711 + #414 split: normalize hooks.json (only) here.
      //
      //   - plugin.json must NOT be normalized during /ctx-upgrade — Claude
      //     Code carries it forward into new versioned cache dirs on
      //     auto-update, so baked absolute paths go stale (#711).
      //   - hooks/hooks.json MUST be normalized during /ctx-upgrade on
      //     Windows + Git Bash — Claude Code fires SessionStart / PreToolUse
      //     BEFORE the MCP server boots, so the unresolved
      //     `${CLAUDE_PLUGIN_ROOT}` placeholder yields MODULE_NOT_FOUND for
      //     the first hook fire after upgrade (#414, originally wired in
      //     13d1342 / #528).
      //
      // The narrow `normalizeHooksJsonOnly` helper preserves both invariants.
      // start.mjs continues to call the full `normalizeHooksOnStartup` at the
      // next MCP boot to re-heal plugin.json against the live __dirname.
      try {
        // #738: pass the resolved Bun ≥1.0 path so /ctx-upgrade's hooks.json
        // rewrite gains the same cold-start win as the boot-time rewrite.
        // Probe failures fall through to nodePath default.
        let jsRuntimePath: string | undefined;
        try {
          const { resolveHookRuntime } = await import("./runtime.js");
          const r = resolveHookRuntime();
          if (r.isBun) jsRuntimePath = r.path;
        } catch { /* best effort */ }
        const mod: { normalizeHooksJsonOnly: (opts: { pluginRoot: string; nodePath: string; jsRuntimePath?: string; platform: string }) => void } =
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (await import("../hooks/normalize-hooks.mjs" as any)) as any;
        mod.normalizeHooksJsonOnly({
          pluginRoot,
          nodePath: process.execPath,
          jsRuntimePath,
          platform: process.platform,
        });
      } catch { /* best effort — never block upgrade */ }

      // Issue #710 — Layer 1: rewrite stale shell-snapshot PATH entries.
      //
      // Claude Code's per-session shell snapshot
      // (~/.claude/shell-snapshots/snapshot-*.sh, baked at session boot —
      // refs/platforms/claude-code/src/utils/bash/ShellSnapshot.ts:269-336)
      // is `source`d before every Bash tool call. It contains an
      // `export PATH='…'` line including the context-mode `bin/` for the
      // version active at session start. /ctx-upgrade deletes the old
      // cache dir mid-session — the snapshot still points at it, so every
      // Bash call fails with "Plugin directory does not exist" until the
      // session restarts. Layer 1 fixes the active session immediately;
      // Layer 2 (sessionstart.mjs) heals any session that started before
      // /ctx-upgrade ran.
      //
      // claude-code only — no other adapter uses shell-snapshots. Skip
      // when running under a non-claude-code adapter (Codex/Cursor/Gemini
      // etc. spawn Bash differently and have no `~/.claude/shell-snapshots`
      // tree). Best-effort, idempotent, never throws.
      try {
        if (detection.platform === "claude-code") {
          const { rewriteShellSnapshots } = await import(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            "../hooks/cache-heal-utils.mjs" as any
          ) as { rewriteShellSnapshots: (opts: { snapshotsDir: string; currentVersion: string }) => { rewritten: string[] } };
          const snapshotsDir = resolve(resolveClaudeConfigDir(), "shell-snapshots");
          const result = rewriteShellSnapshots({
            snapshotsDir,
            currentVersion: newVersion,
          });
          if (result.rewritten.length > 0) {
            p.log.info(color.dim(`  Healed ${result.rewritten.length} stale shell snapshot(s) — Bash tool calls in the active session will pick up v${newVersion} immediately`));
          }
        }
      } catch { /* best effort — never block upgrade */ }

      s.stop(color.green(`Updated in-place to v${newVersion}`));

      // v1.0.114 hotfix — pre-flight: verify the in-place copy actually
      // wrote a plugin.json carrying newVersion BEFORE we tell the
      // registry that's the install path. If the manifest still reports
      // the old version (rsync race, partial write, files-array drift),
      // updating the registry would create the silent v1.0.113-class
      // drift Mert hit. Bail out — the next /ctx-upgrade gets to retry.
      const pluginManifest = resolve(pluginRoot, ".claude-plugin", "plugin.json");
      let onDiskVersion: string | null = null;
      try {
        const pj = JSON.parse(readFileSync(pluginManifest, "utf-8"));
        if (pj && typeof pj.version === "string") onDiskVersion = pj.version;
      } catch { /* parse error → onDiskVersion stays null */ }
      if (onDiskVersion !== newVersion) {
        throw new Error(
          `pluginRoot manifest version mismatch — disk says "${onDiskVersion ?? "<missing>"}" but newVersion is "${newVersion}". Refusing to bump registry.`,
        );
      }

      // Fix registry — adapter-aware
      adapter.updatePluginRegistry(pluginRoot, newVersion);
      p.log.info(color.dim("  Registry synced to " + pluginRoot));

      // v1.0.114 hotfix — post-write assertion: re-read installed_plugins.json
      // and verify installPath/.claude-plugin/plugin.json's version matches
      // the registry entry. Throws on mismatch — fails loudly so a future
      // adapter regression surfaces here, not weeks later in user reports.
      try {
        const ipPath = resolve(resolveClaudeConfigDir(), "plugins", "installed_plugins.json");
        if (existsSync(ipPath)) {
          const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
          const entries = ip?.plugins?.["context-mode@context-mode"];
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const ip2 = entry?.installPath;
              if (typeof ip2 !== "string" || !ip2) continue;
              if (!existsSync(ip2)) {
                throw new Error(`installPath does not exist on disk: ${ip2}`);
              }
              const pjPath = resolve(ip2, ".claude-plugin", "plugin.json");
              if (!existsSync(pjPath)) {
                throw new Error(`missing plugin.json manifest at ${pjPath}`);
              }
              const pj = JSON.parse(readFileSync(pjPath, "utf-8"));
              if (pj?.version !== entry.version) {
                throw new Error(
                  `version mismatch — registry says "${entry.version}" but ${pjPath} says "${pj?.version}"`,
                );
              }
            }
          }
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Registry consistency check failed: ${message}`);
      }

      // v1.0.119 — Issue #523 — Layer 5 heal: assert .claude-plugin/plugin.json's
      // mcpServers["context-mode"].args[0] is the literal ${CLAUDE_PLUGIN_ROOT}/start.mjs
      // placeholder, not a tmpdir-prefixed absolute path. cli.ts already wrote .mcp.json
      // with the placeholder (#411 fix), but plugin.json was never touched here — and
      // start.mjs's normalize-hooks (Windows + #378) can bake in absolute paths that
      // become stale across upgrades. We call the shared heal twice: first call cleans
      // any drift; second call MUST return healed:[] or we throw. Single source of
      // truth shared with start.mjs HEAL block + postinstall.
      try {
        const pluginCacheRoot = resolve(resolveClaudeConfigDir(), "plugins", "cache");
        const pluginKey = "context-mode@context-mode";
        const firstPass = healPluginJsonMcpServers({ pluginRoot, pluginCacheRoot, pluginKey });
        if (firstPass && firstPass.error) {
          throw new Error(firstPass.error);
        }
        const secondPass = healPluginJsonMcpServers({ pluginRoot, pluginCacheRoot, pluginKey });
        if (secondPass && Array.isArray(secondPass.healed) && secondPass.healed.length > 0) {
          throw new Error(
            `Plugin manifest drift: plugin.json mcpServers.args still poisoned after first heal pass (healed=${secondPass.healed.join(",")})`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`plugin.json drift check failed: ${message}`);
      }

      // Issue #609 — Layer 6 replacement: sweep stale `.mcp.json` files from
      // every per-version cache dir. Supersedes the previous healMcpJsonArgs
      // drift-check block (v1.0.122) — that block existed because cli.ts
      // itself wrote `.mcp.json`. With the write gone (above), the only
      // remaining `.mcp.json` files are stale carry-forwards from earlier
      // versions. Sweep them so Claude Code's auto-update can't replay them
      // into a fresh version dir.
      //
      // Belt-and-braces: a second sweep call MUST report removed:[] or we
      // throw — same architectural-lock pattern as the plugin.json drift
      // check above. Single source of truth shared with start.mjs HEAL
      // block + postinstall.
      try {
        const pluginCacheRoot = resolve(resolveClaudeConfigDir(), "plugins", "cache");
        const pluginKey = "context-mode@context-mode";
        const firstSweep = sweepStaleMcpJson({ pluginCacheRoot, pluginKey });
        if (firstSweep && firstSweep.removed && firstSweep.removed.length > 0) {
          p.log.info(color.dim(`  Swept ${firstSweep.removed.length} stale .mcp.json file(s) from cache`));
        }
        const secondSweep = sweepStaleMcpJson({ pluginCacheRoot, pluginKey });
        if (secondSweep && Array.isArray(secondSweep.removed) && secondSweep.removed.length > 0) {
          throw new Error(
            `.mcp.json sweep drift: ${secondSweep.removed.length} file(s) still present after first pass`,
          );
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`.mcp.json sweep check failed: ${message}`);
      }

      // v1.0.X — Layer 7 heal: update user-level ~/.claude.json MCP server
      // registrations that point to old context-mode version dirs.
      // (anthropics/claude-code#59310 workaround — see heal-installed-plugins.mjs)
      try {
        // @ts-expect-error — JS module, no TS declarations
        const { healClaudeJsonMcpArgs } = await import("../scripts/heal-installed-plugins.mjs");
        const dotClaudeJson = resolve(homedir(), ".claude.json");
        const pluginCacheParent = resolve(resolveClaudeConfigDir(), "plugins", "cache", "context-mode", "context-mode");
        const result = healClaudeJsonMcpArgs({ dotClaudeJsonPath: dotClaudeJson, pluginCacheParent, newPluginRoot: pluginRoot });
        if (result.healed && result.healed.length > 0) {
          p.log.info(color.dim("  ~/.claude.json user MCP registrations updated → " + newVersion));
        }
      } catch {
        /* best effort — never block upgrade */
      }

      // v1.0.114 hotfix — marketplace post-pull assertion: clone (if
      // present) MUST be on newVersion. Mert's case showed marketplace
      // stuck at v1.0.89 — the sync block above swallowed that silently.
      // Warn (don't throw) — npm-only users have no marketplace clone.
      try {
        const marketplaceManifest = resolve(marketplaceDir, ".claude-plugin", "plugin.json");
        if (existsSync(marketplaceManifest)) {
          const mpj = JSON.parse(readFileSync(marketplaceManifest, "utf-8"));
          if (mpj?.version !== newVersion) {
            p.log.warn(
              color.yellow("Marketplace clone version mismatch") +
                ` — ${marketplaceDir} reports "${mpj?.version}" but expected "${newVersion}"`,
            );
            p.log.info(
              color.dim(`  Run manually: git -C "${marketplaceDir}" fetch --tags origin && git -C "${marketplaceDir}" reset --hard origin/HEAD`),
            );
          }
        }
      } catch { /* best effort */ }

      // Install production deps
      s.start("Installing production dependencies");
      npmExecFile(["install", "--production", "--no-audit", "--no-fund"], {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
      });
      s.stop("Dependencies ready");

      if (!isInProcessPluginPlatform(detection.platform)) {
        // Verify the selected SQLite backend, not a legacy binary/cache path.
        s.start("Verifying SQLite capabilities");
        try {
          const helperPath = resolve(pluginRoot, "scripts", "sqlite-health.mjs");
          const { checkSqliteRuntime, sqliteRemediation } = await import(
            `${pathToFileURL(helperPath).href}?upgrade=${Date.now()}`
          );
          const health = checkSqliteRuntime(pluginRoot);
          if (!health.ok) throw new Error(sqliteRemediation(health));
          s.stop(color.green("SQLite OK") + color.dim(` — ${health.backend}, FTS5 read/write verified`));
          changes.push(`SQLite verified: ${health.backend}`);
        } catch (err: unknown) {
          process.exitCode = 1;
          s.stop(color.red("SQLite verification failed"));
          p.log.error(err instanceof Error ? err.message : String(err));
        }

        // Update global npm
        s.start("Updating npm global package");
        try {
          npmExecFile(["install", "-g", pluginRoot, "--no-audit", "--no-fund"], {
            stdio: "pipe",
            timeout: 30000,
          });
          s.stop(color.green("npm global updated"));
          changes.push("Updated npm global package");
        } catch {
          s.stop(color.yellow("npm global update skipped"));
          p.log.info(color.dim("  Could not update global npm — may need sudo or standalone install"));
        }
      }

      // Cleanup
      rmSync(tmpDir, { recursive: true, force: true });

      // Sync skills to the active install path from installed_plugins.json (#228).
      // Only targets the ACTUAL directory Claude Code reads from — not spraying everywhere.
      // Issue #460 round-3: honor $CLAUDE_CONFIG_DIR so the registry lookup
      // tracks relocated CC config trees.
      try {
        const claudeRoot = resolveClaudeConfigDir();
        const registryPath = resolve(claudeRoot, "plugins", "installed_plugins.json");
        if (existsSync(registryPath)) {
          // The registry's installPath fields are written by Claude Code under
          // <claudeRoot>/plugins/cache/<marketplace>/<plugin>/<version>. Any other
          // shape means the registry has been tampered with by a co-resident
          // plugin, a malicious postinstall script, or another local actor.
          // Without containment, cpSync would happily recursive-write the in-repo
          // skills/ tree to /etc/skills, ~/.ssh/skills, or wherever the attacker
          // pointed. server.ts:790 (healCacheMidSession) already gates the same
          // field this way; the symmetric guard belongs here too.
          //
          // The lexical resolve+startsWith check rejects ".."-escapes and
          // absolute paths outside cacheRoot, but path.resolve doesn't
          // dereference symlinks. A same-uid actor who can plant a symlink
          // AT <cacheRoot>/<owner>/<plugin>/<version> targeting an attacker
          // dir gets past the lexical guard, then cpSync follows the link at
          // FS-write time. Re-check via realpathSync so a planted symlink
          // anchor fails the gate.
          const cacheRoot = resolve(claudeRoot, "plugins", "cache");
          let cacheRootCanon: string;
          try { cacheRootCanon = realpathSync(cacheRoot); }
          catch { cacheRootCanon = cacheRoot; }
          const cacheRootWithSep = cacheRootCanon + sep;
          const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
          const entries = registry?.plugins?.["context-mode@context-mode"];
          if (Array.isArray(entries)) {
            for (const entry of entries) {
              const installPath = entry?.installPath;
              if (typeof installPath !== "string" || !installPath) continue;
              if (installPath === pluginRoot) continue;
              const resolvedInstallPath = resolve(installPath);
              if (!(resolvedInstallPath + sep).startsWith(cacheRootWithSep)) continue;
              if (!existsSync(resolvedInstallPath)) continue;
              let realInstallPath: string;
              try { realInstallPath = realpathSync(resolvedInstallPath); }
              catch { continue; }
              if (!(realInstallPath + sep).startsWith(cacheRootWithSep)) continue;
              const srcSkills = resolve(srcDir, "skills");
              if (existsSync(srcSkills)) {
                cpSync(srcSkills, resolve(realInstallPath, "skills"), { recursive: true });
                changes.push(`Synced skills to active install path`);
              }
            }
          }
        }
      } catch { /* best effort — registry may not exist or be malformed */ }

      changes.push(`Updated v${localVersion} → v${newVersion}`);
      p.log.success(
        color.green("Plugin reinstalled from GitHub!") +
          color.dim(` — v${newVersion}`),
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(color.red("Update failed"));
    p.log.error(color.red("GitHub pull failed") + ` — ${message}`);

    // Issue #628 — Windows `spawnSync cmd.exe ETIMEDOUT` (and any
    // other Step 1/2 throw — network, npm, manifest mismatch) used
    // to fall through to Steps 3-7 (backup, hooks, perms, doctor),
    // all of which succeed against the OLD on-disk install. The
    // process then exited 0 and the upgrade-checklist renderer
    // marked `[x] Built and installed vNEW` while in-place files,
    // installed_plugins.json registry, and per-version cache dirs
    // stayed at vOLD. Worse: the marketplace clone synced earlier
    // in this same run is now AHEAD of cache+registry — Claude
    // Code's plugin manager keeps offering the same upgrade
    // forever (drift trap; reporter had to hand-edit
    // installed_plugins.json to escape).
    //
    // Algo defense: mark the process for non-zero exit and surface
    // an actionable recovery hint. Steps 3-7 still run because the
    // user's hooks may be broken regardless — but the overall
    // upgrade no longer reports success.
    process.exitCode = 1;
    p.log.warn(
      color.yellow("In-place files were NOT updated") +
        color.dim(" — old version is still on disk; hooks/settings will still be refreshed."),
    );
    p.log.info(
      color.dim("  Recovery: re-run /ctx-upgrade once network is stable, or run /context-mode:ctx-doctor for a full health check."),
    );

    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Step 3: Backup settings — adapter-aware
  p.log.step(`Backing up ${adapter.name} settings...`);
  const backupPath = adapter.backupSettings();
  if (backupPath?.endsWith(".bak")) {
    p.log.success(color.green("Backup created") + color.dim(" -> " + backupPath));
    changes.push("Backed up settings");
  } else if (backupPath) {
    p.log.success(color.green("Backup skipped") + color.dim(" — no changes needed"));
  } else {
    p.log.warn(
      color.yellow("No existing settings to backup") +
        " — a new one will be created",
    );
  }

  // Step 4: Configure hooks — adapter-aware
  p.log.step(`Configuring ${adapter.name} hooks...`);
  try {
    const hookChanges = adapter.configureAllHooks(pluginRoot);
    for (const change of hookChanges) {
      p.log.info(color.dim(`  ${change}`));
      changes.push(change);
    }
    p.log.success(color.green("Hooks configured") + color.dim(` — ${adapter.name}`));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Hook configuration failed: ${message}`);
  }

  // Step 5: Set hook script permissions — adapter-aware
  p.log.step("Setting hook script permissions...");
  const permSet = adapter.setHookPermissions(pluginRoot);
  // Also ensure CLI binaries are executable (tsc doesn't set +x)
  // chmod is POSIX-only — skip on Windows where execute bits are irrelevant
  if (process.platform !== "win32") {
    for (const bin of ["build/cli.js", "cli.bundle.mjs"]) {
      const binPath = resolve(pluginRoot, bin);
      try {
        accessSync(binPath, constants.F_OK);
        chmodSync(binPath, 0o755);
        permSet.push(binPath);
      } catch { /* not found — skip */ }
    }
  }
  if (permSet.length > 0) {
    p.log.success(color.green("Permissions set") + color.dim(` — ${permSet.length} hook script(s)`));
    changes.push(`Set ${permSet.length} hook scripts as executable`);
  } else {
    p.log.error(
      color.red("No hook scripts found") +
        color.dim(" — expected in " + resolve(pluginRoot, "hooks")),
    );
  }

  // Step 6: Report
  if (changes.length > 0) {
    p.note(
      changes.map((c) => color.green("  + ") + c).join("\n"),
      "Changes Applied",
    );
  } else {
    p.log.info(color.dim("No changes were needed."));
  }

  // Restart notice — new MCP tools require MCP server restart
  const restartHint = adapter.name === "Claude Code"
    ? "/reload-plugins, new terminal, or restart session"
    : "new terminal or restart session";
  p.log.warn(
    color.yellow("Restart for new MCP tools to take effect.") +
      color.dim(` (${restartHint})`),
  );

  // Step 7: Run doctor
  p.log.step("Running doctor to verify...");
  console.log();

  try {
    const cliBundlePath = resolve(pluginRoot, "cli.bundle.mjs");
    const cliBuildPath = resolve(pluginRoot, "build", "cli.js");
    const cliPath = existsSync(cliBundlePath) ? cliBundlePath : cliBuildPath;
    execFileSync("node", [cliPath, "doctor"], {
      stdio: "inherit",
      timeout: 30000,
      cwd: pluginRoot,
      env: { ...process.env, CONTEXT_MODE_PLATFORM: detection.platform },
    });
  } catch {
    p.log.warn(
      color.yellow("Doctor had warnings") +
        color.dim(` — restart your ${adapter.name} session to pick up the new version`),
    );
  }
}

export { upgrade };
