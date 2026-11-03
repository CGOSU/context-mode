/** Storage directory configuration and writable-directory validation. */

import { accessSync, constants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// ─────────────────────────────────────────────────────────
// Storage root resolution
// ─────────────────────────────────────────────────────────
//
// Re-exported by db.ts for the packaged hooks/session-db.bundle.mjs bridge.

const STORAGE_ROOT_ENV = "CONTEXT_MODE_DIR" as const;
const STORAGE_SESSIONS_SUBDIR = "sessions";
const STORAGE_CONTENT_SUBDIR = "content";

export type StorageDirectoryKind = "session" | "content" | "stats";
export type StorageOverrideEnvVar = typeof STORAGE_ROOT_ENV;
export type StorageDirectorySource = "default" | "override";
export type IgnoredStorageOverrideReason = "empty";

export interface ResolvedStorageDir {
  kind: StorageDirectoryKind;
  path: string;
  envVar: StorageOverrideEnvVar | null;
  source: StorageDirectorySource;
  ignoredEnvVar?: StorageOverrideEnvVar;
  ignoredReason?: IgnoredStorageOverrideReason;
}

export class StorageDirectoryError extends Error {
  readonly kind: StorageDirectoryKind;
  readonly path: string;
  readonly overrideEnvVar: StorageOverrideEnvVar;
  readonly ignoredEnvVar?: StorageOverrideEnvVar;
  readonly ignoredReason?: IgnoredStorageOverrideReason;

  constructor(
    kind: StorageDirectoryKind,
    path: string,
    overrideEnvVar: StorageOverrideEnvVar = STORAGE_ROOT_ENV,
    cause?: unknown,
    message?: string,
    metadata: Pick<ResolvedStorageDir, "ignoredEnvVar" | "ignoredReason"> = {},
  ) {
    super(message ?? storageDirectoryErrorMessage(kind, path, metadata), { cause });
    this.name = "StorageDirectoryError";
    this.kind = kind;
    this.path = path;
    this.overrideEnvVar = overrideEnvVar;
    this.ignoredEnvVar = metadata.ignoredEnvVar;
    this.ignoredReason = metadata.ignoredReason;
  }
}

type OverrideRoot =
  | { kind: "unset" }
  | { kind: "ignored-empty"; ignoredEnvVar: StorageOverrideEnvVar; ignoredReason: IgnoredStorageOverrideReason }
  | { kind: "override"; root: string };

const writableStorageCache = new Map<string, string | StorageDirectoryError>();

export interface DefaultSessionDirOptions {
  configDir: string;
  configDirEnv?: string;
  legacySessionDirEnv?: string;
  onLegacySessionDir?: (envVar: string, dir: string) => void;
  env?: NodeJS.ProcessEnv;
}

export function resolveDefaultSessionDir(opts: DefaultSessionDirOptions): string {
  const env = opts.env ?? process.env;
  const legacyEnvVar = opts.legacySessionDirEnv;
  const legacy = legacyEnvVar ? env[legacyEnvVar]?.trim() : undefined;
  if (legacy && legacyEnvVar) {
    opts.onLegacySessionDir?.(legacyEnvVar, legacy);
    return legacy;
  }

  return join(resolveConfigDirForDefaultSession(opts.configDir, opts.configDirEnv, env), "context-mode", "sessions");
}

function resolveConfigDirForDefaultSession(
  configDir: string,
  configDirEnv: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const envValue = configDirEnv ? env[configDirEnv] : undefined;
  if (envValue && envValue.trim() !== "") {
    return resolveConfigDirValue(envValue.trim());
  }
  return resolveConfigDirValue(configDir, homedir());
}

function resolveConfigDirValue(value: string, baseDir?: string): string {
  if (value.startsWith("~")) return resolve(homedir(), value.replace(/^~[/\\]?/, ""));
  if (isAbsolute(value)) return resolve(value);
  return baseDir ? resolve(baseDir, value) : resolve(value);
}

function invalidStorageOverride(kind: StorageDirectoryKind, path: string, detail: string): StorageDirectoryError {
  return new StorageDirectoryError(
    kind,
    path,
    STORAGE_ROOT_ENV,
    undefined,
    [`Invalid ${STORAGE_ROOT_ENV} for context-mode ${kind} directory: ${detail}`, storageDirectoryHint()].join("\n"),
  );
}

function storageOverrideRoot(kind: StorageDirectoryKind): OverrideRoot {
  const raw = process.env[STORAGE_ROOT_ENV];
  if (raw === undefined) return { kind: "unset" };

  const trimmed = raw.trim();
  if (!trimmed) {
    return { kind: "ignored-empty", ignoredEnvVar: STORAGE_ROOT_ENV, ignoredReason: "empty" };
  }
  if (!isAbsolute(trimmed)) {
    throw invalidStorageOverride(kind, trimmed, `${STORAGE_ROOT_ENV} must be an absolute path.`);
  }

  return { kind: "override", root: resolve(trimmed) };
}

function ignoredStorageMetadata(root: OverrideRoot): Pick<ResolvedStorageDir, "ignoredEnvVar" | "ignoredReason"> {
  return root.kind === "ignored-empty"
    ? { ignoredEnvVar: root.ignoredEnvVar, ignoredReason: root.ignoredReason }
    : {};
}

function overrideStorageDir(kind: StorageDirectoryKind, subdir: string): ResolvedStorageDir | null {
  const root = storageOverrideRoot(kind);
  if (root.kind !== "override") return null;

  return {
    kind,
    path: join(root.root, subdir),
    envVar: STORAGE_ROOT_ENV,
    source: "override",
  };
}

function defaultStorageDir(
  kind: StorageDirectoryKind,
  getDefaultDir: () => string,
  metadata: Pick<ResolvedStorageDir, "ignoredEnvVar" | "ignoredReason">,
): ResolvedStorageDir {
  return {
    kind,
    path: resolve(getDefaultDir()),
    envVar: null,
    source: "default",
    ...metadata,
  };
}

export function resolveSessionStorageDir(getDefaultDir: () => string): ResolvedStorageDir {
  const root = storageOverrideRoot("session");
  if (root.kind === "override") {
    return {
      kind: "session",
      path: join(root.root, STORAGE_SESSIONS_SUBDIR),
      envVar: STORAGE_ROOT_ENV,
      source: "override",
    };
  }

  return defaultStorageDir("session", getDefaultDir, ignoredStorageMetadata(root));
}

export function resolveContentStorageDir(getSessionDir: () => string): ResolvedStorageDir {
  const override = overrideStorageDir("content", STORAGE_CONTENT_SUBDIR);
  if (override) return override;

  const session = resolveSessionStorageDir(getSessionDir);
  return {
    kind: "content",
    path: join(dirname(session.path), STORAGE_CONTENT_SUBDIR),
    envVar: session.envVar,
    source: session.source,
    ignoredEnvVar: session.ignoredEnvVar,
    ignoredReason: session.ignoredReason,
  };
}

export function resolveStatsStorageDir(getDefaultSessionDir: () => string): ResolvedStorageDir {
  const override = overrideStorageDir("stats", STORAGE_SESSIONS_SUBDIR);
  if (override) return override;

  const session = resolveSessionStorageDir(getDefaultSessionDir);
  return {
    kind: "stats",
    path: session.path,
    envVar: session.envVar,
    source: session.source,
    ignoredEnvVar: session.ignoredEnvVar,
    ignoredReason: session.ignoredReason,
  };
}

export function formatStorageDirectoryError(err: StorageDirectoryError): string {
  return err.message;
}

export function describeStorageDirectorySource(dir: ResolvedStorageDir): string {
  if (dir.source === "override" && dir.envVar) return `via ${dir.envVar}`;
  if (dir.ignoredEnvVar && dir.ignoredReason === "empty") return `default; ignored empty ${dir.ignoredEnvVar}`;
  return "default";
}

export function clearStorageDirectoryCheckCacheForTests(): void {
  writableStorageCache.clear();
}

export function ensureWritableStorageDir(dir: ResolvedStorageDir): string {
  const key = [
    dir.kind,
    dir.path,
    dir.source,
    dir.envVar ?? "",
    dir.ignoredEnvVar ?? "",
    dir.ignoredReason ?? "",
  ].join("\0");
  const cached = writableStorageCache.get(key);
  if (cached instanceof StorageDirectoryError) throw cached;
  if (cached === dir.path) return cached;

  try {
    mkdirSync(dir.path, { recursive: true });
    accessSync(dir.path, constants.W_OK);
    writableStorageCache.set(key, dir.path);
    return dir.path;
  } catch (err) {
    const storageErr = new StorageDirectoryError(
      dir.kind,
      pathFromStorageError(err) ?? dir.path,
      STORAGE_ROOT_ENV,
      err,
      undefined,
      { ignoredEnvVar: dir.ignoredEnvVar, ignoredReason: dir.ignoredReason },
    );
    writableStorageCache.set(key, storageErr);
    throw storageErr;
  }
}

function storageDirectoryErrorMessage(
  kind: StorageDirectoryKind,
  path: string,
  metadata: Pick<ResolvedStorageDir, "ignoredEnvVar" | "ignoredReason"> = {},
): string {
  return [
    `context-mode ${kind} directory is not writable: ${path}`,
    ignoredStorageOverrideHint(metadata),
    storageDirectoryHint(),
  ].filter(Boolean).join("\n");
}

function ignoredStorageOverrideHint(metadata: Pick<ResolvedStorageDir, "ignoredEnvVar" | "ignoredReason">): string | null {
  if (metadata.ignoredEnvVar && metadata.ignoredReason === "empty") {
    return `Ignored empty ${metadata.ignoredEnvVar}; using adapter default.`;
  }
  return null;
}

function storageDirectoryHint(): string {
  return `Set ${STORAGE_ROOT_ENV} to a writable absolute path.`;
}

function pathFromStorageError(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const path = (err as { path?: unknown }).path;
  return typeof path === "string" && path.length > 0 ? path : null;
}
