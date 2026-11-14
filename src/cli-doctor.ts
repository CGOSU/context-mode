/** CLI doctor implementation (Pi-only); importing this module never dispatches commands. */

import * as p from "@clack/prompts";
import color from "picocolors";
import { detectRuntimes, getRuntimeSummary, hasBunRuntime, getAvailableLanguages } from "./runtime.js";
import {
  ensureWritableStorageDir,
  formatStorageDirectoryError,
  resolveContentStorageDir,
  resolveSessionStorageDir,
  StorageDirectoryError,
  type ResolvedStorageDir,
} from "./session/db.js";
import { PiAdapter } from "./adapters/pi/index.js";
import { getPluginRoot, getLocalVersion, fetchLatestVersion } from "./cli-shared.js";

function describeStorageSource(dir: ResolvedStorageDir): string {
  return dir.envVar ? dir.envVar : "Pi adapter default";
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

  const adapter = new PiAdapter();
  p.intro(color.bgMagenta(color.white(" context-mode doctor ")));
  p.log.info(`Platform: ${color.cyan(adapter.name)}`);

  let criticalFails = 0;

  try {
    const sessionDir = resolveSessionStorageDir(() => adapter.getSessionDir());
    const contentDir = resolveContentStorageDir(() => sessionDir.path);
    p.note(
      [
        `sessions: ${sessionDir.path} (${describeStorageSource(sessionDir)})`,
        `content:  ${contentDir.path} (${describeStorageSource(contentDir)})`,
      ].join("\n"),
      "Storage paths",
    );
    criticalFails += logStorageDir(sessionDir);
    criticalFails += logStorageDir(contentDir);
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
    p.log.warn(color.yellow("Could not detect runtimes") + color.dim(" — restart session after upgrade"));
    p.outro(color.yellow("Doctor could not fully run — try again after restarting"));
    return 1;
  }

  s.stop("Diagnostics complete");
  p.note(getRuntimeSummary(runtimes), "Runtimes");

  // Linux + Node < 22.5 + no Bun is unsafe for better-sqlite3 native .got.plt (#564)
  {
    const { hasModernSqlite } = await import("./db-base.js");
    if (process.platform === "linux" && !hasModernSqlite() && !hasBunRuntime()) {
      criticalFails++;
      p.log.error(
        color.red("Node version: FAIL") +
          ` — Linux + Node ${process.versions.node} requires Node >= 22.5 or Bun`,
      );
    }
  }

  if (hasBunRuntime()) {
    p.log.success(color.green("Performance: FAST") + " — Bun detected for JS/TS execution");
  } else {
    p.log.warn(color.yellow("Performance: NORMAL") + " — Using Node.js (install Bun for 3-5x speed boost)");
  }

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
    p.log.info(`Language coverage: ${available.length}/${total} (${pct}%)` + color.dim(` — ${available.join(", ")}`));
  }

  // Server test
  p.log.step("Testing server initialization...");
  try {
    const { PolyglotExecutor } = await import("./executor.js");
    const executor = new PolyglotExecutor({ runtimes });
    const result = await executor.execute({ language: "javascript", code: 'console.log("ok");', timeout: 5000 });
    if (result.exitCode === 0 && result.stdout.trim() === "ok") {
      p.log.success(color.green("Server test: PASS"));
    } else {
      criticalFails++;
      const detail = result.stderr?.trim() ? ` (${result.stderr.trim().slice(0, 200)})` : "";
      p.log.error(color.red("Server test: FAIL") + ` — exit ${result.exitCode}${detail}`);
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

  // Pi extension / hook model diagnostics
  p.log.step("Checking Pi integration...");
  const pluginRoot = getPluginRoot();
  for (const result of adapter.validateHooks(pluginRoot)) {
    p.log.success(color.green(`${result.check}: PASS`) + ` — ${result.message}`);
  }
  const pluginCheck = adapter.checkPluginRegistration();
  if (pluginCheck.status === "pass") {
    p.log.success(color.green("Plugin enabled: PASS") + color.dim(` — ${pluginCheck.message}`));
  } else {
    p.log.warn(color.yellow("Plugin enabled: WARN") + ` — ${pluginCheck.message}`);
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
    p.log.error(color.red("FTS5 / SQLite: FAIL") + ` — ${message}`);
  }

  // Version check
  p.log.step("Checking versions...");
  const localVersion = getLocalVersion();
  const latestVersion = await fetchLatestVersion();
  const installedVersion = adapter.getInstalledVersion();

  if (latestVersion === "unknown") {
    p.log.warn(color.yellow("Local: WARN") + ` — v${localVersion}, could not reach npm registry`);
  } else if (localVersion === latestVersion) {
    p.log.success(color.green("Local: PASS") + ` — v${localVersion}`);
  } else {
    p.log.warn(color.yellow("Local: WARN") + ` — v${localVersion}, latest v${latestVersion}`);
  }

  if (installedVersion === "not installed") {
    p.log.info(color.dim("Pi extension package.json not present in ~/.pi/extensions/context-mode (OK for local pi -e / npm install)"));
  } else {
    p.log.info(`Pi extension: v${installedVersion}`);
  }

  if (criticalFails > 0) {
    p.outro(color.red(`Diagnostics failed — ${criticalFails} critical issue(s) found`));
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
