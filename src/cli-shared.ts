/** CLI shared implementation; importing this module never dispatches commands. */



import { execFileSync, execSync, execFile as nodeExecFile, type ExecSyncOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// ── Adapter imports ──────────────────────────────────────
import { detectPlatform } from "./adapters/detect.js";
import { isInProcessPluginPlatform } from "./adapters/types.js";

// Private 16-LOC copy of browserOpenArgv. Canonical version lives in src/server.ts;
// duplicated here so the cli bundle does not pull server.ts top-level boot side effects.
// Keep in sync — pure data, no I/O.
function browserOpenArgv(
  url: string,
  platform: NodeJS.Platform,
): readonly { cmd: string; args: readonly string[] }[] {
  if (platform === "darwin") return [{ cmd: "open", args: [url] }];
  if (platform === "win32") {
    return [{ cmd: "cmd", args: ["/c", "start", "", url] }];
  }
  return [
    { cmd: "xdg-open", args: [url] },
    { cmd: "sensible-browser", args: [url] },
  ];
}

/* -------------------------------------------------------
 * Shared helpers
 * ------------------------------------------------------- */

/** Normalize Windows backslash paths to forward slashes for Bash (MSYS2) compatibility. */
export function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * Windows-safe npm execution. On Windows:
 * - "npm" → "npm.cmd" (Node won't resolve via PATHEXT in execFile)
 * - shell: true required (Node v20+ CVE-2024-27980 mitigation)
 * See: https://github.com/mksglu/context-mode/issues/344
 */
const isWin = process.platform === "win32";

export function npmExecFile(args: string[], opts: Record<string, unknown> = {}): void {
  execFileSync(isWin ? "npm.cmd" : "npm", args, {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  });
}

export function npmExec(command: string, opts: Record<string, unknown> = {}): void {
  // Issue #511: use top-level static import (line 17) — never inline `require("node:...")`
  // in ESM-bundled sources. esbuild rewrites them to a `__require` shim that throws
  // `Dynamic require of "node:child_process" is not supported` under Node ESM/Bun.
  // Cast preserves the prior `require()`-as-`any` shape; `shell: true` is the documented
  // Node behavior even though @types/node typed `shell` as `string | undefined`.
  const execOpts = {
    ...opts,
    ...(isWin ? { shell: true } : {}),
  } as unknown as ExecSyncOptions;
  execSync(isWin ? command.replace(/^npm /, "npm.cmd ") : command, execOpts);
}

/**
 * Open a URL in the user's default browser without invoking a shell.
 *
 * Uses `execFile` with an arg array so the URL cannot be interpreted as
 * shell metacharacters.  Original code used `execSync(`open "${url}"`)`
 * which would shell-interpolate the URL — fragile if the URL ever
 * becomes attacker-controlled (remote, weak port-validation, etc).
 *
 * Best-effort: if the OS opener is missing the function logs a copyable
 * URL hint and returns; it never throws.  `runner` is injectable for
 * tests; default is `child_process.execFile` (callback form, fire-and-
 * forget).
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  opts?: Record<string, unknown>,
) => unknown;

export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  runner: ExecFileFn = nodeExecFile as unknown as ExecFileFn,
): void {
  const opts = { stdio: "ignore" as const };
  const hint = () =>
    console.error(`\nCould not auto-open browser. Open manually: ${url}`);

  // Platform→argv mapping is canonical in src/server.ts; mirrored privately
  // above to avoid pulling server boot side effects into the cli bundle.
  const attempts = browserOpenArgv(url, platform);
  let opened = false;
  for (const { cmd, args } of attempts) {
    try {
      runner(cmd, args as string[], opts);
      opened = true;
      break;
    } catch { /* try next fallback */ }
  }
  if (!opened) hint();
}

function defaultPluginRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // build/cli.js or src/cli.ts → go up one level; cli.bundle.mjs at project root → stay here
  if (__dirname.endsWith("/build") || __dirname.endsWith("\\build") ||
      __dirname.endsWith("/src") || __dirname.endsWith("\\src")) {
    return resolve(__dirname, "..");
  }
  return __dirname;
}

// Opencode/Kilocode install plugins from npm into a per-package cache folder.
// Layout (changed silently in late 2024 — see PR #376 / KiloCode#9503):
//   POSIX  : ~/.cache/<platform>/packages/context-mode@latest/node_modules/context-mode
//   Windows: %LOCALAPPDATA%\<platform>\packages\context-mode@latest\node_modules\context-mode
function cachePluginRoot(platform: string): string {
  const subPath = ["packages", "context-mode@latest", "node_modules", "context-mode"];
  if (process.platform === "win32") {
    const localApp = process.env.LOCALAPPDATA;
    if (localApp) return resolve(localApp, platform, ...subPath);
    return resolve(homedir(), "AppData", "Local", platform, ...subPath);
  }
  return resolve(homedir(), ".cache", platform, ...subPath);
}

function getPluginRoot(): string {
  const platform = detectPlatform().platform;
  if (isInProcessPluginPlatform(platform)) {
    return cachePluginRoot(platform);
  }
  return defaultPluginRoot();
}

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(getPluginRoot(), "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function fetchLatestVersion(): Promise<string> {
  // Use node:https instead of global fetch to avoid a Windows libuv assertion
  // (UV_HANDLE_CLOSING) caused by undici's connection-pool background threads
  // racing with process.exit() teardown on Node.js v24+.
  return new Promise((resolve) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer) => { raw += chunk; });
        res.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            resolve(data.version ?? "unknown");
          } catch {
            resolve("unknown");
          }
        });
      },
    );
    req.on("error", () => resolve("unknown"));
    req.setTimeout(5000, () => { req.destroy(); resolve("unknown"); });
    req.end();
  });
}

export { getPluginRoot, getLocalVersion, fetchLatestVersion };
