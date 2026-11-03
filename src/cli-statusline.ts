/** CLI statusline implementation; importing this module never dispatches commands. */

import { readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveClaudeConfigDir } from "./util/claude-config.js";
import { getPluginRoot } from "./cli-shared.js";


/* -------------------------------------------------------
 * statusline — forward to bin/statusline.mjs
 * ------------------------------------------------------- */

function statuslineForward(): void {
  // Try multiple plugin-root candidates in priority order. After ctx-upgrade,
  // getPluginRoot() can resolve to a cache dir that sessionstart.mjs (#181)
  // already cleaned, leaving bin/statusline.mjs missing. Falling back to the
  // marketplace clone (#418-synced, stable across upgrades) and to the path
  // Claude Code itself loads from (installed_plugins.json) keeps the bar
  // alive instead of silently going blank.
  // Issue #460 round-3: marketplace + registry paths must follow
  // $CLAUDE_CONFIG_DIR so relocated CC trees still find the statusline binary.
  const claudeRoot = resolveClaudeConfigDir();
  const candidates: string[] = [
    resolve(getPluginRoot(), "bin", "statusline.mjs"),
    resolve(claudeRoot, "plugins", "marketplaces", "context-mode", "bin", "statusline.mjs"),
  ];

  // installed_plugins.json may list one or more install paths CC actually
  // loads from. Prefer those if they exist.
  try {
    const registryPath = resolve(claudeRoot, "plugins", "installed_plugins.json");
    if (existsSync(registryPath)) {
      // Same trust boundary as the cpSync site in upgrade() and as
      // server.ts:790's healCacheMidSession: only honor installPath values
      // that resolve under <claudeRoot>/plugins/cache. A stray /etc or
      // ~/.ssh entry written by another local actor must not become the
      // script the statusline forwarder imports, since statusline re-fires
      // several times per second and would hand the attacker durable RCE
      // on the user's behalf.
      //
      // path.resolve is purely lexical, so a same-uid actor who can plant
      // a symlink at <cacheRoot>/<owner>/<plugin>/<version> targeting an
      // attacker dir would pass the lexical gate. Re-check via
      // realpathSync so the dynamic-import target's actual on-disk
      // location also stays under cacheRoot.
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
          const resolvedInstallPath = resolve(installPath);
          if (!(resolvedInstallPath + sep).startsWith(cacheRootWithSep)) continue;
          let realInstallPath: string;
          try { realInstallPath = realpathSync(resolvedInstallPath); }
          catch { continue; }
          if (!(realInstallPath + sep).startsWith(cacheRootWithSep)) continue;
          candidates.push(resolve(realInstallPath, "bin", "statusline.mjs"));
        }
      }
    }
  } catch { /* registry malformed — fall through to other candidates */ }

  const scriptPath = candidates.find((c) => existsSync(c));
  if (!scriptPath) {
    // Statusline output is the user-facing status bar; stderr surfaces visibly
    // in some terminals. Exit silently — the bar simply stays empty until the
    // next /ctx-upgrade or restart resolves the path.
    process.exit(0);
  }
  // Re-exec via dynamic import so stdin/stdout are inherited cleanly.
  import(pathToFileURL(scriptPath).href).catch(() => {
    process.exit(0);
  });
}

export { statuslineForward };
