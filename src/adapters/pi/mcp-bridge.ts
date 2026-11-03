/**
 * MCP-stdio bridge for the Pi Coding Agent extension.
 *
 * Pi 0.73.x has no native MCP support — its README is explicit:
 *   > "No MCP. Build CLI tools with READMEs (see Skills), or build an
 *   >  extension that adds MCP support."
 *
 * Without this bridge, the routing block tells the LLM to call
 * `ctx_execute`, `ctx_search`, etc. — but those tools never enter Pi's
 * tool list, so the LLM cannot reach them. context-mode then becomes a
 * pure cost on Pi (~2.5K tokens of system-prompt overhead with 0
 * actual ctx_* calls). Reported in mksglu/context-mode#426.
 *
 * The bridge spawns `server.bundle.mjs` as a long-lived child via stdio
 * JSON-RPC, performs the MCP handshake, calls `tools/list` once, and
 * registers each returned tool through `pi.registerTool({ … })`. Each
 * tool's `execute()` forwards into the child via `tools/call` — same
 * code path Claude Code, Gemini CLI, and the other adapters use, so
 * Pi behavior matches the rest of the platform suite.
 *
 * No external dependencies — pure node:child_process + JSON line frames.
 */

import { piToolMetadata } from "./tool-metadata.js";
import {
  MCPStdioClient, resolveJsRuntimeForBridge, BRIDGE_DEPTH_ENV,
  type MCPCallResult, type BridgeDiag,
} from "./mcp-client.js";
import {
  createContextModeCallRenderer, createContextModeResultRenderer,
  type PiRenderTheme, type PiRenderContext,
} from "./mcp-render.js";

// Preserve the existing bridge public entry while implementations remain independent.
export { MCPStdioClient, resolveJsRuntimeForBridge, splitDiagLines } from "./mcp-client.js";
export type { MCPTool, MCPCallResult, ResolveDeps, BridgeDiag } from "./mcp-client.js";
export { PiTextComponent, truncateAnsiLine } from "./mcp-render.js";

// Retry budget for the bridge bootstrap `initialize` handshake (#647).
//
// On cold NFS home dirs, first JIT compile of server.bundle.mjs, or
// constrained CI runners, the first `initialize` can exceed the 60s
// ceiling above. Before this fix, bootstrapMCPTools propagated the
// rejection up to extension.ts, which logged once and continued with
// NO ctx_* tools registered — silently degrading the session for its
// entire lifetime while the routing block kept emitting ~2.5K tokens
// of dead instructions per turn.
//
// Retry pattern mirrors the existing #583 single-flight respawn shape:
// on failure, shut the prior child cleanly, sleep a short backoff so
// the OS reclaims fds, then start + initialize again. After the budget
// is exhausted we re-throw and the existing extension.ts handler runs
// the degrade-and-log path — preserving the contract for genuinely
// broken servers (binary missing, runtime crash, etc.) while
// self-healing the transient warm-up case.
const MAX_INIT_RETRIES = 2;
const INIT_RETRY_DELAY_MS = 1_000;

/**
 * Subset of the Pi ExtensionAPI we touch. Typed structurally so we don't
 * pull `@earendil-works/pi-coding-agent` as a build dependency — keeps
 * the bundle size unchanged and matches the existing pi-extension.ts
 * style (which also types `pi` as `any`).
 */
export interface PiToolRegistration {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  exposure?: "direct" | "deferred";
  renderCall?: (
    args: unknown,
    theme: PiRenderTheme,
    context: PiRenderContext,
  ) => unknown;
  renderResult?: (
    result: MCPCallResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: PiRenderTheme,
    context: PiRenderContext,
  ) => unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
    isError?: boolean;
  }>;
}

export interface PiLikeAPI {
  registerTool: (tool: PiToolRegistration) => void;
  getActiveTools?: () => string[];
  getAllTools?: () => Array<{ name: string; reachesTools?: unknown }>;
  /**
   * Pi's rotating file logger (`~/.omp/logs/`). Pi runs a raw-mode TUI that
   * owns the terminal, so an in-process extension MUST NOT write to
   * process.stdout/stderr — any console write is rendered straight into the
   * editor input box and blocks typing (#868, confirmed against
   * oh-my-pi tui/terminal.ts raw-mode + docs/skills/authoring-extensions.md:
   * "nothing is written to the console, which would corrupt the TUI"). All
   * bridge diagnostics route here instead. Optional: absent in tests / minimal
   * hosts, in which case diagnostics are dropped — we NEVER fall back to the
   * terminal.
   */
  logger?: {
    debug?: (message: string, context?: Record<string, unknown>) => void;
    info?: (message: string, context?: Record<string, unknown>) => void;
    warn?: (message: string, context?: Record<string, unknown>) => void;
    error?: (message: string, context?: Record<string, unknown>) => void;
  };
}

/**
 * Build a {@link BridgeDiag} bound to a Pi host's file logger (#868). Writing to
 * process.stderr from inside Pi's raw-mode TUI corrupts the editor, so every
 * bridge diagnostic — the forwarded MCP child stderr included — goes to
 * `pi.logger` instead. When no logger is reachable (tests, non-Pi hosts) the
 * line is dropped; we never touch the terminal as a fallback.
 */
export function makeBridgeDiag(pi: PiLikeAPI | null | undefined): BridgeDiag {
  const logger = pi?.logger;
  return (line, level = "warn") => {
    try {
      const fn = level === "debug" ? logger?.debug : logger?.warn;
      if (typeof fn === "function") fn(line);
    } catch {
      /* never throw from diagnostics — and never write to the TUI terminal */
    }
  };
}

/**
 * #868: is this the FOREGROUND interactive Pi session (vs a subagent / print /
 * RPC session)? Pi passes an ExtensionContext as the 2nd arg to
 * `before_agent_start`; `ctx.hasUI === true` only for the interactive session
 * with a real UI attached (refs oh-my-pi runner.ts:330-331), while subagents
 * are provably `hasUI: false` (refs executor.ts:2052). Fail-safe: treat anything
 * that is NOT an explicit `hasUI === false` as foreground, so an
 * ambiguous/absent ctx keeps the session's bridge ALIVE rather than risking the
 * #868 idle-drop. Mis-classifying an abandoned non-interactive child as
 * foreground only costs one lingering child until parent-death/ session_shutdown
 * reaps it; the opposite error re-drops the user's tools mid-session.
 */
export function isForegroundSession(ctx: unknown): boolean {
  const hasUI = (ctx as { hasUI?: unknown } | null | undefined)?.hasUI;
  return hasUI !== false;
}

/**
 * #868: derive the bridge child's spawn env for a session kind. The FOREGROUND
 * interactive session's child must never be idle-reaped — a multi-minute human
 * pause should not drop its ctx_* tools — so we disable the #854 reaper for it
 * via `CONTEXT_MODE_BRIDGE_IDLE_MS=0` (lifecycle.ts honors 0 → reaper not armed).
 * Sub-context / non-interactive children keep the default reaper so abandoned
 * children still can't accumulate (#854). The foreground child is still reaped
 * on actual parent death by the ppid/​signal watchdog (#311/#388) — only the
 * idle-time path is disabled. Pure; does not mutate the input env.
 */
export function foregroundBridgeEnv(
  baseEnv: NodeJS.ProcessEnv,
  foreground: boolean,
): NodeJS.ProcessEnv {
  if (!foreground) return baseEnv;
  return { ...baseEnv, CONTEXT_MODE_BRIDGE_IDLE_MS: "0" };
}

/** Result of bootstrapping the bridge. */
export interface BridgeHandle {
  /** Names of tools registered with Pi (for diagnostics / tests). */
  tools: string[];
  /** Idempotent shutdown — terminates the MCP child. */
  shutdown: () => void;
  /** Underlying client, exposed for tests / advanced callers. */
  client: MCPStdioClient;
}

/**
 * Spawn the MCP server and register each of its tools with Pi via
 * `pi.registerTool()`. Pi-only metadata shortens descriptions while preserving
 * the validation schema returned by `tools/list`. TypeBox emits JSON-Schema
 * compatible objects, so Pi accepts this shape (verified against pi 0.73.x).
 *
 * Errors during MCP `tools/call` are translated to a `throw` from the
 * `execute()` callback — Pi's contract is "throw to mark the tool call
 * failed", which lets the LLM see and adapt.
 */
export interface BootstrapOptions {
  env?: NodeJS.ProcessEnv;
  /** DI hook for tests: override the runtime resolver entirely. */
  _resolveJsRuntime?: () => string | null;
  /**
   * #868: true for the foreground interactive Pi session → spawn the child with
   * the #854 idle reaper DISABLED so a human pause never drops its tools.
   * Defaults to false (keep the reaper) for any non-foreground / unspecified
   * caller; the pi extension resolves this from `ctx.hasUI` via
   * {@link isForegroundSession}.
   */
  foreground?: boolean;
}

/**
 * Empty-but-valid handle returned when bootstrap is skipped (#516).
 * Keeps the shutdown contract intact so callers do not need null checks.
 */
function skippedBridge(): BridgeHandle {
  return {
    tools: [],
    shutdown: () => {
      /* nothing to shut down */
    },
    client: new MCPStdioClient("/dev/null"),
  };
}

export async function bootstrapMCPTools(
  pi: PiLikeAPI,
  serverScript: string,
  options: BootstrapOptions = {},
): Promise<BridgeHandle> {
  const env = options.env ?? process.env;
  // #868: all bridge diagnostics go to Pi's file logger, never the TUI terminal.
  const diag = makeBridgeDiag(pi);

  // Recursion guard (#516): if an ancestor bridge already incremented
  // the depth counter, refuse to spawn another child — even if the
  // binary-name check would let us through. Catches `node` shims that
  // re-exec Pi and other host swaps that bypass basename detection.
  const depth = Number.parseInt(env[BRIDGE_DEPTH_ENV] ?? "0", 10);
  if (Number.isFinite(depth) && depth > 0) {
    diag(
      `[context-mode] WARNING: skipping MCP bridge — ${BRIDGE_DEPTH_ENV}=${depth} ` +
        `indicates recursion (fork-bomb guard, #516). ctx_* tools will not be callable.`,
    );
    return skippedBridge();
  }

  // Runtime guard (#516): when neither node nor bun is on PATH and the
  // host process is pi, there is no safe binary to spawn. Log once and
  // return an empty handle — the rest of the extension keeps working.
  const runtime = (options._resolveJsRuntime ?? resolveJsRuntimeForBridge)();
  if (runtime === null) {
    diag(
      `[context-mode] WARNING: no JS runtime found (need node or bun on PATH). ` +
        `Skipping MCP bridge to avoid fork bomb (#516). ctx_* tools will not be callable.`,
    );
    return skippedBridge();
  }

  // #868: the foreground interactive session's child runs with the #854 idle
  // reaper disabled (CONTEXT_MODE_BRIDGE_IDLE_MS=0) so a human pause never drops
  // its tools; sub-context / non-interactive children keep the reaper (#854).
  const spawnEnv = foregroundBridgeEnv(env, options.foreground ?? false);
  const client = new MCPStdioClient(serverScript, spawnEnv, runtime, diag);

  // Retry-on-slow-initialize (#647).
  //
  // Each attempt is independently bounded by DEFAULT_REQUEST_TIMEOUT_MS
  // (60s) inside request(). On failure we shutdown the child to release
  // its fds before respawning — this is the same sequencing the #583
  // respawn path uses, just hoisted into the bootstrap layer where the
  // failure happens before any tool was registered. Final attempt's
  // rejection is re-thrown so extension.ts's existing then/onRejected
  // handler runs the degrade-and-log path for genuinely broken servers.
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_INIT_RETRIES; attempt++) {
    try {
      client.start();
      await client.initialize();
      lastError = undefined;
      break;
    } catch (err) {
      lastError = err;
      if (attempt === MAX_INIT_RETRIES) break;
      const msg = err instanceof Error ? err.message : String(err);
      diag(
        `[context-mode] WARNING: MCP bridge initialize failed ` +
          `(attempt ${attempt + 1}/${MAX_INIT_RETRIES + 1}): ${msg}. Retrying…`,
      );
      // Reclaim the failed child's fds before respawning. shutdown() is
      // idempotent and bounded by a 5s SIGKILL fallback (#472 round-3),
      // so a child stuck in an uninterruptible syscall cannot block the
      // retry loop indefinitely.
      try {
        client.shutdown();
      } catch {
        // best effort — we are already on the failure path
      }
      await new Promise((resolve) => setTimeout(resolve, INIT_RETRY_DELAY_MS));
    }
  }
  if (lastError !== undefined) throw lastError;

  const tools = await client.listTools();
  const registered: string[] = [];
  // Decide once at bootstrap: never hide tools on hosts without an active
  // discovery orchestrator. Merely having an inactive loader is insufficient.
  const activeTools = pi.getActiveTools?.() ?? [];
  const catalog = pi.getAllTools?.() ?? [];
  const canDiscover = catalog.some((tool) =>
    (tool.name === "codemode" || tool.name === "tool_search") &&
    activeTools.includes(tool.name) && typeof tool.reachesTools === "function",
  );
  const maintenanceTools = new Set(["ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge", "ctx_insight"]);

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      ...piToolMetadata(tool),
      exposure: canDiscover && maintenanceTools.has(tool.name) ? "deferred" : "direct",
      renderCall: createContextModeCallRenderer(tool.name),
      renderResult: createContextModeResultRenderer(tool.name),
      async execute(_toolCallId, params) {
        const result = await client.callTool(tool.name, params ?? {});
        const text = (result.content ?? [])
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string)
          .join("\n");
        if (result.isError) {
          // Throw is the Pi contract for "tool failed". The text body
          // becomes the error message visible to the LLM, so it sees
          // the same diagnostic the MCP server emitted.
          throw new Error(text || `${tool.name} returned an error`);
        }
        return {
          content: [{ type: "text", text }],
          details: {},
        };
      },
    });
    registered.push(tool.name);
  }

  return {
    tools: registered,
    shutdown: () => client.shutdown(),
    client,
  };
}
