/** Stdio transport, request state, runtime resolution and child lifecycle for the Pi bridge. */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { detectRuntimes } from "../../runtime.js";
import { foreignWorkspaceEnv, foreignIdentificationEnv } from "../detect.js";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// ── Fork-bomb prevention (#516) ──────────────────────────────────────
//
// Original bug: `spawn(process.execPath, [serverScript])` recursively
// re-executed the Pi binary on Bun-only systems where `process.execPath`
// IS pi itself. Each spawn re-loaded context-mode → spawned again →
// took the box down.
//
// Defence in depth:
//   1. resolveJsRuntimeForBridge() refuses pi-named binaries even when
//      detectRuntimes() returns one, falling back to PATH-resolved
//      node/bun.
//   2. Spawn passes CONTEXT_MODE_BRIDGE_DEPTH=1 in child env so any
//      transitive bridge load can detect the recursion via env counter.
//   3. bootstrapMCPTools() aborts if CONTEXT_MODE_BRIDGE_DEPTH > 0 in
//      its own env — catches recursion that bypasses the binary-name
//      check (e.g. a `node` shim that re-execs Pi).

const PI_BINARY_BASENAME = /^pi(\.exe)?$/i;
export const BRIDGE_DEPTH_ENV = "CONTEXT_MODE_BRIDGE_DEPTH";
const isWindows = process.platform === "win32";

function basename(p: string): string {
  const segs = p.split(/[\\/]/);
  return segs[segs.length - 1] ?? "";
}

function whichOnPath(cmd: string): string | null {
  try {
    const probe = isWindows ? `where ${cmd}` : `command -v ${cmd}`;
    const out = execSync(probe, { encoding: "utf-8", stdio: "pipe" })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    return out && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface ResolveDeps {
  detect?: () => { javascript: string | null };
  which?: (cmd: string) => string | null;
  execPath?: string;
}

/**
 * Resolve a JS runtime safe to spawn the MCP server with.
 *
 * Returns `null` when no real runtime is reachable (caller must skip
 * the bridge gracefully — see bootstrapMCPTools). Pi-named binaries are
 * explicitly rejected at every step to prevent the #516 fork bomb.
 */
export function resolveJsRuntimeForBridge(deps: ResolveDeps = {}): string | null {
  const detect = deps.detect ?? (() => detectRuntimes());
  const which = deps.which ?? whichOnPath;
  const execPath = deps.execPath ?? process.execPath;

  const isPi = (p: string | null | undefined): boolean =>
    !!p && PI_BINARY_BASENAME.test(basename(p));

  // 1. Prefer detectRuntimes().javascript when it is NOT pi.
  let candidate: string | null = null;
  try {
    candidate = detect().javascript ?? null;
  } catch {
    candidate = null;
  }
  if (candidate && !isPi(candidate)) return candidate;

  // 2. Fall back to PATH-resolved node, then bun.
  for (const cmd of ["node", "bun"]) {
    const resolved = which(cmd);
    if (resolved && !isPi(resolved)) return resolved;
  }

  // 3. Last resort: process.execPath only if it is not pi.
  if (execPath && !isPi(execPath)) return execPath;

  return null;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface MCPCallResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

// Bridge-imposed timeout for protocol-handshake methods (initialize,
// tools/list). These MUST be bounded: a server that never replies to
// initialize would otherwise block Pi's bridge bootstrap indefinitely.
// `tools/call` deliberately has NO bridge ceiling (#643) — long-running
// ctx_execute (test suites, builds, cargo test) was rejected by a 120s
// hardcoded bound even though the executor child would have finished.
// Responsibility for bounding a tool call belongs to the executor
// layer (per-tool timeout / background mode / Pi-level cancel), not
// to the transport.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** TUI-safe diagnostics sink: routes to Pi's file logger, never the terminal. */
export type BridgeDiag = (line: string, level?: "warn" | "debug") => void;

/**
 * Split a chunk of forwarded child output into lines without a regex (the repo
 * forbids regex in source). Trailing `\r` is stripped so CRLF traces stay clean
 * in the log; the final partial line (no trailing newline) is preserved.
 */
export function splitDiagLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      let end = i;
      if (end > start && text[end - 1] === "\r") end--;
      lines.push(text.slice(start, end));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Minimal stdio JSON-RPC client targeting the context-mode MCP server.
 *
 * Implementation notes:
 *   - One outstanding ID per request; results matched by `id` from the
 *     returned envelope. Notifications (no id) are sent fire-and-forget.
 *   - Buffer is split on `\n` because the MCP server writes one
 *     newline-delimited JSON message per `console.log` / `stdout.write`
 *     invocation — this is the standard MCP stdio transport framing.
 *   - On child exit / error, every in-flight request is rejected so
 *     callers do not hang forever.
 */
export class MCPStdioClient {
  private child: ChildProcess | null = null;
  private requestId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private buffer = "";
  private initialized = false;
  private exited = false;
  /**
   * In-flight respawn promise — set while {@link respawn} runs so
   * concurrent callers awaiting `request()` after an idle exit observe
   * the SAME respawn, not N parallel ones. Without this guard, two
   * simultaneous `callTool` calls would each see `this.exited === true`,
   * each fire their own `respawn()`, and the loser leaks an orphaned
   * child process the GC cannot reach (no `.kill()` reference).
   */
  private respawnPromise: Promise<void> | null = null;
  /**
   * Live env passed to the spawned child — exposed (read-only intent)
   * so tests can pin the fork-bomb-prevention env counter (#516)
   * without needing to attach a process-tree probe.
   */
  _spawnEnv: NodeJS.ProcessEnv | null = null;

  constructor(
    private readonly serverScript: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly runtimeOverride: string | null = null,
    /**
     * TUI-safe sink for the child's forwarded stderr (#868). Defaults to a
     * no-op so direct callers (skippedBridge, tests) never leak to the
     * terminal; bootstrapMCPTools wires this to the Pi host's file logger.
     */
    private readonly diag: BridgeDiag = () => {},
  ) {}

  /** Spawn the MCP child. Idempotent. */
  start(): void {
    if (this.child) return;
    this.exited = false;
    // Pick a JS runtime that is NOT the host process (#516). When Pi
    // is the host binary, process.execPath would re-exec Pi and fork
    // bomb the box. resolveJsRuntimeForBridge prefers bun/node and
    // explicitly rejects pi-named binaries.
    const runtime =
      this.runtimeOverride ?? resolveJsRuntimeForBridge() ?? process.execPath;
    // Increment the depth counter so any transitive bridge load inside
    // the child can short-circuit before spawning yet another server.
    const depth = Number.parseInt(this.env[BRIDGE_DEPTH_ENV] ?? "0", 10);
    const childEnv: NodeJS.ProcessEnv = {
      ...this.env,
      [BRIDGE_DEPTH_ENV]: String(Number.isFinite(depth) ? depth + 1 : 1),
    };
    // Issue #545 — scrub foreign workspace env vars before spawn.
    //
    // Pi's MCP bridge inherits the host shell env (including a prior
    // `claude` invocation's CLAUDE_PROJECT_DIR). Without this scrub, the
    // spawned MCP server resolves getProjectDir() to the foreign workspace
    // and Pi's sessions write into the wrong project. The ban list is
    // derived ALGORITHMICALLY from PLATFORM_ENV_VARS (every other adapter's
    // workspace-role vars), so adding adapter #16 grows the scrub
    // automatically — no edit to this file. Pi's own workspace vars and
    // the universal escape hatch (CONTEXT_MODE_PROJECT_DIR) are NEVER
    // scrubbed.
    for (const banned of foreignWorkspaceEnv("pi")) {
      delete childEnv[banned];
    }
    // Issue #561 — scrub foreign IDENTIFICATION env vars before spawn.
    //
    // Foreign identification vars hijack detectPlatform() — must scrub
    // when spawning child under a different host (#561). When Pi runs
    // co-resident with Claude Code, the inherited shell env carries
    // CLAUDE_CODE_ENTRYPOINT and CLAUDE_PLUGIN_ROOT; the spawned MCP
    // child's detectPlatform() then walks PLATFORM_ENV_VARS in priority
    // order (claude-code first), returns claude-code, and Pi's session
    // data lands in ~/.claude/context-mode/ instead of Pi's own dir.
    // Pi's OWN identification vars (PI_CONFIG_DIR / PI_SESSION_FILE /
    // PI_COMPILED) are excluded from the ban set so the child still
    // detects pi correctly.
    for (const banned of foreignIdentificationEnv("pi")) {
      delete childEnv[banned];
    }
    // Issue #561 regression fix: Pi detection vars are empty after
    // foreign env scrubbing (CLAUDE_CODE_ENTRYPOINT / CLAUDE_PLUGIN_ROOT
    // are deleted by the ban above). Without PI_CONFIG_DIR,
    // detectPlatform() finds zero Pi identification vars and falls
    // through to Claude Code default — stats land in ~/.claude/ instead
    // of ~/.pi/. Set PI_CONFIG_DIR from the child's HOME env var so the
    // child resolves to Pi correctly. (Use childEnv.HOME, not homedir(),
    // because homedir() reads getpwent() which ignores our HOME override
    // in test environments.)
    //
    // Cross-OS PI_CONFIG_DIR rescue (PR #741 follow-up):
    //   1. If the parent already exported PI_CONFIG_DIR, trust it
    //      verbatim — Pi's launcher owns that path and may pin it to
    //      a non-default location (corporate setup, CI, etc.).
    //   2. POSIX: ~/.pi (HOME-rooted).
    //   3. Windows: probe both %USERPROFILE%\.pi (rare native install)
    //      AND %APPDATA%\.pi (XDG-on-Windows, Pi's documented Windows
    //      layout). Without the APPDATA fallback, every Pi-on-Windows
    //      install silently drops back to the Claude Code default and
    //      Pi's sessions write into the wrong directory.
    if (!childEnv.PI_CONFIG_DIR) {
      const home = childEnv.HOME ?? childEnv.USERPROFILE ?? childEnv.HOMEPATH;
      const appData = childEnv.APPDATA; // Windows-only, undefined on POSIX
      const candidates: string[] = [];
      if (home) candidates.push(join(home, ".pi"));
      if (appData) candidates.push(join(appData, ".pi"));
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          childEnv.PI_CONFIG_DIR = candidate;
          break;
        }
      }
    }
    this._spawnEnv = childEnv;
    this.child = spawn(runtime, [this.serverScript], {
      // Pipe stderr (#472 round-3): swallowing it via "ignore" hides
      // server crash diagnostics — the user only saw "ctx_* tools will
      // not be callable" with no clue WHY. We capture it so the diagnostic
      // is preserved, but route it through `diag` (Pi's file logger), NOT
      // process.stderr — Pi's raw-mode TUI owns the terminal and any console
      // write is rendered into the editor input box, blocking typing (#868).
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    });
    this.child.stdout?.on("data", (chunk) => this.onData(chunk));
    this.child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      // Forward each non-empty line, [mcp-bridge]-prefixed so it stays
      // grep-friendly in ~/.omp/logs. debug level: this is mostly routine
      // child chatter (e.g. the #854 idle-reaper notice), not an alert.
      for (const line of splitDiagLines(text)) {
        if (line !== "") this.diag(`[mcp-bridge] ${line}`, "debug");
      }
    });
    this.child.on("exit", () => this.onExit());
    this.child.on("error", () => this.onExit());
  }

  private onExit(): void {
    if (this.exited) return;
    this.exited = true;
    const err = new Error("MCP server exited");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf-8");
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // skip non-JSON noise (e.g. stray log lines)
      }
      if (typeof msg.id !== "number" || !this.pending.has(msg.id)) continue;
      const handler = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) handler.reject(msg.error);
      else handler.resolve(msg.result);
    }
  }

  async request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    // Respawn-on-idle-exit (#583, #583-followup).
    //
    // Initial #583 fix patched callTool() only. The structural location is
    // here: `request()` is the single chokepoint for `initialize`,
    // `tools/list`, `tools/call`, and any future method. Patching at this
    // layer means listTools / re-initialize paths after an idle exit also
    // self-heal, not just the registered-tool happy path.
    //
    // Sequencing is critical: respawn() resets `exited`, `child`, and
    // `buffer` BEFORE start() + initialize(). The initialize() call inside
    // respawn() goes through this same request() — recursion is safe
    // because by the time we re-enter, `exited` is false again. We use a
    // single-flight `respawnPromise` so concurrent callers share the same
    // respawn (orphan-child guard, see field comment).
    if (this.exited) {
      if (!this.respawnPromise) {
        this.respawnPromise = this.respawn().finally(() => {
          this.respawnPromise = null;
        });
      }
      await this.respawnPromise;
    }
    if (!this.child) throw new Error("MCP client not started");
    const id = ++this.requestId;
    return new Promise<T>((resolve, reject) => {
      // Gate the timer on a finite ms value so callers can pass
      // `Number.POSITIVE_INFINITY` to mean "no bridge ceiling" (#643).
      // Node coerces both `undefined` and `Infinity` to a 1ms delay
      // (TimeoutOverflowWarning), so we can't just pass them through —
      // we must skip the setTimeout entirely. tools/call uses this path
      // because long-running ctx_execute must not be bounded here.
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            if (!this.pending.has(id)) return;
            this.pending.delete(id);
            reject(new Error(`MCP request timeout after ${timeoutMs}ms: ${method}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, {
        resolve: (v) => {
          if (timer) clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          if (timer) clearTimeout(timer);
          reject(e);
        },
      });
      const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const rejectWrite = (err: Error) => {
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          handler.reject(err);
          return;
        }
        reject(err);
      };
      this.writeFrame(frame, rejectWrite);
    });
  }

  private writeFrame(frame: string, onError?: (err: Error) => void): boolean {
    if (!this.child || this.exited) {
      onError?.(new Error("MCP server exited"));
      return false;
    }

    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || stdin.closed) {
      this.onExit();
      onError?.(new Error("MCP server stdin unavailable"));
      return false;
    }

    try {
      stdin.write(frame + "\n", (err) => {
        if (!err) return;
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPIPE" || code === "ERR_STREAM_DESTROYED") {
          this.onExit();
          onError?.(err);
          return;
        }
        onError?.(err);
      });
      return true;
    } catch (err) {
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (err instanceof Error && (code === "EPIPE" || code === "ERR_STREAM_DESTROYED")) {
        this.onExit();
        onError?.(err);
        return false;
      }
      throw err;
    }
  }

  notify(method: string, params: unknown): void {
    if (!this.child) return;
    const frame = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeFrame(frame);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      clientInfo: {
        name: "pi-coding-agent-context-mode-bridge",
        version: "1.0",
      },
    });
    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  async listTools(): Promise<MCPTool[]> {
    const result = await this.request<{ tools?: MCPTool[] }>("tools/list", {});
    return Array.isArray(result.tools) ? result.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<MCPCallResult> {
    // Respawn-on-idle-exit is now handled centrally in `request()`
    // (#583 follow-up). Originally patched here in #583 — moving it up
    // one layer covers `listTools` / `initialize` paths too, with a
    // single-flight guard against orphan child processes from
    // concurrent callers.
    //
    // No bridge-imposed timeout for tools/call (#643). The previous
    // 120s ceiling rejected legitimate long-running ctx_execute calls
    // (test suites, builds, large `cargo test`) even though the
    // executor child would have finished. Bounding belongs to the
    // executor layer (per-tool timeout / background mode / Pi cancel),
    // not the transport. `Number.POSITIVE_INFINITY` instructs
    // `request()` to skip the setTimeout entirely — see the gate there.
    return this.request<MCPCallResult>(
      "tools/call",
      { name, arguments: args ?? {} },
      Number.POSITIVE_INFINITY,
    );
  }

  /**
   * Respawn the MCP child after an exit (clean shutdown or crash).
   * Resets state so a fresh `start()` + `initialize()` cycle runs, then
   * the caller's pending request flows through the new child.
   *
   * Single-flight — concurrent callers share one in-flight respawn via
   * {@link respawnPromise}. Internal — only entered via {@link request}.
   *
   * Sequencing pinned (do not reorder without updating the regression
   * test in tests/adapters/pi-mcp-bridge.test.ts):
   *   1. `this.child = null`     — drop stale handle
   *   2. `this.buffer = ""`       — discard leftover bytes from old child
   *   3. `this.exited = false`    — must precede `start()` + `initialize()`,
   *                                 because `request("initialize", …)`
   *                                 inside `initialize()` re-checks this
   *                                 flag and would otherwise re-enter
   *                                 respawn in an infinite loop
   *   4. `this.initialized = false`
   *   5. `this.start()`
   *   6. `await this.initialize()` — flows through `request()` recursively
   */
  private async respawn(): Promise<void> {
    this.child = null;
    this.buffer = "";
    this.exited = false;
    this.initialized = false;
    this.start();
    await this.initialize();
  }

  shutdown(): void {
    if (!this.child) return;
    const child = this.child;
    try {
      child.kill("SIGTERM");
    } catch {
      // best effort
    }
    // SIGKILL fallback (#472 round-3): a child that ignores SIGTERM
    // (e.g. installed handler that swallows the signal, or stuck in
    // an uninterruptible syscall) becomes a zombie because we null
    // the handle immediately. Schedule a hard kill bounded at 5s; the
    // .unref() prevents this timer from keeping the parent alive after
    // legitimate work is done.
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      } catch {
        // best effort
      }
    }, 5000).unref();
    this.child = null;
    this.initialized = false;
    this.exited = true;
  }
}
