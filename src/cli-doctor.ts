/** CLI doctor implementation; importing this module never dispatches commands. */


import * as p from "@clack/prompts";
import color from "picocolors";
import { readFileSync, accessSync, existsSync, readdirSync, constants } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { detectRuntimes, getRuntimeSummary, hasBunRuntime, getAvailableLanguages } from "./runtime.js";
import { getHookScriptPaths } from "./util/hook-config.js";
import { ensureWritableStorageDir, formatStorageDirectoryError, resolveContentStorageDir, resolveSessionStorageDir, resolveStatsStorageDir, StorageDirectoryError, type ResolvedStorageDir } from "./session/db.js";
// ── Adapter imports ──────────────────────────────────────
import { detectPlatform, getAdapter } from "./adapters/detect.js";
import { getPluginRoot, getLocalVersion, fetchLatestVersion } from "./cli-shared.js";


/* -------------------------------------------------------
 * Doctor — adapter-aware diagnostics
 * ------------------------------------------------------- */

function describeStorageSource(dir: ResolvedStorageDir): string {
  return dir.envVar ? dir.envVar : "adapter default";
}

function logStorageDir(dir: ResolvedStorageDir): number {
  try {
    ensureWritableStorageDir(dir);
    p.log.success(
      color.green(`Storage ${dir.kind}: PASS`) +
        color.dim(` — ${dir.path} (${describeStorageSource(dir)})`),
    );
    return 0;
  } catch (err) {
    if (err instanceof StorageDirectoryError) {
      p.log.error(
        color.red(`Storage ${dir.kind}: FAIL`) +
          color.dim(` — ${formatStorageDirectoryError(err)}`),
      );
      return 1;
    }
    throw err;
  }
}

async function doctor(): Promise<number> {
  if (process.stdout.isTTY) console.clear();

  // Detect platform
  const detection = detectPlatform();
  const adapter = await getAdapter(detection.platform);

  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
  p.log.info(
    `Platform: ${color.cyan(adapter.name)}` +
      color.dim(` (${detection.confidence} confidence — ${detection.reason})`),
  );

  let criticalFails = 0;

  try {
    const sessionDir = resolveSessionStorageDir(() => adapter.getSessionDir());
    const contentDir = resolveContentStorageDir(() => sessionDir.path);
    const statsDir = resolveStatsStorageDir(() => sessionDir.path);

    p.note(
      [
        `sessions: ${sessionDir.path} (${describeStorageSource(sessionDir)})`,
        `content:  ${contentDir.path} (${describeStorageSource(contentDir)})`,
        `stats:    ${statsDir.path} (${describeStorageSource(statsDir)})`,
      ].join("\n"),
      "Storage paths",
    );
    criticalFails += logStorageDir(sessionDir);
    criticalFails += logStorageDir(contentDir);
    criticalFails += logStorageDir(statsDir);
  } catch (err) {
    if (err instanceof StorageDirectoryError) {
      criticalFails++;
      p.log.error(
        color.red(`Storage ${err.kind}: FAIL`) +
          color.dim(` — ${formatStorageDirectoryError(err)}`),
      );
    } else {
      throw err;
    }
  }

  const s = p.spinner();
  s.start("Running diagnostics");

  let runtimes: ReturnType<typeof detectRuntimes>;
  let available: string[];
  try {
    runtimes = detectRuntimes();
    available = getAvailableLanguages(runtimes);
  } catch {
    s.stop("Diagnostics partial");
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — module may be missing, restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return 1;
  }

  s.stop("Diagnostics complete");

  // Runtime check
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // ── Issue #564 — Linux + Node < 22.5 + no Bun is unsafe ────────────
  // V8's madvise(MADV_DONTNEED) can corrupt better-sqlite3's native addon
  // `.got.plt` on Linux, causing sporadic SIGSEGV (1-4/hour). The 22.5
  // gate (`hasModernSqlite()` in src/db-base.ts:226-244) is the contract:
  // at or above it we use node:sqlite (built-in, no native addon, no
  // .got.plt to corrupt); below it we fall through to better-sqlite3
  // which WILL crash. engines.node + a hard-fail postinstall guard this
  // at install time, but doctor() surfaces it for already-installed users
  // (and for adapters whose MCP host swallows stderr during install).
  // Refs:
  //   - https://github.com/nodejs/node/issues/62515
  //   - https://github.com/mksglu/context-mode/issues/564
  {
    const { hasModernSqlite } = await import("./db-base.js");
    if (
      process.platform === "linux" &&
      !hasModernSqlite() &&
      !hasBunRuntime()
    ) {
      criticalFails++;
      p.log.error(
        color.red("Node version: FAIL") +
          ` — Linux + Node ${process.versions.node} is unsafe (SIGSEGV)` +
          color.dim(
            "\n  context-mode requires Node.js >= 22.5 (or Bun) on Linux to avoid the" +
            "\n  V8 madvise(MADV_DONTNEED) SIGSEGV in better-sqlite3 (1-4/hour)." +
            "\n  Refs: https://github.com/nodejs/node/issues/62515" +
            "\n        https://github.com/mksglu/context-mode/issues/564" +
            "\n  Fix:  nvm install 22.5 && nvm use 22.5 && npm install -g context-mode" +
            "\n  Or:   curl -fsSL https://bun.sh/install | bash && bun add -g context-mode",
          ),
      );
    }
  }

  // Speed tier
  if (hasBunRuntime()) {
    p.log.success(
      color.green("Performance: FAST") +
        " — Bun detected for JS/TS execution",
    );
  } else {
    p.log.warn(
      color.yellow("Performance: NORMAL") +
        " — Using Node.js (install Bun for 3-5x speed boost)",
    );
  }

  // Language coverage
  const total = 11;
  const pct = ((available.length / total) * 100).toFixed(0);
  if (available.length < 2) {
    criticalFails++;
    p.log.error(
      color.red(`Language coverage: ${available.length}/${total} (${pct}%)`) +
        " — too few runtimes detected" +
        color.dim(` — ${available.join(", ") || "none"}`),
    );
  } else {
    p.log.info(
      `Language coverage: ${available.length}/${total} (${pct}%)` +
        color.dim(` — ${available.join(", ")}`),
    );
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({
      language: "javascript",
      code: 'console.log("ok");',
      timeout: 5000,
    });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
      p.log.error(
        color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`,
      );
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("Cannot find module") || message.includes("MODULE_NOT_FOUND")) {
      p.log.warn(color.yellow("Server test: SKIP") + color.dim(" — module not available (restart session after upgrade)"));
    } else {
      criticalFails++;
      p.log.error(color.red("Server test: FAIL") + ` — ${message}`);
    }
  }

  // Hooks — adapter-aware validation
  p.log.step(`Checking ${adapter.name} hooks configuration...`);
  const pluginRoot = getPluginRoot();
  const hookResults = adapter.validateHooks(pluginRoot);

  for (const result of hookResults) {
    if (result.status === "pass") {
      p.log.success(color.green(`${result.check}: PASS`) + ` — ${result.message}`);
    } else if (result.status === "warn") {
      p.log.warn(
        color.yellow(`${result.check}: WARN`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    } else {
      p.log.error(
        color.red(`${result.check}: FAIL`) +
          ` — ${result.message}` +
          (result.fix ? color.dim(`\n  Run: ${result.fix}`) : ""),
      );
    }
  }

  // Hook scripts exist — Algo-D1 protocol path takes precedence.
  // Adapters that override `getHealthChecks` (claude-code today) get a
  // direct `existsSync(join(pluginRoot, "hooks", scriptName))` per
  // HOOK_SCRIPTS entry — no regex round-trip on a hook command, so the
  // #548 doubled-path FAIL class can't surface. Adapters that don't
  // override fall through to the legacy `getHookScriptPaths` flow which
  // generates the hook config and parses each command via
  // `extractHookScriptPath`. Post-D3 every adapter emits buildNodeCommand-
  // shape, so the legacy flow is also safe — but the direct existsSync
  // path is strictly preferable when the adapter offers it.
  p.log.step("Checking hook scripts...");
  const adapterHealthChecks = adapter.getHealthChecks?.(pluginRoot) ?? [];
  if (adapterHealthChecks.length > 0) {
    for (const hc of adapterHealthChecks) {
      const result = hc.check();
      if (result.status === "OK") {
        p.log.success(
          color.green(`${hc.name}: PASS`) +
            (result.detail ? color.dim(` — ${result.detail}`) : ""),
        );
      } else {
        p.log.error(
          color.red(`${hc.name}: FAIL`) +
            (result.detail ? color.dim(` — ${result.detail}`) : ""),
        );
      }
    }
  } else {
    const hookScriptPaths = getHookScriptPaths(adapter, pluginRoot);
    if (hookScriptPaths.length === 0) {
      p.log.success(color.green("Hook scripts: PASS") + color.dim(" — no direct .mjs script paths to verify"));
    } else {
      for (const scriptPath of hookScriptPaths) {
        const absolutePath = resolve(pluginRoot, scriptPath);
        try {
          accessSync(absolutePath, constants.R_OK);
          p.log.success(color.green("Hook script exists: PASS") + color.dim(` — ${absolutePath}`));
        } catch {
          p.log.error(
            color.red("Hook script exists: FAIL") +
              color.dim(` — not found at ${absolutePath}`),
          );
        }
      }
    }
  }

  // Plugin registration — adapter-aware
  p.log.step(`Checking ${adapter.name} plugin registration...`);
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.message}`));
  } else {
    p.log.warn(
      color.yellow("Plugin enabled: WARN") +
        ` — ${pluginCheck.message}`,
    );
  }

  // ── Issue #613 — proactive Tier C absolute-path detection ───────────
  // PR #620 fixed `buildHookCommand` for vscode-copilot + jetbrains-copilot
  // so future writes are CLI-dispatcher-shape. But users who ran
  // /ctx-upgrade on v1.0.136 or earlier are still carrying poisoned
  // committable files in their workspace:
  //   - `.github/hooks/context-mode.json`      (vscode-copilot, team-shared)
  //   - `.jetbrains/copilot/hooks.json`        (jetbrains-copilot, team-shared)
  //   - `.cursor/hooks.json`                   (cursor, team-shared)
  // Per ISSUE-613-VERDICT §6.1 these are Tier C — workspace-committed
  // cross-machine config. Doctor scans them for absolute paths and
  // fnm_multishells shims; if found, FAIL with `ctx_upgrade` remediation.
  // Per ISSUE-604-VERDICT §11 ("silent-green doctor while hooks are dead
  // is itself a P0 trust bug") — surface poison BEFORE the user hits a
  // runtime failure.
  p.log.step("Checking team-shared hook configs in your workspace...");
  {
    const projectDir = process.cwd();
    const tierCFiles = [
      ".github/hooks/context-mode.json",
      ".cursor/hooks.json",
      ".jetbrains/copilot/hooks.json",
    ];
    let tierCFails = 0;
    let tierCChecked = 0;

    // Detect absolute-path patterns that should never appear in a
    // workspace-committed config. Per Mert's standing Windows-safety rule:
    // handle both `/` and `\\` separators.
    function isAbsoluteOrShimPath(s: string): boolean {
      // unix absolute
      if (s.startsWith("/")) return true;
      // Windows drive-letter absolute (e.g. C:/, C:\)
      if (/^[A-Za-z]:[/\\]/.test(s)) return true;
      // Windows UNC or escaped-backslash absolute fragments
      if (s.includes("\\\\")) return true;
      // fnm shim hint — issue #613 reporter's exact stderr shape
      if (s.includes("fnm_multishells")) return true;
      // process.execPath literal baked into JSON
      if (s.includes("process.execPath")) return true;
      return false;
    }

    function recurseStrings(node: unknown, hit: (s: string) => void): void {
      if (typeof node === "string") {
        hit(node);
      } else if (Array.isArray(node)) {
        for (const item of node) recurseStrings(item, hit);
      } else if (node && typeof node === "object") {
        for (const v of Object.values(node)) recurseStrings(v, hit);
      }
    }

    for (const rel of tierCFiles) {
      const abs = resolve(projectDir, rel);
      if (!existsSync(abs)) continue; // missing config → SKIP, no false fail
      tierCChecked++;
      try {
        const parsed = JSON.parse(readFileSync(abs, "utf-8"));
        const offenders: string[] = [];
        recurseStrings(parsed, (s) => {
          if (isAbsoluteOrShimPath(s)) offenders.push(s);
        });
        if (offenders.length > 0) {
          criticalFails++;
          tierCFails++;
          // Truncate to one example to keep output readable; show count.
          const example = offenders[0].length > 100
            ? offenders[0].slice(0, 97) + "..."
            : offenders[0];
          p.log.error(
            color.red(`Hook config: FAIL`) +
              ` — ${rel} has your machine's local paths baked in` +
              color.dim(
                "\n  This file is committed to git, so teammates and CI will get your path and the hooks will break for them." +
                `\n  Found ${offenders.length} hard-coded path(s), e.g.: ${example}` +
                "\n  Fix: run /context-mode:ctx-upgrade — it rewrites the file to a portable form that works on every machine." +
                "\n  Details: https://github.com/mksglu/context-mode/issues/613",
              ),
          );
        } else {
          p.log.success(
            color.green("Hook config: PASS") +
              color.dim(` — ${rel} is portable (no hard-coded paths)`),
          );
        }
      } catch (err: unknown) {
        // Malformed JSON should not crash doctor; warn and move on.
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(
          color.yellow(`Hook config: WARN`) +
            ` — ${rel} is not valid JSON` +
            color.dim(
              "\n  Doctor cannot scan it for portability issues until the file parses." +
              "\n  Fix: open the file and check it in a JSON validator, or delete it and run /context-mode:ctx-upgrade to regenerate." +
              `\n  Parser said: ${msg.slice(0, 160)}`,
            ),
        );
      }
    }
    if (tierCChecked === 0) {
      p.log.info(
        color.dim("Hook config: SKIP — no team-shared hook configs found in this workspace"),
      );
    } else if (tierCFails === 0) {
      // already individual PASS messages above; no need for a summary
    }
  }

  // ── Issue #609 — proactive stale `.mcp.json` detection ──────────────
  // PR #620 deleted the per-version cache `.mcp.json` write from cli.ts
  // and shipped `sweepStaleMcpJson` to clean up any pre-existing copies.
  // But users on the field may still have stale `.mcp.json` files left
  // by /ctx-upgrade flows that ran before PR #620 (or by Claude Code's
  // native auto-update copying a poisoned file forward). Surface those
  // as WARN (recoverable — next ctx_upgrade sweeps them) so the user
  // knows what to do instead of being told everything is green while
  // the file lingers on disk.
  // Per ISSUE-604-VERDICT §11 same trust contract as Tier C check above.
  p.log.step("Checking for leftover .mcp.json files from older versions...");
  {
    const cacheRoot = join(
      homedir(),
      ".claude",
      "plugins",
      "cache",
      "context-mode",
      "context-mode",
    );
    if (!existsSync(cacheRoot)) {
      p.log.info(
        color.dim("Leftover .mcp.json check: SKIP — no plugin cache exists yet (Claude Code has not installed context-mode here)"),
      );
    } else {
      let staleCount = 0;
      const staleVersions: string[] = [];
      try {
        const versionDirs = readdirSync(cacheRoot);
        for (const v of versionDirs) {
          const candidate = join(cacheRoot, v, ".mcp.json");
          if (existsSync(candidate)) {
            staleCount++;
            if (staleVersions.length < 5) staleVersions.push(v);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        p.log.warn(
          color.yellow("Leftover .mcp.json check: WARN") +
            ` — could not read the plugin cache directory` +
            color.dim(
              `\n  Path: ${cacheRoot}` +
              `\n  Reason: ${msg.slice(0, 160)}` +
              "\n  Fix: check that the directory is readable, then re-run doctor. If the issue persists, run /context-mode:ctx-upgrade.",
            ),
        );
        staleCount = 0;
      }
      if (staleCount === 0) {
        p.log.success(
          color.green("Leftover .mcp.json check: PASS") +
            color.dim(" — no old .mcp.json files in the plugin cache"),
        );
      } else {
        // WARN, not FAIL — per architect spec this is recoverable.
        p.log.warn(
          color.yellow("Leftover .mcp.json check: WARN") +
            ` — found ${staleCount} old .mcp.json file(s) left over from previous context-mode versions` +
            color.dim(
              "\n  These are harmless but should be cleaned up so they cannot confuse Claude Code after an auto-update." +
              `\n  Versions affected: ${staleVersions.join(", ")}${staleCount > staleVersions.length ? ", ..." : ""}` +
              "\n  Fix: run /context-mode:ctx-upgrade — it sweeps these files automatically on the next run." +
              "\n  Details: https://github.com/mksglu/context-mode/issues/609",
            ),
        );
      }
    }
  }

  // FTS5 / SQLite
  p.log.step("Checking FTS5 / SQLite...");
  try {
    const Database = (await import("./db-base.js")).loadDatabase();
    const db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE fts_test USING fts5(content)");
    db.exec("INSERT INTO fts_test(content) VALUES ('hello world')");
    const row = db.prepare("SELECT * FROM fts_test WHERE fts_test MATCH 'hello'").get() as { content: string } | undefined;
    db.close();
    if (row && row.content === "hello world") {
      p.log.success(color.green("FTS5 / SQLite: PASS") + " — native module works");
    } else {
      criticalFails++;
      p.log.error(color.red("FTS5 / SQLite: FAIL") + " — query returned unexpected result");
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    criticalFails++;
    p.log.error(
      color.red("FTS5 / SQLite: FAIL") + ` — ${message}` +
        color.dim("\n  Reinstall context-mode's declared dependencies on a supported Node/platform, then restart."),
    );
  }

  // Version check — adapter-aware
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, could not reach npm registry`,
    );
  } else if (localVersion === latestVersion) {
    p.log.success(
      color.green("npm (MCP): PASS") +
        ` — v${localVersion}`,
    );
  } else {
    p.log.warn(
      color.yellow("npm (MCP): WARN") +
        ` — local v${localVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  }

  if (installedVersion === "standalone") {
    p.log.info(
      color.dim(`${adapter.name}: standalone MCP mode`) +
        " — no platform plugin version to compare",
    );
  } else if (installedVersion === "not installed") {
    p.log.info(
      color.dim(`${adapter.name}: not installed`) +
        " — using standalone MCP mode",
    );
  } else if (latestVersion !== "unknown" && installedVersion === latestVersion) {
    p.log.success(
      color.green(`${adapter.name}: PASS`) +
        ` — v${installedVersion}`,
    );
  } else if (latestVersion !== "unknown") {
    p.log.warn(
      color.yellow(`${adapter.name}: WARN`) +
        ` — v${installedVersion}, latest v${latestVersion}` +
        color.dim("\n  Run: /context-mode:ctx-upgrade"),
    );
  } else {
    p.log.info(
      `${adapter.name}: v${installedVersion}` +
        color.dim(" — could not verify against npm registry"),
    );
  }

  // Summary
  if (criticalFails > 0) {
    p.outro(
      color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`),
    );
    return 1;
  }

  p.outro(
    available.length >= 4
      ? color.green("Diagnostics complete!")
      : color.yellow("Some checks need attention — see above for details"),
  );
  return 0;
}

export { doctor };
