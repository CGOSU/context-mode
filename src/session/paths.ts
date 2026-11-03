/** Project/worktree identity and legacy database path migration. */

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, renameSync } from "node:fs";
import { join } from "node:path";

// ─────────────────────────────────────────────────────────
// Worktree isolation
// ─────────────────────────────────────────────────────────

/**
 * Returns the worktree suffix to append to session identifiers.
 * Returns empty string when running in the main working tree.
 *
 * Set CONTEXT_MODE_SESSION_SUFFIX to an explicit value to override
 * (useful in CI environments or when git is unavailable).
 * Set to empty string to disable isolation entirely.
 */
// Memoized per (projectDir, env override) — recomputing on every tool call cost
// ~12ms (git worktree list subprocess fork) on macOS, 50ms+ on Windows.
// Key by projectDir so callers can pass the actual workspace even when the
// MCP server has chdir'd into the installed package directory.
let _wtCache: { projectDir: string; envSuffix: string | undefined; suffix: string } | undefined;

export function normalizeWorktreePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (/^\/+$/.test(normalized)) return "/";
  if (/^[A-Za-z]:\/+$/.test(normalized)) return `${normalized.slice(0, 2)}/`;
  return normalized.replace(/\/+$/, "");
}

// Case-insensitive filesystems (macOS HFS+/APFS default, Windows NTFS default)
// can report `currentRoot` and `mainRoot` with different casing for the same
// physical directory — git itself sometimes preserves the on-disk casing while
// user-supplied paths use a different casing. Compare canonically by resolving
// symlinks via realpath and case-folding on these platforms. POSIX/Linux is
// strictly case-sensitive so this is a no-op there.
function canonicalizeForCompare(root: string): string {
  let resolved = root;
  try {
    resolved = realpathSync.native(root);
  } catch {
    // Path may not exist (test fixtures, deleted dirs); fall back to as-given.
  }
  const normalized = normalizeWorktreePath(resolved);
  if (process.platform === "win32" || process.platform === "darwin") {
    return normalized.toLowerCase();
  }
  return normalized;
}

function gitOutput(projectDir: string, args: string[]): string {
  return execFileSync(
    "git",
    ["-C", projectDir, ...args],
    {
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim();
}

function getCurrentWorktreeRoot(projectDir: string): string | null {
  const root = gitOutput(projectDir, ["rev-parse", "--show-toplevel"]);
  return root.length > 0 ? normalizeWorktreePath(root) : null;
}

function getMainWorktreeRoot(projectDir: string): string | null {
  const root = gitOutput(projectDir, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.replace("worktree ", "")
    ?.trim();
  return root ? normalizeWorktreePath(root) : null;
}

export function getWorktreeSuffix(projectDir = process.cwd()): string {
  const envSuffix = process.env.CONTEXT_MODE_SESSION_SUFFIX;
  if (_wtCache && _wtCache.projectDir === projectDir && _wtCache.envSuffix === envSuffix) {
    return _wtCache.suffix;
  }

  let suffix = "";
  if (envSuffix !== undefined) {
    suffix = envSuffix ? `__${envSuffix}` : "";
  } else {
    try {
      const currentRoot = getCurrentWorktreeRoot(projectDir);
      const mainRoot = getMainWorktreeRoot(projectDir);
      if (currentRoot && mainRoot) {
        // Use the canonicalized currentRoot for BOTH the comparison and the
        // hash so the suffix DB filename stays stable across casing-variant
        // calls on the same machine (round-5 finding). Previously the hash
        // ate raw casing, so the same linked worktree could land at two
        // different `__<8-hex>` files depending on which casing the caller
        // passed in.
        const canonicalCurrent = canonicalizeForCompare(currentRoot);
        const canonicalMain = canonicalizeForCompare(mainRoot);
        if (canonicalCurrent !== canonicalMain) {
          suffix = `__${createHash("sha256").update(canonicalCurrent).digest("hex").slice(0, 8)}`;
        }
      }
    } catch {
      // git not available or not a git repo — no suffix
    }
  }

  _wtCache = { projectDir, envSuffix, suffix };
  return suffix;
}

// Test-only helper: clear the memoization between cases.
export function _resetWorktreeSuffixCacheForTests(): void {
  _wtCache = undefined;
}

// ─────────────────────────────────────────────────────────
// SessionDB path resolution + case-fold migration
// ─────────────────────────────────────────────────────────

/**
 * Hash a project directory the way the deployed code (≤ v1.0.111) did:
 * normalize slashes only, preserve raw casing. Kept exported so the
 * migration helper can locate pre-fix DB files for one-shot rename.
 *
 * Do NOT call this for new code paths — use {@link hashProjectDirCanonical}.
 */
export function hashProjectDirLegacy(projectDir: string): string {
  return createHash("sha256")
    .update(normalizeWorktreePath(projectDir))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Hash a project directory case-stably. On case-insensitive filesystems
 * (macOS HFS+/APFS, Windows NTFS) the path is lowercased so that
 * `/Users/Mert/proj` and `/users/mert/proj` resolve to the same DB file.
 * On Linux (case-sensitive) casing is preserved.
 *
 * Used as the base half of the SessionDB filename:
 *   <baseHash><worktreeSuffix>.db
 */
export function hashProjectDirCanonical(projectDir: string): string {
  const normalized = normalizeWorktreePath(projectDir);
  const folded = (process.platform === "darwin" || process.platform === "win32")
    ? normalized.toLowerCase()
    : normalized;
  return createHash("sha256").update(folded).digest("hex").slice(0, 16);
}

/**
 * Resolve the per-project FTS5 content store DB path, performing a one-shot
 * migration from a legacy raw-casing filename to the canonical one when only
 * the legacy file (with optional `-wal` / `-shm` SQLite sidecars) exists.
 *
 * Same dual-hash safety contract as {@link resolveSessionDbPath}:
 *   - Linux: canonical hash equals legacy hash → no migration attempted.
 *   - Mac/Win: rename legacy → canonical when canonical missing.
 *   - Both exist: leave legacy alone (data-loss safety). Caller picks
 *     canonical; reconciliation is a manual operation.
 *
 * Differs from `resolveSessionDbPath` in two ways:
 *   1. No worktree suffix — the FTS5 store is per-project, not per-worktree.
 *   2. The `-wal` / `-shm` sidecars travel with the main `.db` during
 *      migration so an active SQLite WAL checkpoint is not stranded behind.
 */
export function resolveContentStorePath(opts: {
  projectDir: string;
  contentDir: string;
}): string {
  const { projectDir, contentDir } = opts;
  const canonicalHash = hashProjectDirCanonical(projectDir);
  const canonicalPath = join(contentDir, `${canonicalHash}.db`);
  if (existsSync(canonicalPath)) return canonicalPath;

  const legacyHash = hashProjectDirLegacy(projectDir);
  if (legacyHash === canonicalHash) return canonicalPath; // Linux short-circuit

  const legacyPath = join(contentDir, `${legacyHash}.db`);
  if (existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, canonicalPath);
      // Travel the SQLite sidecars too so an active WAL is not orphaned.
      for (const suffix of ["-wal", "-shm"]) {
        try { renameSync(legacyPath + suffix, canonicalPath + suffix); } catch { /* sidecar may not exist */ }
      }
    } catch {
      // Race or permission issue — caller will create canonicalPath fresh.
    }
  }
  return canonicalPath;
}

/**
 * Resolve the SessionDB file path for a project, performing a one-shot
 * migration from legacy raw-casing filenames to canonical ones when only
 * the legacy file exists.
 *
 * Migration rules:
 *   - Linux: `legacyHash === canonicalHash` so the resolver short-circuits;
 *     no migration ever runs (case-sensitive FS, never any drift).
 *   - macOS / Windows: if the canonical path does not exist but a legacy
 *     path does, rename in place. This preserves the user's session
 *     history across the casing-fix upgrade.
 *   - When BOTH paths exist (rare — usually only if the user previously
 *     ran two terminals with different casing) the legacy file is left
 *     UNTOUCHED. The canonical path wins; manual reconciliation needed.
 *     Avoiding the rename here is the data-loss safety guarantee.
 *
 * Worktree separation is preserved: each call only ever migrates the ONE
 * legacy file matching THIS projectDir's hash. Different worktrees have
 * different physical paths → different hashes → different DB files; the
 * migration cannot collapse worktrees.
 */
export function resolveSessionDbPath(opts: {
  projectDir: string;
  sessionsDir: string;
}): string {
  return resolveSessionPath({ ...opts, ext: ".db" });
}

/**
 * Generalized resolver: same case-fold + one-shot legacy-rename semantics
 * as {@link resolveSessionDbPath}, parameterised on the file extension so
 * the SAME logic powers `.db`, `-events.md`, and `.cleanup` paths.
 *
 * Source of truth for hooks: `hooks/session-helpers.mjs` imports this
 * function from the bundled output (`hooks/session-db.bundle.mjs`) so the
 * JS hooks and the TS server can never drift again on hash, suffix, or
 * migration policy.
 *
 * Optional `suffix` lets the hook layer inject its cross-process cached
 * worktree suffix (the marker-file optimisation that amortises the
 * `git worktree list` cost across hook forks). When omitted, falls back
 * to {@link getWorktreeSuffix} which uses an in-process cache only.
 */
export function resolveSessionPath(opts: {
  projectDir: string;
  sessionsDir: string;
  ext: string;
  suffix?: string;
}): string {
  const { projectDir, sessionsDir, ext } = opts;
  const suffix = opts.suffix ?? getWorktreeSuffix(projectDir);
  const canonicalHash = hashProjectDirCanonical(projectDir);
  const canonicalPath = join(sessionsDir, `${canonicalHash}${suffix}${ext}`);

  if (existsSync(canonicalPath)) return canonicalPath;

  const legacyHash = hashProjectDirLegacy(projectDir);
  if (legacyHash === canonicalHash) return canonicalPath; // Linux or already canonical

  const legacyPath = join(sessionsDir, `${legacyHash}${suffix}${ext}`);
  if (existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, canonicalPath);
    } catch {
      // Race or permission issue — caller will create canonicalPath on first
      // write. Better to lose this rename than to throw and break ctx_stats.
    }
  }
  return canonicalPath;
}
