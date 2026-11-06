// src/entries/pi.ts — Pi extension, in-process (impl/12 §1-§3, impl/10 §10; DEVIATIONS D-M5-arch-1,
// D-M5-A1-1, D-M5-P1-1). Pi loads `export default function (pi)` and wires handlers with
// `pi.on(<event>, handler)`. No MCP child: TOOLS register through `pi.registerTool` and run in this
// process. Every hook goes through handleHook with the D-M5-A1-1 raw shape (`type` = call-site name).
// One instance per session (impl/12 A22): all state lives in this closure, none at module level, so a
// reload leaves nothing behind (#983). No console writes: Pi owns the terminal (#868).
import { z } from "zod/v4";
import { checkPermission } from "../adapters/pi.ts";
import { INTERNAL_ERROR_LINE } from "../core/contracts/constants.ts";
import { CtxError } from "../core/contracts/errors.ts";
import type { HookOutput, ProjectContext, ToolContext, ToolReply } from "../core/contracts/types.ts";
import { handleHook } from "../core/hooks/dispatch.ts";
import { ownJournal } from "../core/journal/own-call.ts";
import { resolveProject } from "../core/project/resolve.ts";
import { TOOLS, checkCall, type RegisteredTool } from "../core/tools/registry.ts";
import { INSTRUCTIONS } from "./server.ts";
import {
  autoMemoryMode, branchHistory, belongsToBranch, leafId, makeResume,
  PiCaptureBuffer, PI_EVIDENCE_ENTRY, PI_RESUME_CONSUMED, PI_RESUME_ENTRY, record,
  storedResume, textOf, validResume, type PiHistoryContext, type PiResume,
} from "./pi-history.ts";
import { applyPiResponseBudget, normalizePiCall, withPiBudgetSchema } from "./pi-budget.ts";

/** The Pi handler context fields this file reads (impl/10 §10). */
export interface PiContext extends PiHistoryContext {}

export interface PiToolResult {
  content: { type: "text"; text: string }[];
  details: Record<string, unknown>;
  isError: boolean;
}

export interface PiTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  exposure?: "direct" | "deferred";
  execute(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: PiContext): Promise<PiToolResult>;
}

/** The Pi extension API surface this file uses. */
export interface PiApi {
  on(event: string, handler: (event: Record<string, unknown>, ctx?: PiContext) => unknown): void;
  registerTool(tool: PiTool): void;
  appendEntry?(customType: string, data?: unknown): void;
  getActiveTools?(): string[];
  getAllTools?(): Array<{ name: string; reachesTools?: unknown }>;
}

type PiEvent = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function errorReply(err: unknown): ToolReply {
  return { text: err instanceof CtxError ? err.toLine() : INTERNAL_ERROR_LINE, isError: true, sandboxBytes: 0 };
}

// Verified on Pi 1.5.0: returning isError preserves details; throwing replaces the result and
// discards Error.details in agent-loop. Keep diagnostics and recall metadata on failed calls too.
function toPi(reply: ToolReply): PiToolResult {
  const details = "details" in reply ? record(reply.details) : {};
  return { content: [{ type: "text", text: reply.text }], details, isError: reply.isError };
}

export default function piExtension(pi: PiApi): void {
  const env = process.env;
  let sessionId = "";
  let cwd = "";
  let liveContext: PiContext | undefined;
  let project: ProjectContext | undefined;
  let turn = 0;
  let started = false;
  let pendingResume: PiResume | null = null;
  let pendingMemory: { sessionId: string; entryId: string; content: string } | null = null;
  const consumedResumes = new Set<string>();
  const captures = new PiCaptureBuffer();
  const journal = ownJournal(); // D-HF-INPROC-JOURNAL-1
  let toolsRegistered = false; // #1098: a failed registration retries on the next before_agent_start

  function identify(ctx: PiContext | undefined): void {
    if (!ctx) return;
    const next = str(ctx.sessionManager?.getSessionId());
    const nextCwd = str(ctx.cwd);
    if (next !== "" && next !== sessionId) {
      sessionId = next;
      turn = 0;
      started = false;
      pendingResume = null;
      pendingMemory = null;
      consumedResumes.clear();
    }
    if (nextCwd !== "" && nextCwd !== cwd) { cwd = nextCwd; project = undefined; }
    liveContext = ctx;
  }

  function hook(raw: PiEvent, atTurn: number): Promise<HookOutput> {
    return handleHook("pi", { ...raw, sessionId, cwd, turn: atTurn }, env);
  }

  // #1246: each instance resolves its own project from its own ctx.cwd, at most once.
  function projectOf(): ProjectContext {
    project ??= resolveProject("pi", { env, argv: process.argv, cwd, piCwd: cwd });
    return project;
  }

  function appendEntry(customType: string, data: unknown): void {
    try { pi.appendEntry?.(customType, data); } catch { /* The current delivery must still succeed. */ }
  }

  async function flushCaptures(ctx: PiContext | undefined, final = false): Promise<void> {
    const index = TOOLS.find((tool) => tool.name === "ctx_index")!;
    for (const capture of captures.drain(ctx, sessionId, final)) {
      try {
        const capturedProject = resolveProject("pi", { env, argv: process.argv, cwd: capture.cwd, piCwd: capture.cwd });
        const source = `pi evidence:${capture.id}:${capture.tool}`;
        const content = JSON.stringify({ sessionId: capture.sessionId, entryId: capture.entryId,
          toolCallId: capture.toolCallId, parentToolCallId: capture.parentToolCallId,
          observation: JSON.parse(capture.content) });
        const reply = await index.handler({ content, source }, {
          project: capturedProject, sessionId: capture.sessionId, turn,
          signal: new AbortController().signal, protocolVersion: "", piCwd: capture.cwd,
        });
        if (!reply.isError && capture.sessionId === sessionId && capture.entryId && belongsToBranch(ctx, capture.entryId)) {
          appendEntry(PI_EVIDENCE_ENTRY, { sessionId, entryId: capture.entryId,
            toolCallId: capture.toolCallId, source });
        }
      } catch { /* Supplementary capture must not break a tool or manufacture a recall receipt. */ }
    }
  }

  async function runTool(tool: RegisteredTool<unknown>, params: unknown, signal: AbortSignal | undefined): Promise<ToolReply> {
    let normalized: ReturnType<typeof normalizePiCall>;
    try { normalized = normalizePiCall(tool.name, params); } catch (err) { return errorReply(err); }
    const checked = checkCall(tool, normalized.params);
    if (!checked.ok && (normalized.maxOutputChars === undefined || checked.line.length <= normalized.maxOutputChars)) {
      return { text: checked.line, isError: true, sandboxBytes: 0 };
    }
    // Capture attribution before awaiting a handler: later navigation cannot retag this call.
    let callProject: ProjectContext;
    try { callProject = projectOf(); } catch (err) { return errorReply(err); }
    const ctx: ToolContext = {
      project: callProject,
      sessionId,
      turn,
      // #1182: Pi's abort signal reaches the handler, which kills the process tree and replies "Cancelled.".
      signal: signal ?? new AbortController().signal,
      protocolVersion: "",
      piCwd: cwd === "" ? undefined : cwd, // D-R38-PI-D7-1 (#1312): ctx_doctor D7 compares against Pi's live ctx.cwd
      ...(normalized.maxOutputChars === undefined ? {} : { outputBudgetBytes: normalized.maxOutputChars * 4 }),
    };
    let reply: ToolReply;
    if (!checked.ok) {
      reply = { text: checked.line, isError: true, sandboxBytes: 0 };
    } else try {
      const input = record(checked.data);
      if (tool.name === "ctx_upgrade") {
        // The upstream upgrader migrates v1 data/configuration before returning its command.
        // This maintained Pi fork must keep both the original source and old data intact.
        reply = { isError: false, sandboxBytes: 0, text:
          "Update this maintained Pi fork through its original source. Run `pi list` to identify the package. " +
          "For an npm or Git package, run `pi update <that exact original source>`; for a local package, " +
          "update its source checkout, run `npm run build:pi` there, then use its rebuilt `release-out` package. Fully exit and restart Pi. " +
          "This tool provides guidance only; it does not run the official upgrader or migrate existing data." };
      } else if (tool.name === "ctx_resume" && input.seq === undefined &&
        (input.session === undefined || input.session === ctx.sessionId)) {
        reply = { isError: false, sandboxBytes: 0,
          text: branchHistory(liveContext, ctx.sessionId) ||
            "No verified current-branch history is available. Use ctx_search for explicit historical evidence; it may include other branches." };
      } else {
        reply = await tool.handler(checked.data, ctx);
        if (tool.name === "ctx_resume" && !reply.isError) {
          reply = { ...reply, text: "Explicit historical record; it may belong to another session or branch. Verify it against the current request.\n" + reply.text };
        }
      }
    } catch (err) {
      reply = errorReply(err);
    }
    reply = await applyPiResponseBudget(tool.name, reply, ctx, normalized.maxOutputChars);
    // D-HF-INPROC-JOURNAL-1: the row the MCP server writes; an unresolved project has no DB, so no row.
    await journal(callProject, ctx, tool.name, reply);
    return reply;
  }

  function piTool(tool: RegisteredTool<unknown>, canDiscover: boolean): PiTool {
    return {
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: withPiBudgetSchema(tool.name, z.toJSONSchema(tool.schema)),
      exposure: canDiscover && ["ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge"].includes(tool.name) ? "deferred" : "direct",
      execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
        identify(ctx);
        return toPi(await runTool(tool, params, signal));
      },
    };
  }

  function registerTools(): void {
    if (toolsRegistered) return;
    try {
      const active = pi.getActiveTools?.() ?? [];
      const canDiscover = (pi.getAllTools?.() ?? []).some((tool) =>
        ["codemode", "tool_search"].includes(tool.name) && active.includes(tool.name) && typeof tool.reachesTools === "function");
      for (const tool of TOOLS) pi.registerTool(piTool(tool, canDiscover));
      toolsRegistered = true;
    } catch {
      // #1098: left unregistered; the next before_agent_start registers again.
    }
  }

  // Static routing stays cache-stable. Historical observations are delivered separately, never
  // promoted to system instructions or copied from the session-wide journal across branches.
  pi.on("before_agent_start", async (event, ctx) => {
    identify(ctx);
    turn += 1;
    registerTools();
    await flushCaptures(ctx);
    const base = str(event.systemPrompt);
    if (!started) {
      try { await hook({ type: "session_start" }, turn); started = true; } catch { /* retry next turn */ }
    }
    pendingMemory = null;
    const entryId = leafId(ctx);
    if (autoMemoryMode(env) === "always" && entryId) {
      const content = branchHistory(ctx, sessionId, "active_memory");
      if (content) pendingMemory = { sessionId, entryId, content };
    }
    return { systemPrompt: base === "" ? INSTRUCTIONS : base + "\n\n" + INSTRUCTIONS };
  });

  // impl/10 §10 UserPromptSubmit: the prompt row belongs to the turn it starts.
  pi.on("input", async (event, ctx) => {
    identify(ctx);
    await hook({ type: "input", message: str(event.text) }, turn + 1);
    return undefined;
  });

  // impl/12 §3.4: allow returns nothing; a deny is Pi's {block, reason} (impl/10 §10).
  pi.on("tool_call", async (event, ctx) => {
    identify(ctx);
    const out = await hook({ type: "tool_call", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input }, turn);
    return checkPermission(out);
  });

  // impl/12 §3.5: journal append happens inside handleHook; a replace (case C) sets content and
  // details together (ADR-0016 Pi row).
  pi.on("tool_result", async (event, ctx) => {
    identify(ctx);
    await flushCaptures(ctx);
    // Retain structured-only/graph evidence through the normal v2 index, with delayed entry binding.
    if (!str(event.toolName).startsWith("ctx_") && (str(event.toolName).startsWith("graph_") ||
      event.structuredContent !== undefined || event.details !== undefined)) captures.enqueue(event, ctx, sessionId);
    // The core hook must see the full captured text before deciding whether to index it.
    // Only the supplementary Pi observation has an excerpt budget.
    let structuredText = "";
    try { structuredText = JSON.stringify(event.structuredContent ?? event.details) ?? ""; } catch { /* non-serializable metadata */ }
    const text = textOf(event.content);
    const content = structuredText && structuredText !== "{}" && structuredText !== text
      ? (text ? text + "\n" : "") + structuredText : text;
    const keep = Array.isArray(event.content) && event.content.some((part) => record(part).type !== "text");
    const out = await hook({
      type: "tool_result", toolName: event.toolName, toolCallId: event.toolCallId, input: event.input,
      content, keep,
      isError: event.isError === true,
    }, turn);
    await flushCaptures(ctx);
    if (out.stdout === "") return undefined;
    // A textual replacement must never erase an image/resource result or structured status.
    if (keep) return undefined;
    return { content: [{ type: "text", text: out.stdout }], details: { ...record(event.details),
      ...record(event.structuredContent), text: out.stdout } };
  });

  pi.on("context", async (event, ctx) => {
    identify(ctx);
    await flushCaptures(ctx);
    if (autoMemoryMode(env) === "off" || !Array.isArray(event.messages)) return undefined;
    const resume = validResume(pendingResume, ctx, sessionId) && !consumedResumes.has(pendingResume.id)
      ? pendingResume : storedResume(ctx, sessionId, consumedResumes);
    const memory = pendingMemory;
    pendingMemory = null;
    const content = resume?.content ?? (memory?.sessionId === sessionId && belongsToBranch(ctx, memory.entryId) ? memory.content : "");
    if (!content) return undefined;
    const message = { role: "custom", customType: "context-mode-history", content,
      display: false, timestamp: Date.now(), details: { source: "context-mode", sessionId,
        entryId: resume?.entryId ?? memory?.entryId, resumeId: resume?.id } };
    // Copy the request's message list. No earlier user content, quotations, or dynamic memory is removed.
    const messages = [...event.messages, message];
    if (resume) {
      consumedResumes.add(resume.id);
      pendingResume = null;
      appendEntry(PI_RESUME_CONSUMED, { sessionId, id: resume.id });
    }
    return { messages };
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    identify(ctx);
    await flushCaptures(ctx);
    pendingMemory = null;
    // Preparation alone never creates or consumes a resume.
  });
  pi.on("session_compact", async (event, ctx) => {
    identify(ctx);
    await flushCaptures(ctx);
    pendingMemory = null;
    if (autoMemoryMode(env) !== "off") {
      pendingResume = makeResume(ctx, sessionId, record(event.compactionEntry).id ?? leafId(ctx));
      if (pendingResume) appendEntry(PI_RESUME_ENTRY, pendingResume);
    }
    return undefined;
  });
  pi.on("session_tree", async (_event, ctx) => {
    identify(ctx);
    pendingMemory = null;
    if (!validResume(pendingResume, ctx, sessionId)) pendingResume = null;
    await flushCaptures(ctx, true);
  });
  pi.on("session_start", (_event, ctx) => { identify(ctx); });
  pi.on("turn_end", async (_event, ctx) => { identify(ctx); await flushCaptures(ctx); });
  pi.on("session_shutdown", async (_event, ctx) => { await flushCaptures(ctx, true); pendingMemory = null; });
}
