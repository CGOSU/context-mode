/** CLI upgrade implementation (Pi-only); importing this module never dispatches commands. */

import * as p from "@clack/prompts";
import color from "picocolors";
import { execFileSync } from "node:child_process";
import { readFileSync, cpSync, accessSync, existsSync, rmSync, chmodSync, lstatSync, constants } from "node:fs";
import { resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
// @ts-expect-error — JS module, no TS declarations
import { detectWindowsVsYear } from "../scripts/heal-better-sqlite3.mjs";
import { npmExecFile, getPluginRoot, getLocalVersion } from "./cli-shared.js";

async function upgrade() {
  if (process.stdout.isTTY) console.clear();

  p.intro(color.bgCyan(color.black(" context-mode upgrade (Pi) ")));

  const pluginRoot = getPluginRoot();
  const changes: string[] = [];
  const s = p.spinner();

  p.log.step("Pulling latest from GitHub...");
  const localVersion = getLocalVersion();
  const tmpDir = join(tmpdir(), `context-mode-upgrade-${Date.now()}`);

  s.start("Cloning mksglu/context-mode");
  try {
    execFileSync(
      "git",
      ["clone", "--depth", "1", "https://github.com/mksglu/context-mode.git", tmpDir],
      { stdio: "pipe", timeout: 30000 },
    );
    s.stop("Downloaded");

    const srcDir = tmpDir;
    const newPkg = JSON.parse(readFileSync(resolve(srcDir, "package.json"), "utf-8"));
    const newVersion = newPkg.version ?? "unknown";

    if (newVersion === localVersion) {
      p.log.success(color.green("Already on latest") + ` — v${localVersion}`);
      rmSync(tmpDir, { recursive: true, force: true });
    } else {
      p.log.info(`Update available: ${color.yellow("v" + localVersion)} → ${color.green("v" + newVersion)}`);

      s.start("Installing dependencies & building");
      const vsYear = detectWindowsVsYear();
      npmExecFile(["install", "--no-audit", "--no-fund"], {
        cwd: srcDir,
        stdio: "pipe",
        timeout: 120000,
        ...(vsYear ? { env: { ...process.env, npm_config_msvs_version: vsYear } } : {}),
      });
      npmExecFile(["run", "build:pi"], {
        cwd: srcDir,
        stdio: "pipe",
        timeout: 60000,
      });
      s.stop("Built successfully");

      s.start("Updating files in-place");
      const items = [...(Array.isArray(newPkg.files) ? newPkg.files : []), "src", "package.json"];
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
        if (!refuseSymlinks(from) || !existsSync(from)) continue;
        try {
          rmSync(to, { recursive: true, force: true });
          cpSync(from, to, { recursive: true, filter: refuseSymlinks });
        } catch { /* best effort */ }
      }
      s.stop(color.green("Updated files"));
      changes.push(`Upgraded v${localVersion} → v${newVersion}`);

      s.start("Installing production dependencies");
      npmExecFile(["install", "--production", "--no-audit", "--no-fund"], {
        cwd: pluginRoot,
        stdio: "pipe",
        timeout: 60000,
      });
      s.stop("Dependencies ready");

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

      rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    s.stop(color.yellow("Git clone skipped"));
    p.log.warn(color.yellow("Could not clone latest from GitHub") + ` — ${message}`);
    process.exitCode = 1;
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  if (process.platform !== "win32") {
    for (const bin of ["build/cli.js", "cli.bundle.mjs"]) {
      const binPath = resolve(pluginRoot, bin);
      try {
        accessSync(binPath, constants.F_OK);
        chmodSync(binPath, 0o755);
      } catch { /* skip */ }
    }
  }

  if (changes.length > 0) {
    p.note(changes.map((c) => color.green("  + ") + c).join("\n"), "Changes Applied");
  } else {
    p.log.info(color.dim("No changes were needed."));
  }

  p.log.warn(color.yellow("Fully restart Pi for updated bundles to take effect."));
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
    });
  } catch {
    p.log.warn(color.yellow("Doctor had warnings") + color.dim(" — restart Pi to pick up changes"));
  }
}

export { upgrade };
