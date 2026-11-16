#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBatchTool } from "./server-batch.js";
import { boundResponse } from "./response-budget.js";
import { registerExecutionTools } from "./server-execution.js";
import { registerIndexTool } from "./server-index.js";
import { registerSearchTool } from "./server-search.js";
import { registerFetchTool } from "./server-fetch.js";
import { registerStatsTool } from "./server-stats.js";
import { registerMaintenanceTools, registerInsightTool } from "./server-maintenance.js";
import { registerPurgeTool } from "./server-purge.js";
export { positionsFromHighlight } from "./server-snippets.js";
export { extractSnippet } from "./server-snippets.js";
export type { BatchQueryScope } from "./server-snippets.js";
export { formatBatchQueryResults } from "./server-snippets.js";
export type { BatchCommand } from "./server-batch.js";
export type { BatchRunResult } from "./server-batch.js";
export type { BatchRunOptions } from "./server-batch.js";
export { buildBatchNodeOptionsPrefix } from "./server-batch.js";
export { runBatchCommands } from "./server-batch.js";
export { buildFetchCode } from "./server-fetch-code.js";
export { classifyIp } from "./server-fetch-code.js";
export type { SpawnSyncFn } from "./server-browser.js";
export type { BrowserOpenResult } from "./server-browser.js";
export type { KillResult } from "./server-browser.js";
export { browserOpenArgv } from "./server-browser.js";
export { openBrowserSync } from "./server-browser.js";
export { killProcessOnPort } from "./server-browser.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { existsSync, unlinkSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

import { PolyglotExecutor } from "./executor.js";

import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs } from "./store.js";

import { readBashPolicies, evaluateCommandDenyOnly, extractShellCommands, readToolDenyPatterns, readToolPermissionPatterns, evaluateFilePath, evaluateProjectContainment } from "./security.js";
import { detectRuntimes, getRuntimeSummary, getAvailableLanguages, hasBunRuntime } from "./runtime.js";

import { startLifecycleGuard, noteMcpActivity, noteRequestStart, noteRequestEnd, attachMcpActivityTap } from "./lifecycle.js";

import { ensureWritableStorageDir, formatStorageDirectoryError, resolveContentStorePath, resolveContentStorageDir, resolveSessionDbPath, resolveSessionStorageDir, StorageDirectoryError } from "./session/db.js";

import { emitIndexWriteEvent, emitSandboxExecuteEvent } from "./session/event-emit.js";
import { persistToolCallCounter, restoreSessionStats } from "./session/persist-tool-calls.js";

import { PiAdapter } from "./adapters/pi/index.js";
import { resolveProjectDir } from "./util/project-dir.js";
import { loadDatabase } from "./db-base.js";
const __pkg_dir = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const rel of ["../package.json", "./package.json"]) {
    const p = resolve(__pkg_dir, rel);
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")).version; } catch {}
    }
  }
  return "unknown";
})();

function getPackageRoot(): string {
  return existsSync(resolve(__pkg_dir, "package.json")) ? __pkg_dir : dirname(__pkg_dir);
}

// Prevent silent MCP server death from unhandled async errors.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`[context-mode] unhandledRejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  try {
    writeSync(2, `[context-mode] uncaughtException: ${err?.message ?? err}\n`);
  } finally {
    process.exit(1);
  }
});

const runtimes = detectRuntimes();
const available = getAvailableLanguages(runtimes);
export const server = new McpServer({
  name: "context-mode",
  version: VERSION,
});

export interface RegisteredCtxTool {
  name: string;
  config: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export const REGISTERED_CTX_TOOLS: RegisteredCtxTool[] = [];

const originalRegisterTool = server.registerTool.bind(server);
(server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
  const [name, config, handler] = args as [
    string,
    Record<string, unknown>,
    (toolArgs: Record<string, unknown>) => Promise<unknown> | unknown,
  ];
  const wrappedHandler = wrapToolHandler(name, handler);
  REGISTERED_CTX_TOOLS.push({ name, config, handler: wrappedHandler });
  args[2] = wrappedHandler;
  return (originalRegisterTool as unknown as (...callArgs: unknown[]) => unknown)(...args);
};

function wrapToolHandler(
  name: string,
  handler: (toolArgs: Record<string, unknown>) => Promise<unknown> | unknown,
): (toolArgs: Record<string, unknown>) => Promise<unknown> {
  return async (toolArgs: Record<string, unknown>) => {
    // #854: mark a tool call in-flight so the bridge-child idle reaper never
    // shuts the server down mid-execution during a long ctx_execute/batch that
    // emits no further inbound messages. Symmetric end in finally (success+error).
    noteRequestStart();
    try {
      return await handler(toolArgs);
    } catch (err) {
      const result = storageErrorResult(err);
      if (result) {
        try {
          return trackResponse(name, result);
        } catch (trackErr) {
          if (trackErr instanceof StorageDirectoryError) return result;
          throw trackErr;
        }
      }
      throw err;
    } finally {
      noteRequestEnd();
    }
  };
}

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

const executor = new PolyglotExecutor({
  runtimes,
  projectRoot: () => getProjectDir(),
});

// ─────────────────────────────────────────────────────────
// FS read tracking preload for ctx_batch_execute
// ─────────────────────────────────────────────────────────
// NODE_OPTIONS is denied by the executor's #buildSafeEnv (security).
// Instead, we inject it as an inline shell env prefix in each batch command.
// This temp file is loaded via --require when batch commands spawn Node processes.
const CM_FS_PRELOAD = join(tmpdir(), `cm-fs-preload-${process.pid}.js`);
writeFileSync(
  CM_FS_PRELOAD,
  `(function(){var __cm_fs=0;process.on('exit',function(){if(__cm_fs>0)try{process.stderr.write('__CM_FS__:'+__cm_fs+'\\n')}catch(e){}});try{var f=require('fs');var ors=f.readFileSync;f.readFileSync=function(){var r=ors.apply(this,arguments);if(Buffer.isBuffer(r))__cm_fs+=r.length;else if(typeof r==='string')__cm_fs+=Buffer.byteLength(r);return r;};}catch(e){}})();\n`,
);
// In the stdio MCP path, main() also removes this file during graceful
// shutdown. Plugin-native OpenCode/Kilo imports skip main() (#574), so
// register a top-level best-effort cleanup too to avoid leaking preload
// snippets under /tmp when the host process exits.
process.on("exit", () => { try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ } });

// Lazy singleton — no DB overhead unless index/search is used
let _store: ContentStore | null = null;

/**
 * Build the FK-attribution object passed to every ContentStore.index*() call
 * in this process. CLAUDE_SESSION_ID is the only MCP-side handle we have on
 * the current session — eventId stays undefined because MCP tool invocations
 * are not paired with PostToolUse event rows at index time (the hook fires
 * AFTER the tool returns). Empty-string fallback inside #insertChunks keeps
 * legacy unattributed rows readable.
 */
export function currentAttribution(): { sessionId?: string } | undefined {
  const sessionId = process.env.CLAUDE_SESSION_ID ?? resolveSessionIdFromSessionDB();
  if (!sessionId) return undefined;
  return { sessionId };
}

let __cachedSessionId: { sid: string; checkedAt: number } | undefined;
/** v1.0.134 SLICE A: opts injection for testability. Production callers pass nothing. */
export function resolveSessionIdFromSessionDB(opts?: {
  projectDir?: string;
  sessionsDir?: string;
  bypassCache?: boolean;
}): string | undefined {
  // 2s cache — ctx_fetch_and_index can fire 5+ chunks/sec; DB open cost adds up.
  const now = Date.now();
  if (!opts?.bypassCache && __cachedSessionId && now - __cachedSessionId.checkedAt < 2000) {
    return __cachedSessionId.sid;
  }
  try {
    const projectDir = opts?.projectDir ?? getProjectDir();
    if (!projectDir) return undefined;
    const sessionsDir = opts?.sessionsDir ?? getSessionDir();
    const dbPath = resolveSessionDbPath({ projectDir, sessionsDir });
    if (!existsSync(dbPath)) return undefined;
    const Database = loadDatabase();
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare(
        "SELECT session_id FROM session_events ORDER BY created_at DESC LIMIT 1"
      ).get() as { session_id?: string } | undefined;
      const sid = row?.session_id;
      if (sid) __cachedSessionId = { sid, checkedAt: now };
      return sid;
    } finally {
      try { db.close(); } catch { /* best-effort */ }
    }
  } catch {
    return undefined;
  }
}

// ── Pi-first paths ────────────────────────────────────────────────────────
const _detectedAdapter = new PiAdapter();

function getDefaultSessionDir(): string {
  return _detectedAdapter.getSessionDir();
}

function getSessionDir(): string {
  return ensureWritableStorageDir(resolveSessionStorageDir(getDefaultSessionDir));
}

export function getProjectDir(): string {
  return resolveProjectDir({
    env: process.env,
    cwd: process.cwd(),
    pwd: process.env.PWD,
  });
}

/**
 * Resolve a possibly-relative path against the project directory (full env cascade),
 * not the MCP server's process.cwd(). MCP server is spawned by the host and its cwd
 * is unrelated to where the user is working.
 */
function resolveProjectPath(filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(getProjectDir(), filePath);
}

/**
 * Resolve the per-project SessionDB path. Delegates to
 * {@link resolveSessionDbPath} so casing-only variants of the same
 * physical worktree on macOS / Windows hit ONE DB, not two — and any
 * pre-existing legacy raw-casing DB gets migrated in place on first
 * resolve. Linux is a no-op.
 */
function getSessionDbPath(): string {
  return resolveSessionDbPath({
    projectDir: getProjectDir(),
    sessionsDir: getSessionDir(),
  });
}

/**
 * Compute a per-project, per-platform persistent path for the ContentStore.
 * Derives content dir from the adapter's session dir so each platform
 * has its own isolated FTS5 DB — no cross-platform data sharing.
 *
 * Layout: ~/<configDir>/context-mode/content/<hash>.db
 *   e.g.  ~/.claude/context-mode/content/87c28c41ddb64d38.db
 *         ~/.cursor/context-mode/content/87c28c41ddb64d38.db
 */
function getStorePath(): string {
  const dir = ensureWritableStorageDir(resolveContentStorageDir(getDefaultSessionDir));
  // Delegate to resolveContentStorePath: same case-fold + one-shot legacy
  // rename behavior as resolveSessionDbPath. On macOS / Windows, an
  // existing legacy raw-casing FTS5 db (with -wal/-shm sidecars) is
  // migrated in place on first call. On Linux it's a no-op.
  return resolveContentStorePath({ projectDir: getProjectDir(), contentDir: dir });
}

function getStore(): ContentStore {
  if (!_store) {
    // Content DB cleanup on fresh start is handled by SessionStart hook.
    // Server just opens whatever DB exists (or creates new if hook deleted it).
    const dbPath = getStorePath();
    _store = new ContentStore(dbPath);

    // Wire deny-policy hook: store re-checks the Read deny list before
    // re-reading any file_path during auto-refresh. Catches policy edits
    // made after a file was originally indexed. See #442 round-3.
    _store.setDenyChecker((filePath: string) => {
      try {
        const projectDir = getProjectDir();
        const denyGlobs = readToolDenyPatterns("Read", projectDir);
        const r = evaluateFilePath(
          filePath,
          denyGlobs,
          process.platform === "win32",
          projectDir,
        );
        return r.denied;
      } catch {
        // Fail-closed for refresh: skip on error rather than re-read.
        return true;
      }
    });

    // One-time startup cleanup: remove stale content DBs (>14 days)
    try {
      const contentDir = dirname(dbPath);
      cleanupStaleContentDBs(contentDir, 14);
      _store.cleanupStaleSources(14);
      // Also clean legacy shared dir from before platform isolation
      const legacyDir = join(homedir(), ".context-mode", "content");
      if (existsSync(legacyDir)) cleanupStaleContentDBs(legacyDir, 0);
    } catch { /* best-effort */ }

    // Also clean old PID-based DBs from migration
    cleanupStaleDBs();
  }
  return _store;
}

// ─────────────────────────────────────────────────────────
// Session stats — track context consumption per tool
// ─────────────────────────────────────────────────────────

const sessionStats = {
  calls: {} as Record<string, number>,
  bytesReturned: {} as Record<string, number>,
  bytesIndexed: 0,
  bytesSandboxed: 0, // network I/O consumed inside sandbox (never enters context)
  cacheHits: 0,
  cacheMisses: 0, // ctx_fetch_and_index calls that bypassed the TTL cache
  cacheBytesSaved: 0, // bytes avoided by TTL cache hits
  sessionStart: Date.now(),
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

function storageErrorResult(err: unknown): ToolResult | null {
  if (!(err instanceof StorageDirectoryError)) return null;
  return {
    content: [{ type: "text", text: formatStorageDirectoryError(err) }],
    isError: true,
  };
}
function trackResponse(toolName: string, response: ToolResult, maxOutputChars?: number, sandboxedBytes?: number): ToolResult {
  // #854: a response is activity too — refresh the bridge-child idle clock so a
  // chatty/streaming call keeps its server alive even between inbound frames.
  noteMcpActivity();
  if (maxOutputChars !== undefined && response.content.length) {
    const joined = response.content.length === 1
      ? response.content[0].text
      : response.content.map(c => c.text).join("\n");
    if (joined.length > maxOutputChars) {
      response.content = [{
        type: "text",
        text: boundResponse(joined, maxOutputChars,
          "(output cap reached) Preview shortened; use the returned source for details when available."),
      }];
    }
  }

  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;

  // Persist to SessionDB so counters survive process restart / compaction.
  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));

  if (
    toolName === "ctx_execute"
    || toolName === "ctx_execute_file"
    || toolName === "ctx_batch_execute"
  ) {
    setImmediate(() =>
      emitSandboxExecuteEvent({
        sessionDbPath: getSessionDbPath(),
        toolName,
        bytesReturned: bytes,
        bytesAvoided: sandboxedBytes,
      })
    );
  }

  return response;
}

function trackIndexed(bytes: number, source: string = "unknown"): void {
  sessionStats.bytesIndexed += bytes;
  if (bytes > 0) {
    setImmediate(() =>
      emitIndexWriteEvent({
        sessionDbPath: getSessionDbPath(),
        source,
        bytesAvoided: bytes,
      })
    );
  }
}

// ==============================================================================
// Security: server-side deny firewall
// ==============================================================================

/**
 * Check a shell command against Bash deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkDenyPolicy(
  command: string,
  toolName: string,
): ToolResult | null {
  try {
    const policies = readBashPolicies(getProjectDir());
    const result = evaluateCommandDenyOnly(command, policies);
    if (result.decision === "deny") {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `Command blocked by security policy: matches deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Security check failed — allow through (fail-open for server)
  }
  return null;
}

/**
 * Check non-shell code for shell-escape calls against deny patterns.
 */
function checkNonShellDenyPolicy(
  code: string,
  language: string,
  toolName: string,
): ToolResult | null {
  try {
    const commands = extractShellCommands(code, language);
    if (commands.length === 0) return null;
    const policies = readBashPolicies(getProjectDir());
    for (const cmd of commands) {
      const result = evaluateCommandDenyOnly(cmd, policies);
      if (result.decision === "deny") {
        return trackResponse(toolName, {
          content: [{
            type: "text" as const,
            text: `Command blocked by security policy: embedded shell command "${cmd}" matches deny pattern ${result.matchedPattern}`,
          }],
          isError: true,
        });
      }
    }
  } catch {
    // Fail-open
  }
  return null;
}

/**
 * Issue #852 — project-boundary containment for `ctx_execute_file`.
 *
 * The harness sandbox (Claude Code, etc.) cannot inspect MCP input params, so a
 * user approving a `ctx_execute_file` call cannot see that its `path` escapes
 * the workspace. This guard refuses a `path` that resolves outside the project
 * root (absolute escape, `../` traversal, or symlink-out), restoring the
 * boundary the host believes it is enforcing.
 *
 * Escape hatch — NO bespoke opt-out env. A deliberate out-of-project read is
 * expressed in the SAME host config the user already maintains: a
 * `permissions.allow` rule like `Read(/var/log/**)`. This reuses the exact
 * mechanism Claude Code uses to whitelist a path outside its sandbox, so the
 * grant lives in one place and stays meaningful instead of rotting into a
 * context-mode-only env flag nobody sets.
 *
 * Fail-open on resolver failure (consistent with the other deny checks): if the
 * project root cannot be resolved, containment evaluates as "inside" and the
 * path is allowed through rather than spuriously blocking legitimate work.
 */
function checkProjectBoundary(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const allowGlobs = readToolPermissionPatterns("Read", "allow", projectDir);
    const verdict = evaluateProjectContainment(filePath, projectDir, allowGlobs);
    if (verdict.allowed) return null;
    return trackResponse(toolName, {
      content: [{
        type: "text" as const,
        text:
          `File access blocked: "${filePath}" resolves outside the project root ` +
          `(${projectDir}). context-mode confines ${toolName} to the workspace so it ` +
          `cannot be used to bypass the host's sandbox/permission controls (issue #852). ` +
          `To intentionally process a file outside the project, add a host allow rule, ` +
          `e.g. "permissions": { "allow": ["Read(${filePath})"] } in your settings.`,
      }],
      isError: true,
    });
  } catch {
    // Fail-open — resolver failure must not block legitimate in-project work.
  }
  return null;
}

/**
 * Check a file path against Read deny patterns.
 * Returns an error ToolResult if denied, or null if allowed.
 */
function checkFilePathDenyPolicy(
  filePath: string,
  toolName: string,
): ToolResult | null {
  try {
    const projectDir = getProjectDir();
    const denyGlobs = readToolDenyPatterns("Read", projectDir);
    const result = evaluateFilePath(
      filePath,
      denyGlobs,
      process.platform === "win32",
      projectDir,
    );
    if (result.denied) {
      return trackResponse(toolName, {
        content: [{
          type: "text" as const,
          text: `File access blocked by security policy: path matches Read deny pattern ${result.matchedPattern}`,
        }],
        isError: true,
      });
    }
  } catch {
    // Fail-open
  }
  return null;
}

// Build description dynamically based on detected runtimes
const langList = available.join(", ");
const bunNote = hasBunRuntime()
  ? " (Bun detected — JS/TS runs 3-5x faster)"
  : "";
// Resource ownership stays in this composition root; handlers receive live access.
export interface ServerToolContext {
  CM_FS_PRELOAD: typeof CM_FS_PRELOAD;
  VERSION: typeof VERSION;
  _detectedAdapter: PiAdapter;
  _store: ContentStore | null;
  available: typeof available;
  bunNote: typeof bunNote;
  checkDenyPolicy: typeof checkDenyPolicy;
  checkFilePathDenyPolicy: typeof checkFilePathDenyPolicy;
  checkNonShellDenyPolicy: typeof checkNonShellDenyPolicy;
  checkProjectBoundary: typeof checkProjectBoundary;
  currentAttribution: typeof currentAttribution;
  executor: typeof executor;
  getDefaultSessionDir: typeof getDefaultSessionDir;
  getPackageRoot: typeof getPackageRoot;
  getProjectDir: typeof getProjectDir;
  getSessionDbPath: typeof getSessionDbPath;
  getSessionDir: typeof getSessionDir;
  getStore: typeof getStore;
  getStorePath: typeof getStorePath;
  langList: typeof langList;
  resolveProjectPath: typeof resolveProjectPath;
  runtimes: typeof runtimes;
  server: typeof server;
  sessionStats: typeof sessionStats;
  trackIndexed: typeof trackIndexed;
  trackResponse: typeof trackResponse;
}

const toolContext: ServerToolContext = {
  CM_FS_PRELOAD,
  VERSION,
  _detectedAdapter,
  get _store() { return _store; },
  set _store(value) { _store = value; },
  available,
  bunNote,
  checkDenyPolicy,
  checkFilePathDenyPolicy,
  checkNonShellDenyPolicy,
  checkProjectBoundary,
  currentAttribution,
  executor,
  getDefaultSessionDir,
  getPackageRoot,
  getProjectDir,
  getSessionDbPath,
  getSessionDir,
  getStore,
  getStorePath,
  langList,
  resolveProjectPath,
  runtimes,
  server,
  sessionStats,
  trackIndexed,
  trackResponse,
};


registerExecutionTools(toolContext);

registerIndexTool(toolContext);

registerSearchTool(toolContext);

registerFetchTool(toolContext);

registerBatchTool(toolContext);

registerStatsTool(toolContext);

registerMaintenanceTools(toolContext);

registerPurgeTool(toolContext);

registerInsightTool(toolContext);

// ─────────────────────────────────────────────────────────
// Server startup
// ─────────────────────────────────────────────────────────

async function main() {
  // Clean up stale DB files from previous sessions
  const cleaned = cleanupStaleDBs();
  if (cleaned > 0) {
    console.error(`Cleaned up ${cleaned} stale DB file(s) from previous sessions`);
  }

  // Clean up own DB + backgrounded processes + preload script on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    if (_store) _store.close(); // persist DB across sessions
    try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ }
  };
  const gracefulShutdown = async () => {
    shutdown();
    process.exit(0);
  };
  process.on("exit", shutdown);
  process.on("SIGINT", () => { gracefulShutdown(); });
  process.on("SIGTERM", () => { gracefulShutdown(); });

  // Lifecycle guard: detect parent death + stdin close to prevent orphaned processes (#103)
  startLifecycleGuard({ onShutdown: () => gracefulShutdown() });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // #854: refresh the bridge-child idle clock on each inbound MCP message so an
  // abandoned bridge child (CONTEXT_MODE_BRIDGE_DEPTH>0) self-terminates instead
  // of accumulating under a long-lived Pi parent. Best-effort; no stdin touch.
  attachMcpActivityTap(
    transport as unknown as { onmessage?: (message: unknown, extra?: unknown) => unknown },
  );

  // Restore tool-call counters from SessionDB on startup so ctx_stats reflects prior calls.
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch { /* best effort — never block startup on a stats restore failure */ }

  if (process.stdin.isTTY) {
    console.error(`Context Mode MCP server v${VERSION} running on stdio`);
    console.error(`Detected runtimes:\n${getRuntimeSummary(runtimes)}`);
    if (!hasBunRuntime()) {
      console.error(
        "\nPerformance tip: Install Bun for 3-5x faster JS/TS execution",
      );
      console.error("  curl -fsSL https://bun.sh/install | bash");
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
