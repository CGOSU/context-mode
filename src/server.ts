#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBatchTool } from "./server-batch.js";
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
export { AGY_DEFAULT_EXEC_TIMEOUT_MS } from "./server-execution-options.js";
export { resolveExecTimeout } from "./server-execution-options.js";
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

import { existsSync, unlinkSync, readdirSync, readFileSync, writeFileSync, writeSync, renameSync, mkdirSync, symlinkSync, lstatSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { request as httpsRequest } from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";

import { PolyglotExecutor } from "./executor.js";

import { ContentStore, cleanupStaleDBs, cleanupStaleContentDBs } from "./store.js";

import { readBashPolicies, evaluateCommandDenyOnly, extractShellCommands, readToolDenyPatterns, readToolPermissionPatterns, evaluateFilePath, evaluateProjectContainment } from "./security.js";
import { detectRuntimes, getRuntimeSummary, getAvailableLanguages, hasBunRuntime } from "./runtime.js";

import { startLifecycleGuard, noteMcpActivity, noteRequestStart, noteRequestEnd, attachMcpActivityTap } from "./lifecycle.js";

import { ensureWritableStorageDir, formatStorageDirectoryError, resolveContentStorePath, resolveContentStorageDir, resolveDefaultSessionDir, resolveSessionDbPath, resolveSessionStorageDir, resolveStatsStorageDir, StorageDirectoryError } from "./session/db.js";

import { emitIndexWriteEvent, emitSandboxExecuteEvent } from "./session/event-emit.js";
import { persistToolCallCounter, restoreSessionStats } from "./session/persist-tool-calls.js";
import { appendRetrievalBytes } from "./session/retrieval-marker.js";



import { type HookAdapter, type PlatformId } from "./adapters/types.js";
import { detectPlatform, getSessionDirSegments } from "./adapters/detect.js";
import { parseCodexContextModePluginRoot } from "./adapters/codex/index.js";

import { stripJsonComments } from "./util/jsonc.js";
import { resolveClaudeConfigDir } from "./util/claude-config.js";
import { resolveProjectDir } from "./util/project-dir.js";
import { loadDatabase } from "./db-base.js";
import { getLifetimeStats, pricePerToken } from "./session/analytics.js";
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

function resolveCodexRuntimePluginRoot(fallbackRoot: string): string {
  try {
    const probe = process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", "codex plugin list"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      })
      : spawnSync("codex", ["plugin", "list"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
    if (probe.status !== 0) return fallbackRoot;
    const runtimeRoot = parseCodexContextModePluginRoot(String(probe.stdout));
    if (runtimeRoot && existsSync(resolve(runtimeRoot, ".codex-plugin", "hooks.json"))) {
      return runtimeRoot;
    }
  } catch {
    // Best effort only. Non-Codex hosts and older Codex builds may not expose
    // plugin list; keep the package-root fallback for those environments.
  }
  return fallbackRoot;
}

function getRuntimeAwarePackageRoot(platformId?: PlatformId): string {
  const packageRoot = getPackageRoot();
  return platformId === "codex"
    ? resolveCodexRuntimePluginRoot(packageRoot)
    : packageRoot;
}

// Prevent silent MCP server death from unhandled async errors.
//
// Guarded for plugin-native OpenCode/Kilo imports (#574): when server.js is
// imported only to reuse the ctx_* tool registry, these handlers would become
// process-wide OpenCode/Kilo host handlers. In Node, adding an
// `uncaughtException` listener changes default crash behavior, so only the
// standalone MCP process may install them.
if (process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
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
}

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

export function shouldSuppressMcpToolsForNativePluginHost(
  opts: { embedded?: string; platform?: PlatformId; settings?: Record<string, unknown> | null } = {},
): boolean {
  const embedded = opts.embedded ?? process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS;
  if (embedded === "1") return false;
  const platform = opts.platform ?? detectPlatform().platform;
  if (platform !== "opencode" && platform !== "kilo") return false;
  const settings = opts.settings ?? readNativePluginHostSettings(platform);
  return settingsHasContextModePlugin(settings) && settingsHasLegacyContextModeMcp(settings);
}

function readNativePluginHostSettings(platform: PlatformId): Record<string, unknown> | null {
  const base = platform === "kilo" ? "kilo" : "opencode";
  const paths = [
    resolve(`${base}.json`),
    resolve(`${base}.jsonc`),
    resolve(`.${base}`, `${base}.json`),
    resolve(`.${base}`, `${base}.jsonc`),
    join(homedir(), ".config", base, `${base}.json`),
    join(homedir(), ".config", base, `${base}.jsonc`),
  ];
  for (const p of paths) {
    try {
      if (!existsSync(p)) continue;
      return JSON.parse(stripJsonComments(readFileSync(p, "utf8"))) as Record<string, unknown>;
    } catch { /* try next config path */ }
  }
  return null;
}

function settingsHasContextModePlugin(settings: Record<string, unknown> | null | undefined): boolean {
  const plugins = settings?.plugin;
  return Array.isArray(plugins) && plugins.some((p) => typeof p === "string" && p.includes("context-mode"));
}

function settingsHasLegacyContextModeMcp(settings: Record<string, unknown> | null | undefined): boolean {
  const mcp = settings?.mcp;
  return !!(
    mcp &&
    typeof mcp === "object" &&
    !Array.isArray(mcp) &&
    Object.prototype.hasOwnProperty.call(mcp, "context-mode")
  );
}

const suppressMcpToolsForNativePluginHost = shouldSuppressMcpToolsForNativePluginHost();

/**
 * Issue #623 — surface why ctx_* tools/list is empty on suppressed legacy MCP
 * children. When a user upgrades OpenCode/Kilo from v1.0.136 → v1.0.137+ without
 * running `context-mode upgrade`, their opencode.json still has BOTH the legacy
 * mcp.context-mode block AND the plugin entry. The plugin path registers the
 * tools natively, but the legacy MCP child runs in parallel and used to expose
 * duplicate tools — v1.0.137 suppressed those duplicates. The suppression was
 * silent, leaving any MCP client that inspected the child via tools/list with
 * an empty list and no diagnostic. Emit one stderr line per process so an
 * operator running the child directly (or any non-plugin MCP host) sees the
 * exact reason and the `context-mode upgrade` fix.
 *
 * Exported for test (suppression-diagnostic regression guard).
 */
let __suppressionDiagnosticEmitted = false;
export function emitSuppressionDiagnostic(
  opts: { platform?: string; write?: (chunk: string) => void } = {},
): void {
  if (__suppressionDiagnosticEmitted) return;
  __suppressionDiagnosticEmitted = true;
  const write = opts.write ?? ((c: string) => { process.stderr.write(c); });
  const platform = opts.platform ?? "opencode/kilo";
  write(
    `[context-mode] ctx_* tools/list intentionally empty on this MCP child: ` +
    `legacy mcp.context-mode block coexists with plugin: ["context-mode"] in ` +
    `${platform}.json — plugin-native tools are the supported path (#623). ` +
    `Run \`context-mode upgrade\` to remove the legacy block (preserves other ` +
    `MCP servers).\n`
  );
}
/** Test-only: reset the one-shot emission flag so suites can re-exercise. */
export function __resetSuppressionDiagnosticForTests(): void {
  __suppressionDiagnosticEmitted = false;
}

/**
 * Issue #637 — register an explicit empty `tools/list` handler on the McpServer.
 *
 * Background: when `suppressMcpToolsForNativePluginHost` is true, every
 * `server.registerTool()` call is short-circuited (returns `undefined` above).
 * The MCP SDK only installs the SDK-default `tools/list` handler when at least
 * one `registerTool()` reaches `setToolRequestHandlers()` internally
 * (mcp.js:56-67). Suppressing every registration leaves `tools/list`
 * unregistered, and the framework's RPC layer answers it with
 * `-32601 "Method not found"`.
 *
 * The reporter of #637 (SquirrelRat) inspected the suppressed child via
 * `tools/list` and read the JSON-RPC error as "the plugin never registers any
 * ctx_* tools" — when in fact the plugin DOES register all 11 tools natively
 * (verified at `src/adapters/opencode/plugin.ts:469` and
 * `tests/opencode-plugin.test.ts:88`). The misleading -32601 is the seed of
 * the #637 perception.
 *
 * This helper installs an explicit handler that returns `{tools: []}` — a
 * spec-compliant empty list. Paired with the existing #623 stderr diagnostic,
 * an operator now sees:
 *   - wire response: `{tools: []}` (matches expectation, no JSON-RPC error)
 *   - stderr: `[context-mode] ctx_* tools/list intentionally empty… (#623)`
 *
 * Idempotent: throws inside SDK if called twice on the same server because
 * `assertCanSetRequestHandler` (mcp.js:60) rejects duplicate registrations;
 * we therefore install the SDK's default tool handlers FIRST (via a no-op
 * registerTool of a fake tool, immediately removed) only if needed. To keep
 * the public surface minimal, we just call `server.server.setRequestHandler`
 * directly — that is the same low-level call used for prompts/resources at
 * server.ts:259-261 and avoids the SDK guard entirely.
 *
 * Exported for test (#637 in-memory regression guard).
 */
export function registerEmptyToolsListHandler(target: McpServer = server): void {
  target.server.registerCapabilities({ tools: { listChanged: false } });
  target.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
}

const originalRegisterTool = server.registerTool.bind(server);
(server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool = (...args: unknown[]) => {
  const [name, config, handler] = args as [
    string,
    Record<string, unknown>,
    (toolArgs: Record<string, unknown>) => Promise<unknown> | unknown,
  ];
  if (suppressMcpToolsForNativePluginHost) {
    emitSuppressionDiagnostic();
    return undefined;
  }
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

// Issue #637 — when suppression is active, install the empty tools/list handler
// once at module-init time so the suppressed MCP child responds with
// `{tools: []}` instead of JSON-RPC `-32601 Method not found`. Pair with the
// #623 stderr diagnostic that explains WHY the list is empty. Skipped for the
// embedded plugin-import path because the embedded process is not the stdio
// MCP child an operator would inspect — it lives inside the OpenCode/Kilo
// host and never speaks JSON-RPC over stdio.
if (suppressMcpToolsForNativePluginHost && process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  registerEmptyToolsListHandler(server);
}

type ToolContextOverride = { projectDir: string; sessionId?: string };
const projectDirOverride = new AsyncLocalStorage<ToolContextOverride>();

export async function withProjectDirOverride<T>(
  projectDir: string | ToolContextOverride,
  fn: () => Promise<T>,
): Promise<T> {
  const ctx = typeof projectDir === "string" ? { projectDir } : projectDir;
  return projectDirOverride.run(ctx, fn);
}

// Register empty prompts/resources handlers so MCP clients don't get -32601 (#168).
// OpenCode calls listPrompts()/listResources() unconditionally — the error can poison
// the SDK transport layer, causing subsequent listTools() calls to fail permanently.
import { ListPromptsRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
server.server.registerCapabilities({ prompts: { listChanged: false }, resources: { listChanged: false } });
server.server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));

// ── Strict-client (Gemini function-calling) schema compatibility ──────────────
// Gemini's function-calling API — used by Antigravity CLI (`agy`) and Gemini CLI
// — rejects JSON Schema `const` and `additionalProperties`. A rejected parameter
// schema makes the host SILENTLY DROP that tool from the model's function list,
// so the agent never sees our ctx_* tools and falls back to hand-rolling the MCP
// protocol through its Bash tool. Sanitize the EMITTED tools/list schema:
//   • `const: X`  →  `enum: [X]`   — an identical single-value constraint
//   • drop `additionalProperties`  — advisory only; every ctx_* handler parses
//     args with Zod (which strips unknown keys server-side), so removing it
//     changes no validation and no call behavior.
// Both transforms are behavior-preserving for every other client (Claude Code,
// Copilot, Cursor, …): `const` and a one-value `enum` are equivalent, and no
// model sends undeclared properties. Only the wire schema changes — never
// validation or how any tool is invoked.
export function sanitizeSchemaForStrictClients(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeSchemaForStrictClients);
  if (node === null || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "additionalProperties") continue;
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    out[key] = sanitizeSchemaForStrictClients(value);
  }
  return out;
}

// Wrap the SDK-installed tools/list handler so its generated schemas pass through
// the sanitizer above. Best-effort by design: if the MCP SDK's internals shift,
// the original handler is left untouched (no regression — strict clients stay as
// they were, every other client unaffected). Must run AFTER all registerTool()
// calls so the SDK's default tools/list handler already exists.
export function installStrictClientSchemaCompat(target: McpServer = server): void {
  try {
    const low = target.server as unknown as {
      _requestHandlers?: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    };
    const original = low._requestHandlers?.get("tools/list");
    if (typeof original !== "function") return;
    target.server.setRequestHandler(ListToolsRequestSchema, async (req, extra) => {
      const result = (await original(req as unknown, extra as unknown)) as
        | { tools?: Array<{ inputSchema?: unknown }> }
        | undefined;
      if (result && Array.isArray(result.tools)) {
        for (const tool of result.tools) {
          if (!tool || tool.inputSchema == null) continue;
          try {
            tool.inputSchema = sanitizeSchemaForStrictClients(tool.inputSchema);
          } catch {
            /* leave this tool's schema unchanged */
          }
        }
      }
      return result as never;
    });
  } catch {
    /* best-effort — never break tools/list */
  }
}

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
  const override = projectDirOverride.getStore();
  if (override?.sessionId) return { sessionId: override.sessionId };

  // CLAUDE_SESSION_ID env var is NOT propagated to MCP servers (only to hooks).
  // Cross-adapter resolution: every adapter (15 of them) sets *_PROJECT_DIR env
  // and writes session_events via hooks. Read the most-recent session_id from
  // THIS project's session DB. Works for claude-code/cursor/gemini-cli/codex/
  // kiro/opencode/zed/kilo/openclaw/qwen-code/vscode-copilot/jetbrains-copilot/
  // omp/pi/antigravity — no adapter-specific transcript path required.
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
    const projectDir = opts?.projectDir
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.env.CONTEXT_MODE_PROJECT_DIR;
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

/**
 * Auto-index session events files written by SessionStart hook.
 * Scans ~/.claude/context-mode/sessions/ for *-events.md files.
 * CLAUDE_PROJECT_DIR is NOT available to MCP servers — only to hooks —
 * so we glob-scan instead of computing a specific hash.
 * Files are consumed (deleted) after indexing to prevent double-indexing.
 * Called on every getStore() — readdirSync is sub-millisecond when no files match.
 */
function maybeIndexSessionEvents(store: ContentStore): void {
  try {
    const sessionsDir = getSessionDir();
    if (!existsSync(sessionsDir)) return;
    const files = readdirSync(sessionsDir).filter(f => f.endsWith("-events.md"));
    for (const file of files) {
      const filePath = join(sessionsDir, file);
      try {
        store.index({ path: filePath, source: "session-events", attribution: currentAttribution() });
        unlinkSync(filePath);
      } catch { /* best-effort per file */ }
    }
  } catch { /* best-effort — session continuity never blocks tools */ }
}

// ── Platform-aware paths ──────────────────────────────────────────────────
// The adapter (stored after MCP handshake) is the canonical source for
// platform-specific paths. All session DB paths go through it — no
// hardcoded configDir detection in tool handlers.

let _detectedAdapter: HookAdapter | null = null;

/**
 * Resolve the Claude Code config root, honoring `CLAUDE_CONFIG_DIR` (incl.
 * leading `~`) before falling back to `~/.claude`. Mirrors
 * `hooks/session-helpers.mjs::resolveConfigDir` and
 * `ClaudeCodeAdapter.getConfigDir` so the pre-detection path agrees with
 * hooks/adapter on where Claude Code session data lives. See issue #453.
 *
 * Issue #460 round-3: delegates to the canonical util so empty/whitespace
 * env values fall back instead of poisoning downstream `join()` calls.
 */
async function getDiagnosticAdapter(): Promise<HookAdapter | null> {
  if (_detectedAdapter) return _detectedAdapter;
  try {
    const { getAdapter } = await import("./adapters/detect.js");
    const signal = detectPlatform();
    return await getAdapter(signal.platform);
  } catch {
    return null;
  }
}

/**
 * Get the platform-specific sessions directory from the detected adapter.
 * Falls back to the detected platform config root before adapter detection.
 */
function getDefaultSessionDir(): string {
  if (_detectedAdapter) return _detectedAdapter.getSessionDir();
  // Pre-detection path (race window before MCP `initialize` completes):
  // call detectPlatform() (sync, env-var-based) and look up segments via
  // getSessionDirSegments() (sync map, no adapter instantiation). This keeps
  // non-Claude platforms from spilling sessions into ~/.claude/. For Claude
  // Code/Codex (single-segment roots), reroute through their config-dir
  // contracts so the pre-detection window does not split-state with hooks.
  try {
    const signal = detectPlatform();
    const segments = getSessionDirSegments(signal.platform);
    if (segments) {
      return resolveDefaultSessionDir({
        configDir: join(...segments),
        configDirEnv: configDirEnvForSessionSegments(segments),
      });
    }
  } catch { /* fall through to claude fallback */ }
  return resolveDefaultSessionDir({ configDir: ".claude", configDirEnv: "CLAUDE_CONFIG_DIR" });
}

function configDirEnvForSessionSegments(segments: string[]): string | undefined {
  if (segments.length === 1 && segments[0] === ".claude") return "CLAUDE_CONFIG_DIR";
  if (segments.length === 1 && segments[0] === ".codex") return "CODEX_HOME";
  return undefined;
}

function getSessionDir(): string {
  return ensureWritableStorageDir(resolveSessionStorageDir(getDefaultSessionDir));
}

/**
 * Project directory detection across supported platforms.
 *
 * Priority:
 *   1. Platform-specific env var (set by host IDE before MCP server spawn)
 *   2. CONTEXT_MODE_PROJECT_DIR (set by start.mjs for ALL platforms — universal)
 *   3. process.cwd() (last resort)
 *
 * CONTEXT_MODE_PROJECT_DIR guarantees correct projectDir even for platforms
 * that don't set their own env var (Cursor, OpenClaw, Codex, Kiro, Zed).
 */
export function getProjectDir(): string {
  const override = projectDirOverride.getStore();
  if (override) return override.projectDir;

  // Delegated to the shared resolver so the env-var chain rejects plugin
  // install paths (set by a prior MCP boot's start.mjs after `/ctx-upgrade`)
  // and prefers the shell-set PWD before the chdir'd cwd. v1.0.115 adds
  // the Claude Code transcript heuristic — read `cwd` from the most-recently-
  // modified `~/.claude/projects/<encoded>/<session>.jsonl` to recover the
  // real project dir when MCP was launched from a non-project cwd (desktop-
  // app launch, /ctx-upgrade respawn). See src/util/project-dir.ts.
  //
  // Issue #521 (v1.0.119): the transcript heuristic ONLY applies on Claude
  // Code. Other platforms (Cursor, OpenCode, Codex, ...) either have no
  // transcript at that path or use a different schema without `cwd`. Worse,
  // a Cursor user who also runs Claude Code would pick up the most-recently-
  // modified Claude Code session's cwd — wrong project entirely. Gate the
  // path on detected platform so non-Claude hosts skip the heuristic and
  // fall through to PWD/cwd cleanly.
  //
  // The Claude heuristic must also be fresh. Hosts such as Pi can be
  // misdetected as Claude Code solely because ~/.claude exists; without a
  // freshness guard an old Claude transcript can globally hijack ctx shell cwd
  // after reboot. Active Claude sessions update their transcript as the user
  // interacts, so stale transcripts should fall through to PWD/cwd.
  //
  // Issue #545 (v1.0.124): pass strictPlatform for ALL adapters so the
  // env-var cascade is built ALGORITHMICALLY from the platform's own
  // workspace vars + universal escape hatch — foreign workspace vars (e.g.
  // CLAUDE_PROJECT_DIR leaked into Pi's MCP child env from the user's shell)
  // cannot win, regardless of cascade order. start.mjs intentionally does
  // NOT pass strictPlatform — host detection is unreliable at the entrypoint
  // and the legacy literal cascade is preserved there for semver safety.
  let transcriptsRoot: string | undefined;
  let strictPlatform: PlatformId | undefined;
  let codexHome: string | undefined;
  try {
    const detected = detectPlatform().platform;
    strictPlatform = detected;
    if (detected === "claude-code") {
      transcriptsRoot = join(homedir(), ".claude", "projects");
    }
    // Issue #45 — Codex publishes no workspace env var, so the resolver
    // reads `meta.cwd` from the most-recently-modified session.jsonl under
    // `${codexHome}/sessions/`. Wire codexHome at the call site so the
    // resolver can be exercised under test without process-level mutation.
    if (detected === "codex") {
      codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    }
  } catch { /* detection failure — leave undefined, resolver uses legacy cascade */ }
  return resolveProjectDir({
    env: process.env,
    cwd: process.cwd(),
    pwd: process.env.PWD,
    transcriptsRoot,
    transcriptMaxAgeMs: 5 * 60 * 1000,
    strictPlatform,
    codexHome,
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
      const contentDir = dirname(getStorePath());
      cleanupStaleContentDBs(contentDir, 14);
      _store.cleanupStaleSources(14);
      // Also clean legacy shared dir from before platform isolation
      const legacyDir = join(homedir(), ".context-mode", "content");
      if (existsSync(legacyDir)) cleanupStaleContentDBs(legacyDir, 0);
    } catch { /* best-effort */ }

    // Also clean old PID-based DBs from migration
    cleanupStaleDBs();
  }
  maybeIndexSessionEvents(_store);
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
};

function storageErrorResult(err: unknown): ToolResult | null {
  if (!(err instanceof StorageDirectoryError)) return null;
  return {
    content: [{ type: "text", text: formatStorageDirectoryError(err) }],
    isError: true,
  };
}
// ── Version outdated warning ──────────────────────────────────────────────
// Non-blocking npm check at startup. trackResponse prepends warning
// using a burst cadence: 3 warnings → 1h silent → 3 warnings → repeat.

let _latestVersion: string | null = null;
let _warningBurstCount = 0;
let _lastBurstStart = 0;
const VERSION_BURST_SIZE = 3;
const VERSION_SILENT_MS = 60 * 60 * 1000; // 1 hour

async function fetchLatestVersion(): Promise<string> {
  return new Promise((res) => {
    const req = httpsRequest(
      "https://registry.npmjs.org/context-mode/latest",
      { headers: { Connection: "close" } },
      (resp) => {
        let raw = "";
        resp.on("data", (chunk: Buffer) => { raw += chunk; });
        resp.on("end", () => {
          try {
            const data = JSON.parse(raw) as { version?: string };
            res(data.version ?? "unknown");
          } catch { res("unknown"); }
        });
      },
    );
    req.on("error", () => res("unknown"));
    req.setTimeout(5000, () => { req.destroy(); res("unknown"); });
    req.end();
  });
}

function getUpgradeHint(): string {
  const name = _detectedAdapter?.name;
  if (name === "Claude Code") return "/ctx-upgrade";
  if (name === "OpenClaw") return "npm run install:openclaw";
  if (name === "Pi") return "npm run build";
  return "npm update -g context-mode";
}

function semverNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

function isOutdated(): boolean {
  if (!_latestVersion || _latestVersion === "unknown") return false;
  return semverNewer(_latestVersion, VERSION);
}

function shouldShowVersionWarning(): boolean {
  if (!isOutdated()) return false;
  const now = Date.now();
  // Start of a new burst?
  if (_warningBurstCount >= VERSION_BURST_SIZE) {
    if (now - _lastBurstStart < VERSION_SILENT_MS) return false; // still silent
    _warningBurstCount = 0; // silence over, reset burst
  }
  if (_warningBurstCount === 0) _lastBurstStart = now;
  _warningBurstCount++;
  return true;
}

// ── Self-heal Layer 2: Mid-session registry heal (anthropics/claude-code#46915) ──
// Runs once on first tool call. If Claude Code auto-updated the registry mid-session,
// hooks break because CLAUDE_PLUGIN_ROOT points to a deleted directory. We create a
// symlink from the broken path to our actual directory so hooks recover.
let _cacheHealDone = false;
function healCacheMidSession(): void {
  if (_cacheHealDone) return;
  _cacheHealDone = true;
  try {
    // Issue #460 round-3: honor $CLAUDE_CONFIG_DIR so users who relocate
    // their CC config root don't have plugin cache healing operate against
    // the wrong tree (and silently miss dangling-symlink cleanup).
    const claudeRoot = resolveClaudeConfigDir();
    const ipPath = resolve(claudeRoot, "plugins", "installed_plugins.json");
    if (!existsSync(ipPath)) return;
    const ip = JSON.parse(readFileSync(ipPath, "utf-8"));
    const cacheRoot = resolve(claudeRoot, "plugins", "cache");
    // Issue #795: canonicalize cacheRoot so the traversal guard works when
    // ~/.claude is a symlink to another volume.  path.resolve() does not
    // dereference symlinks, so installPath values stored as physical paths
    // (e.g. /Volumes/SSD/.../plugins/cache/...) would fail the startsWith
    // check against a symlink-path cacheRoot (/Users/me/.claude/...).
    // realpathSync follows the symlink chain to the canonical location.
    let cacheRootCanon: string;
    try { cacheRootCanon = realpathSync(cacheRoot); }
    catch { cacheRootCanon = cacheRoot; }
    // Plugin root: build/ for tsc, plugin root for bundle
    const pluginRoot = getPackageRoot();
    for (const [key, entries] of Object.entries((ip.plugins ?? {}) as Record<string, Array<{ installPath?: string }>>)) {
      if (key !== "context-mode@context-mode") continue;
      for (const entry of entries) {
        const rp = entry.installPath;
        if (!rp || existsSync(rp)) continue;
        // Path traversal guard (canonical comparison — see #795)
        if (!resolve(rp).startsWith(cacheRootCanon + sep)) continue;
        // Remove dangling symlink
        try { if (lstatSync(rp).isSymbolicLink()) unlinkSync(rp); } catch {}
        const parent = dirname(rp);
        if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
        if (existsSync(pluginRoot)) {
          symlinkSync(pluginRoot, rp, process.platform === "win32" ? "junction" : undefined);
        }
      }
    }
  } catch { /* best effort */ }
}

function trackResponse(toolName: string, response: ToolResult): ToolResult {
  // #854: a response is activity too — refresh the bridge-child idle clock so a
  // chatty/streaming call keeps its server alive even between inbound frames.
  noteMcpActivity();
  // Mid-session cache heal — one-shot, first tool call
  healCacheMidSession();
  // Prepend version outdated warning if needed
  if (shouldShowVersionWarning() && response.content.length > 0) {
    const hint = getUpgradeHint();
    response.content[0].text =
      `⚠️ context-mode v${VERSION} outdated → v${_latestVersion} available. Upgrade: ${hint}\n\n` +
      response.content[0].text;
  }

  const bytes = response.content.reduce(
    (sum, c) => sum + Buffer.byteLength(c.text),
    0,
  );
  sessionStats.calls[toolName] = (sessionStats.calls[toolName] || 0) + 1;
  sessionStats.bytesReturned[toolName] =
    (sessionStats.bytesReturned[toolName] || 0) + bytes;

  // Persist a sidecar JSON snapshot for the statusline — read at ~3-5 Hz by
  // bin/statusline.mjs (and any external dashboard) so they don't have to
  // open the SQLite database. Throttled inside persistStats() (500ms) so
  // it's safe to call on every response.
  persistStats();

  // Persist to SessionDB so counters survive process restart, --continue,
  // upgrade. Re-introduces the write path 4742160 added and b392c2f dropped.
  // setImmediate keeps this off the response hot path; the helper itself
  // is best-effort (never throws).
  setImmediate(() => persistToolCallCounter(getSessionDbPath(), toolName, bytes));

  // D2 Phase 5/7 — sandbox-execute event emission. Tracks the bytes the
  // user actually saw from sandboxed runs so getRealBytesStats() can
  // replace the conservative `events × 256` estimate. Best-effort and
  // off the hot path, same shape as persistToolCallCounter above.
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
      })
    );
  }

  // Retrieval ("With context-mode") bridge — ctx_search / ctx_fetch_and_index
  // response bytes are the kept-out content the model paid to access. The
  // PostToolUse hook never fires for the plugin's OWN MCP tools, so the
  // hook-side extractMcpToolCall can never see these calls (bytes_retrieved
  // was 0/124454 in prod). Drop the count into a marker keyed by the session
  // DB; the next ordinary-tool PostToolUse consumes it and emits a forwardable
  // bytes_retrieved event. Off the hot path; never throws.
  if (toolName === "ctx_search" || toolName === "ctx_fetch_and_index") {
    setImmediate(() => appendRetrievalBytes(getSessionDbPath(), bytes));
  }

  return response;
}

function trackIndexed(bytes: number, source: string = "unknown"): void {
  sessionStats.bytesIndexed += bytes;
  persistStats();
  // D2 Phase 5/7 — index-write event emission. `bytes_avoided` because
  // these are bytes that would have flooded context if the user had
  // Read'd the source instead of indexing.
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

// ─────────────────────────────────────────────────────────
// Stats persistence — written after every tool call so
// external readers (status line scripts, dashboards, hooks)
// can see real-time savings without spawning an MCP client.
// ─────────────────────────────────────────────────────────

const STATS_PERSIST_THROTTLE_MS = 500;
// Schema version for the persisted stats payload (~/.claude/context-mode/sessions/stats-*.json).
// Bump when a field is added/renamed/removed. Statusline reads `schemaVersion ?? 0` and warns when
// it sees a future schema, so legacy bundles degrade gracefully on upgrade rather than silently
// rendering missing fields (PR #401 architect review P1.3).
// v2: added tokens_saved_lifetime + dollars_saved_lifetime.
const STATS_SCHEMA_VERSION = 2;
// pricePerToken() intentionally NOT defined here — single source in
// src/session/analytics.ts re-exported above. (P1.1 — pricing constant dedup,
// PR #401 architect + ops 2-vote convergence.)
const LIFETIME_REFRESH_MS = 30_000;
// Matches the conversion factor in src/session/analytics.ts renderBottomLine:
// ~1KB per session event ÷ 4 bytes/token = 256 tokens/event.
const TOKENS_PER_EVENT = 256;
let _lastStatsPersist = 0;
let _lifetimeCache: { tokens: number; computedAt: number } | undefined;

/**
 * Resolve the per-session stats file path.
 *
 * The session id mirrors the Claude Code adapter contract
 * (`pid-<parent pid>`), so a status line script can derive
 * the same id from `$PPID` without coupling to MCP.
 */
// CLAUDE_SESSION_ID flows from the hosting process (Claude Code, pi, etc.)
// straight into a path.join, and path.join collapses ".." into the result,
// so a host env CLAUDE_SESSION_ID=../../evil writes "stats-evil.json" two
// levels above statsDir. The env var is not under direct MCP-tool-caller
// control, but in CI / multi-tenant contexts where the host env is partly
// influenceable this is an arbitrary-write primitive within the MCP server
// process's filesystem permissions. Constrain to a UUID-shaped charset
// before splicing into the stats filename.
const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
function sanitizeSessionId(raw: string): string {
  return SESSION_ID_RE.test(raw) ? raw : `pid-${process.ppid}`;
}

function getStatsFilePath(): string {
  const raw = process.env.CLAUDE_SESSION_ID || `pid-${process.ppid}`;
  const sessionId = sanitizeSessionId(raw);
  const statsDir = ensureWritableStorageDir(resolveStatsStorageDir(getDefaultSessionDir));
  return join(statsDir, `stats-${sessionId}.json`);
}

function persistStats(): void {
  const now = Date.now();
  if (now - _lastStatsPersist < STATS_PERSIST_THROTTLE_MS) return;
  _lastStatsPersist = now;

  try {
    const totalReturned = Object.values(sessionStats.bytesReturned).reduce(
      (a, b) => a + b,
      0,
    );
    const totalCalls = Object.values(sessionStats.calls).reduce(
      (a, b) => a + b,
      0,
    );
    const keptOut =
      sessionStats.bytesIndexed +
      sessionStats.bytesSandboxed +
      sessionStats.cacheBytesSaved;
    const totalProcessed = keptOut + totalReturned;
    const reductionPct =
      totalProcessed > 0
        ? Math.round((1 - totalReturned / totalProcessed) * 100)
        : 0;
    const tokensSaved = Math.round(keptOut / 4);

    // Lifetime savings — cached separately because getLifetimeStats() scans
    // disk (per-project SessionDBs + auto-memory dirs) and is too expensive
    // for the 500ms persist throttle. Refresh every 30s; the statusline
    // doesn't need second-by-second lifetime accuracy.
    let lifetimeTokens = _lifetimeCache?.tokens ?? 0;
    if (!_lifetimeCache || now - _lifetimeCache.computedAt > LIFETIME_REFRESH_MS) {
      try {
        const life = getLifetimeStats({ sessionsDir: getSessionDir() });
        lifetimeTokens = (life?.totalEvents ?? 0) * TOKENS_PER_EVENT;
        _lifetimeCache = { tokens: lifetimeTokens, computedAt: now };
      } catch {
        // best-effort — keep stale cache or 0
      }
    }

    const payload = {
      schemaVersion: STATS_SCHEMA_VERSION,
      version: VERSION,
      updated_at: now,
      session_start: sessionStats.sessionStart,
      uptime_ms: now - sessionStats.sessionStart,
      total_calls: totalCalls,
      bytes_returned: totalReturned,
      bytes_indexed: sessionStats.bytesIndexed,
      bytes_sandboxed: sessionStats.bytesSandboxed,
      cache_hits: sessionStats.cacheHits,
      cache_bytes_saved: sessionStats.cacheBytesSaved,
      kept_out: keptOut,
      total_processed: totalProcessed,
      reduction_pct: reductionPct,
      tokens_saved: tokensSaved,
      // statusline-facing $ values — pre-computed at the current per-token
      // rate (dynamic when PI_CONTEXT_MODE_PRICE_OUTPUT_PER_TOKEN is set by a
      // Pi host; Opus $15/1M otherwise). Resolved on every persist via
      // pricePerToken() so the env override picks up without an MCP restart.
      dollars_saved_session: +(tokensSaved * pricePerToken()).toFixed(2),
      tokens_saved_lifetime: lifetimeTokens,
      dollars_saved_lifetime: +(lifetimeTokens * pricePerToken()).toFixed(2),
      by_tool: Object.fromEntries(
        Object.keys({ ...sessionStats.calls, ...sessionStats.bytesReturned }).map(
          (t) => [
            t,
            {
              calls: sessionStats.calls[t] || 0,
              bytes: sessionStats.bytesReturned[t] || 0,
            },
          ],
        ),
      ),
    };

    const filePath = getStatsFilePath();
    const tmpPath = `${filePath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, filePath);
  } catch {
    // best-effort — never break tool calls because of stats persistence
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
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
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
    // Security check failed — allow through (fail-open for server,
    // hooks are the primary enforcement layer)
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
    const policies = readBashPolicies(process.env.CLAUDE_PROJECT_DIR);
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
  _detectedAdapter: HookAdapter | null;
  _latestVersion: string | null;
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
  getDiagnosticAdapter: typeof getDiagnosticAdapter;
  getProjectDir: typeof getProjectDir;
  getRuntimeAwarePackageRoot: typeof getRuntimeAwarePackageRoot;
  getSessionDbPath: typeof getSessionDbPath;
  getSessionDir: typeof getSessionDir;
  getStatsFilePath: typeof getStatsFilePath;
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
  get _detectedAdapter() { return _detectedAdapter; },
  get _latestVersion() { return _latestVersion; },
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
  getDiagnosticAdapter,
  getProjectDir,
  getRuntimeAwarePackageRoot,
  getSessionDbPath,
  getSessionDir,
  getStatsFilePath,
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

  // MCP readiness sentinel path (#230, #347)
  // Uses process.pid (not ppid) — hooks use directory-scan to find any live sentinel.
  // Hardcoded /tmp on Unix to avoid TMPDIR mismatch (#347).
  const mcpSentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = join(mcpSentinelDir, `context-mode-mcp-ready-${process.pid}`);
  // #844: handle to the periodic sentinel refresh timer (started after connect).
  let sentinelRefresh: ReturnType<typeof setInterval> | undefined;

  // Clean up own DB + backgrounded processes + preload script on shutdown
  const shutdown = () => {
    executor.cleanupBackgrounded();
    if (_store) _store.close(); // persist DB for --continue sessions
    try { unlinkSync(CM_FS_PRELOAD); } catch { /* best effort */ }
    // Remove MCP readiness sentinel (#230)
    try { unlinkSync(mcpSentinel); } catch { /* best effort */ }
    // #844: stop refreshing the sentinel mtime on shutdown.
    if (sentinelRefresh) clearInterval(sentinelRefresh);
  };
  const gracefulShutdown = async () => {
    // Final stats flush — bypass throttle so the last 0-500ms of
    // bytes_indexed / bytes_returned aren't silently lost on SIGTERM/SIGINT
    // (PR #401 grill-me review B1: persistStats early-returns inside throttle
    // window; gracefulShutdown previously did NOT bypass).
    try {
      _lastStatsPersist = 0;
      persistStats();
    } catch { /* best effort — never block shutdown */ }
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
  // of accumulating under a long-lived Pi/omp parent. Best-effort; no stdin touch.
  attachMcpActivityTap(
    transport as unknown as { onmessage?: (message: unknown, extra?: unknown) => unknown },
  );

  // Write MCP readiness sentinel (#230)
  try { writeFileSync(mcpSentinel, String(process.pid)); } catch { /* best effort */ }

  // #844: refresh the sentinel mtime while the server is alive so readiness
  // probes from a foreign PID namespace (shared /tmp) can trust a recent
  // sentinel even when process.kill(pid, 0) cannot see this PID. The reader's
  // freshness window is 90s (hooks/core/mcp-ready.mjs); refresh at 30s (3x).
  // unref() so this timer never keeps the event loop alive on its own.
  sentinelRefresh = setInterval(() => {
    try { writeFileSync(mcpSentinel, String(process.pid)); } catch { /* best effort */ }
  }, 30_000);
  sentinelRefresh.unref();

  // Detect platform adapter — stored for platform-aware session paths
  try {
    const { detectPlatform, getAdapter } = await import("./adapters/detect.js");
    const clientInfo = server.server.getClientVersion();
    const signal = detectPlatform(clientInfo ?? undefined);
    _detectedAdapter = await getAdapter(signal.platform);
    if (clientInfo) {
      console.error(`MCP client: ${clientInfo.name} v${clientInfo.version} → ${signal.platform}`);
    }
  } catch { /* best effort — _detectedAdapter stays null, falls back to .claude */ }

  // Restore tool-call counters from SessionDB BEFORE the heartbeat fires
  // so the very first persistStats() carries the prior PID's totals into
  // the sidecar JSON the statusline reads. Otherwise `/ctx-upgrade` flashes
  // `0 calls / $0.00` until the user makes another MCP tool call. Wrapped
  // in try/catch — a stats-restore failure must never block server startup.
  try {
    const restored = restoreSessionStats(getSessionDbPath());
    if (restored) {
      for (const [tool, count] of Object.entries(restored.calls)) {
        sessionStats.calls[tool] = count;
      }
      for (const [tool, bytes] of Object.entries(restored.bytesReturned)) {
        sessionStats.bytesReturned[tool] = bytes;
      }
      // Anchor uptime_ms to the original session start so `/ctx-upgrade`
      // doesn't reset the "session age" the statusline shows.
      if (restored.sessionStart > 0) {
        sessionStats.sessionStart = restored.sessionStart;
      }
    }
  } catch { /* best effort — never block startup on a stats restore failure */ }

  // Non-blocking version check — result stored for trackResponse warnings.
  // First fetch at startup, then refresh every hour so long-running sessions
  // (some users keep the MCP server alive 24h+) catch new releases without a
  // restart. `.unref()` lets the process exit normally on SIGTERM regardless
  // of pending intervals.
  fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  setInterval(() => {
    fetchLatestVersion().then(v => { if (v !== "unknown") _latestVersion = v; });
  }, 60 * 60 * 1000).unref();

  // Stats heartbeat — keep the statusline truthful while the user works in
  // tools other than MCP (Bash/Read/Edit during long sessions or post-/compact
  // pauses). Without this, stats.updated_at only advances on MCP tool calls,
  // so bin/statusline.mjs falsely flips to "stale — restart to resume saving"
  // even though the server is alive. Heartbeat refreshes updated_at every 60s;
  // statusline staleness threshold is 30min (cliff is 30 missed ticks away).
  setInterval(() => persistStats(), 60_000).unref();

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

// Runs after every registerTool() above, so the SDK's default tools/list handler
// exists and can be wrapped. Makes ctx_* schemas safe for strict (Gemini
// function-calling) clients like Antigravity CLI (`agy`) / Gemini CLI.
installStrictClientSchemaCompat();

if (process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS !== "1") {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
