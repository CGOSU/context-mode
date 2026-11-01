/** Read-only native health entry point and CLI toolchain detection utilities. */

import { existsSync as fsExistsSync } from "node:fs";
import { execSync } from "node:child_process";
import { checkBetterSqlite3 } from "./sqlite-health.mjs";

/**
 * Detect the installed Visual Studio year string via vswhere.exe.
 *
 * Uses the `displayName` property (e.g. "Visual Studio Community 2026")
 * and extracts the 4-digit year with a regex. This is more reliable than
 * `catalog_productLineVersion`, which returns the internal major version
 * number ("18") on VS 2026 instead of the year — making it useless as a
 * direct msvs_version value without a mapping table.
 *
 * `displayName` has consistently included the branded year across every
 * VS release (2017, 2019, 2022, 2026) and will continue to do so because
 * it is the user-visible product name Microsoft ships.
 *
 * Dependency-injected so unit tests can exercise all branches without
 * spawning a real process or requiring vswhere to be present on the host.
 *
 * Returns null on non-Windows, when vswhere is absent, or on any error.
 *
 * Timeout: 15s. Cold-disk vswhere queries on HDD-backed Windows CI runners
 * with multiple VS installs have been observed to exceed the previous 5s
 * budget (see ARCH-REVIEW #571 Part B). 15s comfortably covers slow-disk
 * scenarios without freezing /ctx-upgrade.
 *
 * Year sanity cap: the regex matches any 21st-century 4-digit year, but
 * we additionally reject anything > currentYear+5. Corrupted vswhere
 * output or a future MS rebrand could surface a bogus "2099"; passing
 * that through to `npm_config_msvs_version` would fail node-gyp
 * silently. Cap-and-null lets the caller fall back to node-gyp's own
 * detection and we log a single stderr breadcrumb for support triage.
 *
 * @param {object} [deps]
 * @param {string} [deps.platform] - process.platform override
 * @param {(p: string) => boolean} [deps.existsSync] - fs probe override
 * @param {(cmd: string, opts: object) => string} [deps.exec] - execSync override
 * @param {() => number} [deps.now] - clock override for sanity cap (test seam)
 * @returns {string | null}
 */
export function detectWindowsVsYear({
  platform = process.platform,
  existsSync = fsExistsSync,
  exec = execSync,
  now = () => new Date().getFullYear(),
} = {}) {
  if (platform !== "win32") return null;
  try {
    const vswhere =
      "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
    if (!existsSync(vswhere)) return null;
    const displayName = exec(
      `"${vswhere}" -latest -property displayName`,
      { encoding: "utf-8", stdio: "pipe", timeout: 15000 },
    ).trim();
    // "Visual Studio Community 2026" → "2026"
    const match = displayName.match(/\b(20\d{2})\b/);
    if (!match) return null;
    const year = Number(match[1]);
    const ceiling = now() + 5;
    if (year > ceiling) {
      // Fail LOUD, not silent: poisoning npm_config_msvs_version with
      // a bogus year would manifest as opaque node-gyp errors deep in
      // the rebuild. Surface a breadcrumb and return null so the caller
      // falls back to node-gyp's own version detection.
      try {
        process.stderr.write(
          `[context-mode] vswhere displayName reports VS year ${year} ` +
          `(> ${ceiling}); ignoring as likely corrupted output. ` +
          `Falling back to node-gyp default detection.\n`,
        );
      } catch { /* stderr unavailable — proceed silently */ }
      return null;
    }
    return match[1];
  } catch {
    return null;
  }
}

/**
 * Legacy entry point retained for installed callers. Health check only;
 * bundled N-API binaries must never trigger an implicit install or rebuild.
 */
export function healBetterSqlite3Binding(pkgRoot) {
  return checkBetterSqlite3(pkgRoot);
}
