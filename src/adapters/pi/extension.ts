/**
 * Pi coding agent extension for context-mode.
 *
 * Follows the OpenClaw adapter pattern: imports shared session modules,
 * registers Pi-specific hooks. NO copy-paste of session logic.
 * NO external npm dependencies beyond what Pi runtime provides.
 *
 * Entry point: `export default function(pi: ExtensionAPI) { ... }`
 *
 * Lifecycle: session_start, tool_call, tool_result, before_agent_start,
 * session_before_compact, session_compact, session_shutdown.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSessionDbPath, SessionDB } from "../../session/db.js";
import type { ProjectAttribution } from "../../session/project-attribution.js";
import { extractEvents, extractUserEvents, parsePiUsage, buildAgentUsageEvent } from "../../session/extract.js";
import type { HookInput } from "../../session/extract.js";
import type { SessionEvent } from "../../types.js";
import { bootstrapMCPTools, makeBridgeDiag, isForegroundSession, type BridgeHandle } from "./mcp-bridge.js";
import { PiAdapter } from "./index.js";
import { PiCaptureBuffer } from "./capture.js";
import { PI_ROUTING_ANCHOR, omitRepeatedRouting } from "./context-routing.js";
import { autoMemoryMode, branchIds, graphObservation, historicalContext, leafId, readResume, recentBranchEvents, resultText, sourceAtEntry } from "./history.js";

// ── Pi Tool Name Mapping ─────────────────────────────────
// Pi uses lowercase; shared extractors expect PascalCase (Claude Code convention).
const PI_TOOL_MAP: Record<string, string> = {
  bash: "Bash",
  read: "Read",
  write: "Write",
  edit: "Edit",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
};

// ── Routing patterns ─────────────────────────────────────
// Inline HTTP client patterns to block in bash — self-contained, no routing module needed.
//
// Issue #625 — split into two classes so we can apply different policies:
//
//   * BLOCKED_HTTP_PATTERNS — language-level HTTP calls (fetch, requests, http,
//     urllib, Invoke-WebRequest). These always flood context with raw response
//     bodies, so they remain unconditionally blocked.
//
//   * curl / wget — handled separately by isSafeCurlWget() below. Mirrors the
//     reference logic in hooks/core/routing.mjs:660–722. Silent + file-output
//     forms are allowed as an MCP-down escape hatch (the body never enters
//     context). Unsafe forms (stdout, verbose, missing file output) still
//     block. This prevents an unrecoverable session trap when the bridge dies.
//
// Both are evaluated AFTER stripQuotedContent() so quoted CLI arguments
// (e.g. `gh issue list --search "curl wget"`) no longer false-positive.
const BLOCKED_HTTP_PATTERNS: RegExp[] = [
  /\bfetch\s*\(/,
  /\brequests\.get\s*\(/,
  /\brequests\.post\s*\(/,
  /\bhttp\.get\s*\(/,
  /\bhttp\.request\s*\(/,
  /\burllib\.request/,
  /\bInvoke-WebRequest\b/,
];

/**
 * Strip heredoc + single-quoted + double-quoted content from a shell command
 * so the routing regex only sees command tokens, not user-provided strings.
 *
 * Mirrors hooks/core/routing.mjs:196–209. Inlined here because the Pi
 * extension is bundled as a standalone build artifact (.pi/extensions/...)
 * and cannot import hooks/core/* at runtime — they live in a sibling tree
 * and may not be present in every Pi installation.
 *
 * Exported for unit tests.
 */
export function stripQuotedContent(cmd: string): string {
  return cmd
    .replace(/<<-?\s*["']?(\w+)["']?[\s\S]*?\n\s*\1/g, "") // heredocs
    .replace(/'[^']*'/g, "''") // single-quoted
    .replace(/"[^"]*"/g, '""'); // double-quoted
}

/**
 * Returns true iff `segment` is a curl/wget invocation that is SAFE to allow
 * through the Pi routing block — i.e. it cannot flood the model's context
 * window because the response body is written to disk (or appended to a file)
 * and no verbose/trace flag is dumping headers to stderr.
 *
 * Mirrors hooks/core/routing.mjs:672–701. Segments that are NOT curl/wget
 * return `true` (nothing to evaluate). The caller is expected to split chained
 * commands on `&&`, `||`, `;` and call this per segment.
 *
 * Issue #625 — without this, the only escape hatch when the MCP bridge dies
 * is `gh` CLI or a full Pi restart. Neither is acceptable as baseline UX.
 *
 * Exported for unit tests.
 */
export function isSafeCurlWget(segment: string): boolean {
  const s = segment.trim();
  const isCurl = /\bcurl\b/i.test(s);
  const isWget = /\bwget\b/i.test(s);
  if (!isCurl && !isWget) return true; // not curl/wget — nothing to evaluate

  // Check for file output flags (-o file / --output file for curl,
  // -O file / --output-document file for wget) OR shell redirection (> / >>).
  const hasFileOutput = isCurl
    ? /\s(-o|--output)\s/.test(s) || /\s>\s*/.test(s) || /\s>>\s*/.test(s)
    : /\s(-O|--output-document)\s/.test(s) ||
      /\s>\s*/.test(s) ||
      /\s>>\s*/.test(s);
  if (!hasFileOutput) return false; // no file output → body flows to stdout

  // Stdout aliases: -o -, -o /dev/stdout, -O -, -O /dev/stdout.
  if (isCurl && /\s(-o|--output)\s+(-|\/dev\/stdout)(\s|$)/.test(s))
    return false;
  if (isWget && /\s(-O|--output-document)\s+(-|\/dev\/stdout)(\s|$)/.test(s))
    return false;

  // Verbose/trace flags dump request+response headers to stderr → context.
  if (/\s(-v|--verbose|--trace)\b/.test(s)) return false;

  // Must be silent (curl: -s/--silent, wget: -q/--quiet) so the progress bar
  // does not spill into stderr → context.
  const isSilent = isCurl
    ? /\s-[a-zA-Z]*s|--silent/.test(s)
    : /\s-[a-zA-Z]*q|--quiet/.test(s);
  return isSilent;
}

// ── Module-level DB singleton ────────────────────────────

let _db: SessionDB | null = null;
let _dbPath = "";
let _sessionId = "";

// MCP bridge handle. The bridge spawns server.bundle.mjs once and
// registers each MCP tool through pi.registerTool() so the Pi LLM can
// actually call ctx_execute / ctx_search / etc. (#426). Pi 0.73.x has
// no native MCP support, so without this bridge the tools are
// invisible to the LLM and the routing block is dead weight.
let _mcpBridge: BridgeHandle | null = null;

/**
 * Settles when the MCP bridge bootstrap has finished — resolves on
 * success AND on failure (the bootstrap is best-effort; failures are
 * logged to stderr but never propagated). Exposed for tests so they
 * can `await` the wiring deterministically without relying on internal
 * timing or `setImmediate` polling.
 *
 * Starts as an already-settled promise because the bridge is now bootstrapped
 * lazily from `before_agent_start`, not during extension discovery.
 */
export let _mcpBridgeReady: Promise<void> = Promise.resolve();

// Request-local state, checked against the session and branch again at delivery.
let _pendingContext: { text: string; sessionId: string; entryId: string | null; resume?: string } | null = null;

// ── Helpers ──────────────────────────────────────────────

// Single PiAdapter instance — owns the canonical session-dir contract
// (~/.pi/context-mode/sessions). Routing the extension through it means
// any future segment change in PiAdapter (or BaseAdapter) propagates
// here automatically instead of silently desyncing (#473 round-3).
const _piAdapter = new PiAdapter();

function getSessionDir(): string {
  const dir = _piAdapter.getSessionDir();
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Issue #645 — the MCP server (src/server.ts ctx_stats / ctx_search
// timeline) resolves the SessionDB filename via
// `resolveSessionDbPath({ projectDir, sessionsDir })`, which produces a
// per-project canonical `<16-hex-hash>.db` (case-folded on darwin/win32,
// suffixed for non-main worktrees). The Pi extension previously wrote
// every session to a shared `context-mode.db` literal — a different
// file the server never reads. The result was silent degradation of
// `ctx_stats` (zero history) and `ctx_search(sort: "timeline")` (sort
// dropped) for every Pi user. Routing through the same helper keeps the
// extension-side writes and the server-side reads aligned across
// case-fold migrations, worktree suffixes, and any future change to the
// canonical filename contract.
function getDBPath(projectDir: string): string {
  return resolveSessionDbPath({ projectDir, sessionsDir: getSessionDir() });
}

function getOrCreateDB(projectDir: string): SessionDB {
  // Reopen the singleton if the resolved DB path changes. Production code
  // normally loads the extension once per process with a single workspace,
  // but defensive re-keying on path keeps the contract honest if a host
  // ever calls piExtension(pi) twice with different projectDirs, and
  // removes a subtle test-isolation foot-gun where stale singletons
  // pointed at a prior test's `<hash>.db`. (#645)
  const dbPath = getDBPath(projectDir);
  if (!_db || _dbPath !== dbPath) {
    if (_db) {
      try { _db.close(); } catch { /* best effort */ }
    }
    _db = new SessionDB({ dbPath });
    _dbPath = dbPath;
  }
  return _db;
}

/** Derive a stable session ID from Pi's session file path (SHA256, 16 hex chars). */
function deriveSessionId(ctx: Record<string, unknown>): string {
  try {
    const sessionManager = ctx.sessionManager as
      | { getSessionFile?: () => string }
      | undefined;
    const sessionFile = sessionManager?.getSessionFile?.();
    if (sessionFile && typeof sessionFile === "string") {
      return createHash("sha256").update(sessionFile).digest("hex").slice(0, 16);
    }
  } catch {
    // best effort
  }
  return `pi-${Date.now()}`;
}

/**
 * Parse SessionDB timestamps as UTC. SQLite datetime('now') returns
 * "YYYY-MM-DD HH:MM:SS" in UTC without a timezone suffix; JavaScript parses
 * that shape as local time, which skews ages by the local UTC offset.
 */
function parseSessionTimestampMs(value: string): number {
  const trimmed = value.trim();
  const sqliteUtc = trimmed.match(
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/,
  );
  const normalized = sqliteUtc
    ? `${sqliteUtc[1]}T${sqliteUtc[2]}${sqliteUtc[3] ?? ""}Z`
    : trimmed;
  return Date.parse(normalized);
}

/** Build stats text for the /ctx-stats command. */
function buildStatsText(db: SessionDB, sessionId: string): string {
  try {
    const events = db.getEvents(sessionId);
    const stats = db.getSessionStats(sessionId);
    const lines: string[] = [
      "## context-mode stats (Pi)",
      "",
      `- Session: \`${sessionId.slice(0, 8)}...\``,
      `- Events captured: ${events.length}`,
      `- Compactions: ${stats?.compact_count ?? 0}`,
    ];

    // Event breakdown by category
    const byCategory: Record<string, number> = {};
    for (const ev of events) {
      const key = ev.category ?? "unknown";
      byCategory[key] = (byCategory[key] ?? 0) + 1;
    }
    if (Object.keys(byCategory).length > 0) {
      lines.push("- Event breakdown:");
      for (const [category, count] of Object.entries(byCategory)) {
        lines.push(`  - ${category}: ${count}`);
      }
    }

    // Session age
    if (stats?.started_at) {
      const startedMs = parseSessionTimestampMs(stats.started_at);
      if (Number.isFinite(startedMs)) {
        const ageMinutes = Math.round((Date.now() - startedMs) / 60_000);
        lines.push(`- Session age: ${ageMinutes}m`);
      }
    }

    return lines.join("\n");
  } catch {
    return "context-mode stats unavailable (session DB error)";
  }
}

function resolveCommandContext(argsOrCtx: unknown, ctx: unknown): any {
  if (ctx !== undefined) return ctx;
  if (argsOrCtx && typeof argsOrCtx === "object") return argsOrCtx;
  return undefined;
}

function handleCommandText(
  text: string,
  ctx: any,
): { text: string } | undefined {
  if (ctx?.hasUI) {
    ctx.ui.notify(text, "info");
    return;
  }

  return { text };
}

// ── Pi MCP bridge lazy bootstrap (#534, #809) ───────────
//
// Pi loads extensions in several CLI paths that never dispatch an agent turn:
// top-level help/version, package management (`install`, `list`, ...), config,
// metadata commands, and project-trust probing. Bootstrapping the MCP bridge
// during extension discovery is therefore the wrong signal: there may be no
// real agent lifecycle and no `session_shutdown` cleanup. That caused both the
// #534 short-lived help/version orphan class and the #809 package-command hang
// (the bridge child's stdio handles kept Pi alive after `install`/`list`).
//
// The robust signal is Pi's agent lifecycle itself. `before_agent_start` fires
// only for invocations that are about to dispatch a model call, including
// print-mode subagents (`pi --mode json -p --no-session`). We start and await
// the bridge from that hook so ctx_* tools are present before Pi snapshots the
// tool registry, while CLI-only commands never spawn a bridge at all.

function startPiMCPBridge(
  pi: any,
  serverBundle: string,
  shouldKeepHandle: () => boolean,
  foreground: boolean,
): Promise<void> {
  if (existsSync(serverBundle)) {
    _mcpBridgeReady = bootstrapMCPTools(pi, serverBundle, { foreground }).then(
      (handle) => {
        if (shouldKeepHandle()) {
          _mcpBridge = handle;
        } else {
          // Bootstrap completed after this extension registration had already
          // shut down or superseded the attempt. Do not publish a stale handle;
          // immediately reclaim the child that bootstrap just spawned.
          try {
            handle.shutdown();
          } catch {
            // best effort — never throw from best-effort bridge cleanup
          }
        }
      },
      (err: unknown) => {
        if (!shouldKeepHandle()) return;
        const msg = err instanceof Error ? err.message : String(err);
        // #868: route to Pi's file logger, never process.stderr (raw-mode TUI).
        makeBridgeDiag(pi)(
          `[context-mode] WARNING: failed to bridge MCP tools to Pi (${msg}). ` +
            `ctx_* tools will not be callable from this session.`,
        );
      },
    );
  } else {
    // No bundle on disk → nothing to await. Tests can still rely on
    // _mcpBridgeReady being a settled promise.
    _mcpBridgeReady = Promise.resolve();
  }

  return _mcpBridgeReady;
}

/**
 * Issue #545 — Pi workspace resolver.
 *
 * Pi's runtime sets PI_CONFIG_DIR to ~/.pi (its CONFIG dir, not the user's
 * project). The extension previously used this as the project anchor, which
 * meant every Pi session re-rooted under ~/.pi — collapsing all of a user's
 * projects into a single phantom workspace. This helper picks the user's
 * actual project directory while NEVER returning a path equal to or under
 * ~/.pi/.
 *
 * Cascade:
 *   1. PI_WORKSPACE_DIR — set by Pi's bridge (extension-set, freshest)
 *   2. PI_PROJECT_DIR   — legacy/user override
 *   3. PWD              — shell-set, survives process.chdir
 *   4. cwd              — last resort
 *
 * Each candidate is rejected if it equals ~/.pi or lives under ~/.pi/. If
 * every candidate is poisoned, falls back to homedir() as a safe non-config
 * anchor — caller may still render a "no project context" notice but the
 * function stays total.
 */
export function resolvePiWorkspaceDir(opts: {
  env: Record<string, string | undefined>;
  pwd: string | undefined;
  cwd: string;
  /** Optional override for tests; defaults to `os.homedir()`. */
  home?: string;
}): string {
  const home = opts.home ?? homedir();
  const piConfigDir = join(home, ".pi");
  const isUnderPi = (p: string | undefined): boolean => {
    if (!p) return true;
    if (p === piConfigDir) return true;
    // Match both POSIX (/) and Windows (\) child-of relations.
    return p.startsWith(piConfigDir + "/") || p.startsWith(piConfigDir + "\\");
  };
  const candidates = [
    opts.env.PI_WORKSPACE_DIR,
    opts.env.PI_PROJECT_DIR,
    opts.pwd,
    opts.cwd,
  ];
  for (const c of candidates) {
    if (c && !isUnderPi(c)) return c;
  }
  return home;
}

// ── Extension entry point ────────────────────────────────

/** Pi extension default export. Called once by Pi runtime with the extension API. */
export default function piExtension(pi: any): void {
  const buildDir = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = resolve(buildDir, "..", "..", "..");
  const serverBundle = resolve(pluginRoot, "server.bundle.mjs");
  let mcpBridgeStarted = false;
  let mcpBridgeGeneration = 0;
  const ensureMCPBridge = (foreground: boolean): Promise<void> => {
    if (mcpBridgeStarted) return _mcpBridgeReady;
    mcpBridgeStarted = true;
    const generation = ++mcpBridgeGeneration;
    return startPiMCPBridge(
      pi,
      serverBundle,
      () => mcpBridgeStarted && mcpBridgeGeneration === generation,
      foreground,
    );
  };
  // Issue #545 — Pi workspace resolver. PI_CONFIG_DIR is Pi's CONFIG dir
  // (~/.pi), NOT the user's workspace; using it as the project anchor
  // collapsed every Pi session into a single phantom workspace. The
  // dedicated resolver picks PI_WORKSPACE_DIR > PI_PROJECT_DIR > PWD > cwd
  // and refuses to return any path under ~/.pi/.
  const projectDir = resolvePiWorkspaceDir({
    env: process.env,
    pwd: process.env.PWD,
    cwd: process.cwd(),
  });

  // Attribution object for project isolation — ensures every event recorded
  // by the pi adapter carries the correct project_dir. Without this, all
  // events default to project_dir="" which causes cross-project data leakage
  // in shared SessionDB instances.
  const _attribution: Partial<ProjectAttribution> = { projectDir, source: "workspace_root", confidence: 0.98 };

  const db = getOrCreateDB(projectDir);
  const captures = new PiCaptureBuffer((capture, entryId) => {
    const source = sourceAtEntry(capture.hook, entryId, capture.toolCallId, capture.parentToolCallId);
    for (const event of capture.events) {
      db.insertEvent(capture.sessionId, event, source, _attribution, undefined, { dedupBySource: true });
    }
  });

  // ── 1. session_start — Initialize session ──────────────

  pi.on("session_start", (_event: any, ctx: any) => {
    try {
      captures.flush(ctx, _sessionId, true, false);
      _pendingContext = null;
      _sessionId = deriveSessionId(ctx ?? {});
      db.ensureSession(_sessionId, projectDir);
      db.cleanupOldSessions(7);
    } catch {
      // best effort — never break session start
      if (!_sessionId) {
        _sessionId = `pi-${Date.now()}`;
      }
    }
  });

  // ── 2. tool_call — PreToolUse routing enforcement ──────
  // Block bash commands that contain curl/wget/fetch/requests patterns.

  pi.on("tool_call", (event: any) => {
    try {
      const toolName = String(event?.toolName ?? "").toLowerCase();
      if (toolName !== "bash") return;

      const command = String(event?.input?.command ?? "");
      if (!command) return;

      // Issue #625 — strip quoted content first so words like `curl` inside
      // a `gh issue list --search "...curl..."` argument do not false-positive.
      const stripped = stripQuotedContent(command);

      // Language-level HTTP calls (fetch, requests, http, urllib,
      // Invoke-WebRequest) always flood context — block unconditionally.
      if (BLOCKED_HTTP_PATTERNS.some((p) => p.test(stripped))) {
        return {
          block: true,
          reason:
            "Use context-mode MCP tools (execute, fetch_and_index) instead of inline HTTP clients. " +
            "Raw fetch/requests/http output floods the context window.",
        };
      }

      // curl / wget — split chained command on &&, ||, ; and evaluate each
      // segment with isSafeCurlWget(). Allowed if EVERY curl/wget segment is
      // silent + file-output + no verbose + no stdout alias. This preserves
      // the "do not flood context" intent while leaving a recovery path open
      // when the MCP bridge is unreachable.
      if (/(^|\s|&&|\||\;)(curl|wget)\s/i.test(stripped)) {
        const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/);
        const hasUnsafeSegment = segments.some((seg) => !isSafeCurlWget(seg));
        if (hasUnsafeSegment) {
          return {
            block: true,
            reason:
              "Use context-mode MCP tools (execute, fetch_and_index) instead of inline HTTP clients. " +
              "Raw curl/wget output floods the context window. " +
              "For an MCP-down escape hatch, use silent + file output: " +
              "`curl -s -o /tmp/x.json URL` or `wget -q -O /tmp/x.json URL`.",
          };
        }
      }
    } catch {
      // Routing failure — allow passthrough
    }
  });

  // ── 3. tool_result — PostToolUse event capture ─────────

  pi.on("tool_result", (event: any, ctx: any) => {
    try {
      if (!_sessionId) return;

      const rawToolName = String(event?.toolName ?? event?.tool_name ?? "");
      let mappedToolName =
        PI_TOOL_MAP[rawToolName.toLowerCase()] ?? rawToolName;

      // Pi namespaces MCP-registered tools with the "context_mode_" prefix;
      // the extract functions expect the "mcp__" prefix for MCP tool calls.
      if (/^context_mode_/.test(rawToolName)) {
        mappedToolName = rawToolName.replace(/^context_mode_/, "mcp__context_mode__");
      } else if (/^ctx_/.test(rawToolName)) {
        mappedToolName = `mcp__context_mode__${rawToolName}`;
      }

      captures.flush(ctx, _sessionId);
      const resultStr = resultText(event);

      // Detect errors
      const hasError = Boolean(event?.error || event?.isError);

      // Pi sends file tool parameters as "path"; the extract functions
      // expect "file_path" (Claude Code convention). Normalise before
      // passing to extractEvents so file reads/writes/edits are tracked.
      const rawInput = { ...(event?.input ?? event?.params ?? event?.tool_input ?? {}) };
      if (rawInput.path !== undefined && rawInput.file_path === undefined) {
        rawInput.file_path = String(rawInput.path);
      }

      const hookInput: HookInput = {
        tool_name: mappedToolName,
        tool_input: rawInput,
        tool_response: resultStr,
        tool_output: hasError ? { isError: true } : undefined,
      };

      const events = extractEvents(hookInput);

      if (/^graph_/.test(rawToolName)) {
        const data = graphObservation(rawToolName, event, resultStr);
        events.push({ type: "graph_result", category: "pi", data, priority: 2 });
      } else if (!events.length && rawToolName) {
        // Fallback: record a bounded unrecognized tool call.
        const data = JSON.stringify({
          tool: rawToolName,
          params: JSON.stringify(event?.input ?? event?.params ?? {}).slice(0, 2048),
        });
        events.push({
          type: "tool_call",
          category: "pi",
          data,
          priority: 1,
        });
      }
      captures.enqueue({ sessionId: _sessionId, events, hook: "PostToolUse",
        toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined,
        parentToolCallId: typeof event?.parentToolCallId === "string" ? event.parentToolCallId : undefined,
      }, ctx);
      // Older hosts without ids retain searchable observations, without guessing
      // a branch anchor from the previous leaf.
      captures.flush(ctx, _sessionId);
    } catch {
      // Silent — session capture must never break the tool call
    }
  });

  // ── 4. before_agent_start — Routing + active_memory + resume injection ─

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    try {
      _pendingContext = null;
      // Lazily start and await the MCP bridge only when Pi is about to
      // dispatch a real agent turn. This is the non-brittle #534/#809 guard:
      // help/version/package/config CLI paths may load the extension, but they
      // never fire before_agent_start, so they never spawn server.bundle.mjs.
      // Subagents (`pi --mode json -p --no-session`) do fire this hook; awaiting
      // here ensures ctx_* tools are registered before Pi snapshots the tool
      // registry for the model call. Resolves on bootstrap failure too — the
      // bridge is best-effort.
      //
      // #868: the FOREGROUND interactive session's bridge child is spawned with
      // the #854 idle reaper disabled (via ctx.hasUI), so a multi-minute human
      // pause never drops its ctx_* tools. Subagents (hasUI:false) keep the
      // reaper so abandoned children can't accumulate (#854).
      //
      // INVARIANT — deciding foreground on the FIRST before_agent_start is safe
      // even though the bridge spawns single-flight (first-wins, no sticky
      // latch): Pi wires the interactive uiContext inside `mode.init()`, which
      // main.ts AWAITS before dispatching the first prompt — and
      // before_agent_start is emitted only from the per-turn prompt path. So the
      // foreground session's first hook ALWAYS observes hasUI:true; subagents are
      // provably hasUI:false. There is no early-init window where the foreground
      // transiently reads hasUI:false (that window is scoped to a separate,
      // buffered credential event). Do NOT add a latch here — it would guard an
      // unreachable state. (Verified against oh-my-pi: main.ts init→prompt order,
      // interactive-mode.ts uiContext wiring, executor.ts subagent hasUI:false.)
      await ensureMCPBridge(isForegroundSession(ctx));

      if (!_sessionId) return;

      const prompt = String(event?.prompt ?? "");

      // before_agent_start precedes user persistence. Never assign the new
      // prompt to the old leaf; context will bind it to the actual user entry.
      captures.flush(ctx, _sessionId, true);
      if (prompt) captures.enqueue({ sessionId: _sessionId, events: extractUserEvents(prompt),
        hook: "UserPromptSubmit", prompt,
      }, ctx);

      const parts = [PI_ROUTING_ANCHOR];
      const mode = autoMemoryMode();
      let resumeSnapshot: string | undefined;
      if (mode !== "off") {
        const resume = db.getResume(_sessionId);
        const scopedResume = resume && !resume.consumed ? readResume(resume.snapshot, _sessionId, ctx) : null;
        if (scopedResume) {
          parts.push(scopedResume.context);
          resumeSnapshot = resume!.snapshot;
        } else if (mode === "always") {
          // The DB has a 1000-event hard session cap. Filter branch provenance
          // before selecting the latest 50; shared DB ordering stays unchanged.
          const events = recentBranchEvents(db.getEvents(_sessionId), ctx, 3);
          const memory = historicalContext(events, _sessionId, "active_memory");
          if (memory) parts.push(memory);
        }
      }
      _pendingContext = { text: parts.join("\n\n"), sessionId: _sessionId, entryId: leafId(ctx), resume: resumeSnapshot };
    } catch {
      _pendingContext = null;
      // best effort — never break agent start
    }
  });

  // Append a typed extension message without changing the cached system prompt.
  // Pi converts custom messages for providers; the text itself therefore also
  // identifies history as observations, never current user authority.
  pi.on("context", (event: any, ctx: any) => {
    try {
      captures.flush(ctx, _sessionId);
      let pending = _pendingContext;
      _pendingContext = null;
      // Overflow recovery can compact and agent.continue() within the same run,
      // without another before_agent_start. Deliver its scoped resume here too.
      if (!pending && _sessionId && autoMemoryMode() !== "off") {
        const resume = db.getResume(_sessionId);
        const scoped = resume && !resume.consumed ? readResume(resume.snapshot, _sessionId, ctx) : null;
        if (scoped) pending = { text: `${PI_ROUTING_ANCHOR}\n\n${scoped.context}`,
          sessionId: _sessionId, entryId: leafId(ctx), resume: resume!.snapshot };
      }
      if (!pending || pending.sessionId !== _sessionId) return;
      if (pending.entryId && !branchIds(ctx).has(pending.entryId)) return;
      const text = omitRepeatedRouting(pending.text, event.messages);
      if (!text) return;
      event.messages.push({
        role: "custom", customType: "context-mode-history", content: text,
        display: false, timestamp: Date.now(),
        details: { source: "context-mode", sessionId: _sessionId, entryId: pending.entryId },
      });
      // Consume only after delivery and only the same snapshot we prepared.
      if (pending.resume && db.getResume(_sessionId)?.snapshot === pending.resume) db.markResumeConsumed(_sessionId);
      return { messages: event.messages };
    } catch {
      // best effort — never break context assembly
    }
  });

  pi.on("session_tree", (_event: any, ctx: any) => {
    captures.flush(ctx, _sessionId, true, false);
    _pendingContext = null;
  });
  pi.on("agent_end", (_event: any, ctx: any) => { captures.flush(ctx, _sessionId, true); });

  // ── 4b. before_provider_response — capture response metadata ───
  // Pi-2: Register the missing event so providers can record latency,
  // model, and token usage when Pi exposes them. Best-effort only;
  // the handler must never throw or modify the response.

  pi.on("before_provider_response", (event: any) => {
    try {
      if (!_sessionId) return;
      const meta = {
        model: event?.model ?? event?.providerModel,
        provider: event?.provider,
        latencyMs: event?.latencyMs ?? event?.latency,
        tokens: event?.usage ?? event?.tokens,
      };
      // Skip when Pi gives us nothing useful — avoids noise in the DB.
      if (
        meta.model == null &&
        meta.provider == null &&
        meta.latencyMs == null &&
        meta.tokens == null
      ) {
        return;
      }
      const data = JSON.stringify(meta);
      db.insertEvent(
        _sessionId,
        {
          type: "provider_response",
          category: "pi",
          data,
          priority: 1,
          data_hash: createHash("sha256").update(data).digest("hex").slice(0, 16),
        },
        "PostToolUse", _attribution,
      );
    } catch {
      // best effort — never break provider response
    }
  });

  // ── 4c. turn_end — per-turn token + native-USD cost capture ───
  //
  // Pi delivers per-turn usage on TurnEndEvent.message (an AssistantMessage):
  // usage.{input,output,cacheRead,cacheWrite} + native usage.cost.total in USD,
  // with model on .model. Usage is per-turn incremental, so each turn_end maps
  // to exactly one structured `agent_usage` (category "cost") event — the same
  // shape the Claude Code Stop path emits via buildAgentUsageEvent. We pass
  // Pi's native cost as native_cost_usd so the builder trusts the source over
  // the local price table (cost_confidence: HIGH — no price-table maintenance).
  //
  // Refs: adapter-matrix/pi.md @320261f — shared-events.ts:204-209 (TurnEndEvent),
  // ai/src/types.ts:510/521 (model/usage), catalog/src/types.ts:100-145 (Usage).
  // Best-effort: parse is null-safe and the handler never throws (a telemetry
  // forwarder must never break the agent turn).
  pi.on("turn_end", (event: any, ctx: any) => {
    try {
      if (!_sessionId) return;
      captures.flush(ctx, _sessionId);
      const counts = parsePiUsage(event);
      if (!counts) return; // non-assistant turn or all-zero usage
      const ev = buildAgentUsageEvent(counts);
      if (!ev) return;
      // db.insertEvent is the extension-side analog of the .mjs hooks'
      // attributeAndInsertEvents (insert + project attribution). The MCP
      // server forwards persisted agent_usage events to the platform.
      db.insertEvent(_sessionId, ev as SessionEvent, "Stop", _attribution);
    } catch {
      // best effort — never break the agent turn
    }
  });

  // Native compaction owns the actual summary. Build a small, scoped history
  // only after it succeeds; failed/aborted preparation cannot produce a resume.
  pi.on("session_before_compact", (_event: any, ctx: any) => {
    captures.flush(ctx, _sessionId);
    _pendingContext = null;
  });
  pi.on("session_compact", (event: any, ctx: any) => {
    try {
      if (!_sessionId) return;
      _pendingContext = null;
      captures.flush(ctx, _sessionId);
      db.incrementCompactCount(_sessionId);
      if (autoMemoryMode() === "off") return;
      const entryId = event?.compactionEntry?.id ?? leafId(ctx);
      if (typeof entryId !== "string" || !branchIds(ctx).has(entryId)) return;
      const events = recentBranchEvents(db.getEvents(_sessionId), ctx, 1);
      const context = historicalContext(events, _sessionId, "session_resume");
      if (!context) return;
      db.upsertResume(_sessionId, JSON.stringify({ version: 1, sessionId: _sessionId, entryId, context }), events.length);
    } catch {
      // best effort — native compaction remains authoritative
    }
  });

  // ── 7. session_shutdown — Cleanup old sessions ─────────

  pi.on("session_shutdown", async (_event: any, ctx: any) => {
    try {
      captures.flush(ctx, _sessionId, true);
      if (_db) {
        _db.cleanupOldSessions(7);
      }
      _db = null;
      _dbPath = "";
      _sessionId = "";
      _pendingContext = null;
    } catch {
      // best effort — never throw during shutdown
    }
    // Race fix (#472 round-3 + #809 lazy follow-up): if shutdown fires while
    // bridge bootstrap is still in flight, _mcpBridge may be null at this
    // point. Invalidate this bootstrap generation before waiting so any handle
    // that resolves after the 2s ceiling self-shuts down instead of publishing
    // a stale child handle after session shutdown.
    mcpBridgeGeneration++;
    mcpBridgeStarted = false;
    try {
      await Promise.race([
        _mcpBridgeReady,
        new Promise<void>((r) => setTimeout(r, 2000).unref()),
      ]);
    } catch {
      // _mcpBridgeReady never rejects (best-effort), but defensively
      // swallow anyway so shutdown never throws.
    }
    if (_mcpBridge) {
      try {
        _mcpBridge.shutdown();
      } catch {
        // best effort — never throw during shutdown
      }
      _mcpBridge = null;
    }
    _mcpBridgeReady = Promise.resolve();
  });

  // ── 8. Slash commands ──────────────────────────────────

  pi.registerCommand("ctx-stats", {
    description: "Show context-mode session statistics",
    handler: async (argsOrCtx: unknown, maybeCtx: unknown) => {
      const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
      const text =
        !_db || !_sessionId
          ? "context-mode: no active session"
          : buildStatsText(_db, _sessionId);

      return handleCommandText(text, ctx);
    },
  });

  pi.registerCommand("ctx-doctor", {
    description: "Run context-mode diagnostics",
    handler: async (argsOrCtx: unknown, maybeCtx: unknown) => {
      const ctx = resolveCommandContext(argsOrCtx, maybeCtx);
      const dbPath = getDBPath(projectDir);
      const dbExists = existsSync(dbPath);
      const lines: string[] = [
        "## ctx-doctor (Pi)",
        "",
        `- DB path: \`${dbPath}\``,
        `- DB exists: ${dbExists}`,
        `- Session ID: \`${_sessionId ? _sessionId.slice(0, 8) + "..." : "none"}\``,
        `- Plugin root: \`${pluginRoot}\``,
        `- Project dir: \`${projectDir}\``,
      ];

      if (_db && _sessionId) {
        try {
          const stats = _db.getSessionStats(_sessionId);
          const eventCount = _db.getEventCount(_sessionId);
          lines.push(`- Events: ${eventCount}`);
          lines.push(`- Compactions: ${stats?.compact_count ?? 0}`);
          const resume = _db.getResume(_sessionId);
          lines.push(
            `- Resume snapshot: ${resume ? (resume.consumed ? "consumed" : "available") : "none"}`,
          );
        } catch {
          lines.push("- DB query error");
        }
      }

      const text = lines.join("\n");
      return handleCommandText(text, ctx);
    },
  });

  // ── 9. MCP tool bridge (#426) ───────────────────────────
  //
  // Intentionally no eager bootstrap here. `before_agent_start` is the first
  // lifecycle signal that proves Pi is about to run a model call; starting the
  // bridge there keeps ctx_* available for real agent turns while package/help
  // commands that only load extensions never spawn a long-lived child (#809).
  _mcpBridgeReady = Promise.resolve();
}
