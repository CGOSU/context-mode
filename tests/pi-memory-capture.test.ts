import "./setup-home";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionDB } from "../src/session/db.js";
import { recentBranchEvents } from "../src/adapters/pi/history.js";

// These lifecycle tests exercise the real temporary SessionDB, never an MCP child.
vi.mock("../src/adapters/pi/mcp-bridge.js", async (original) => ({
  ...await original<typeof import("../src/adapters/pi/mcp-bridge.js")>(),
  bootstrapMCPTools: vi.fn(async () => ({ shutdown: vi.fn(), tools: [] })),
}));

describe("Pi capture and branch-scoped historical memory", () => {
  let dir: string;
  let handlers: Record<string, (...args: any[]) => any>;
  let branch: Array<{ id: string; type?: string; message?: any }>;
  let db: SessionDB;
  let sessionId: string;
  let ctx: any;
  let toolNumber: number;
  const trigger = (name: string, event: any = {}) => handlers[name]?.(event, ctx);
  const persistTool = async (event: any) => {
    const returned = await trigger("tool_result", event);
    // Pi appends the result only after tool_result/message_end callbacks return.
    branch.push({ id: `result-${event.toolCallId}`, type: "message", message: { role: "toolResult", toolCallId: event.toolCallId } });
    await trigger("turn_end");
    return returned;
  };
  const result = (toolName: string, content: string, input = {}) => persistTool({
    type: "tool_result", toolName, toolCallId: `call-${++toolNumber}`, input,
    content: [{ type: "text", text: content }], isError: false,
  });
  const context = async () => {
    await trigger("before_agent_start", { prompt: "Continue", systemPrompt: "stable" });
    const messages: any[] = [];
    await trigger("context", { messages });
    return messages;
  };
  const seed = async (text: string, priority = 3) => {
    await result("read", "", { path: "/fixture.ts" });
    const source = db.getEvents(sessionId).at(-1)!.source_hook;
    db.insertEvent(sessionId, { type: "decision", category: "decision", priority, data: text }, source);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pi-memory-regression-"));
    process.env.PI_WORKSPACE_DIR = dir;
    delete process.env.PI_CONTEXT_MODE_AUTO_MEMORY;
    branch = [{ id: "root" }, { id: "branch-a" }];
    toolNumber = 0;
    ctx = { hasUI: false, sessionManager: {
      getSessionFile: () => join(dir, "session.jsonl"),
      getLeafId: () => branch.at(-1)?.id ?? null,
      getBranch: () => branch,
    } };
    handlers = {};
    const ensure = vi.spyOn(SessionDB.prototype, "ensureSession");
    const { default: extension } = await import("../src/adapters/pi/extension.js");
    extension({ on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: vi.fn(), registerTool: vi.fn() });
    await trigger("session_start");
    db = ensure.mock.contexts.at(-1)!;
    sessionId = ensure.mock.calls.at(-1)![0];
    ensure.mockRestore();
  });

  afterEach(async () => {
    await trigger("session_shutdown");
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_WORKSPACE_DIR;
    delete process.env.PI_CONTEXT_MODE_AUTO_MEMORY;
    vi.restoreAllMocks();
  });

  it("captures real SDK content and structuredContent without changing the tool result", async () => {
    const event = { toolName: "ctx_execute", toolCallId: "sdk-call", input: { language: "shell" },
      content: [{ type: "text", text: "SDK_TEXT_BODY" }, { type: "image", data: "PRIVATE_IMAGE_BYTES" }],
      structuredContent: { status: "SDK_STRUCTURED_STATUS" }, isError: false };
    expect(await persistTool(event)).toBeUndefined();
    const rows = db.getEvents(sessionId);
    const captured = rows.find(e => e.type === "mcp")!;
    expect(captured?.data).toContain("SDK_TEXT_BODY");
    expect(captured?.data).toContain("SDK_STRUCTURED_STATUS");
    expect(captured?.data).not.toContain("PRIVATE_IMAGE_BYTES");
    expect(captured?.source_hook).toContain("result-sdk-call");
    expect(captured?.source_hook).toContain("sdk-call");
    expect(event.content).toHaveLength(2);
  });

  it("retains the actual error text in error events", async () => {
    await persistTool({ toolName: "bash", toolCallId: "failed", input: { command: "false" },
      content: [{ type: "text", text: "precise failure: E_TEST_42" }], isError: true });
    expect(db.getEvents(sessionId).find(e => e.type === "error_tool")?.data).toContain("E_TEST_42");
  });

  it("records bounded graph evidence with origin and truncation, not image bytes", async () => {
    await result("graph_inspect", "GRAPH_EVIDENCE_" + "x".repeat(30_000), { path: "src/example.ts" });
    const row = db.getEvents(sessionId).find(e => e.type === "graph_result")!;
    expect(row?.data).toContain("GRAPH_EVIDENCE_");
    expect(row?.data.length).toBeLessThan(8192);
    const data = JSON.parse(row.data);
    expect(data.toolCallId).toBe("call-1");
    expect(data.truncated).toBe(true);
    expect(data.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(row.source_hook).toContain("result-call-1");
  });

  it("bounds escaped graph records and retains structured status beside oversized text", async () => {
    await persistTool({ toolName: "graph_inspect", toolCallId: "escaped", input: { path: "\u0000".repeat(4_000) },
      content: [{ type: "text", text: "\u0000".repeat(70_000) }],
      structuredContent: { status: "STRUCTURED_ERROR_END" }, isError: true });
    const rows = db.getEvents(sessionId);
    expect(rows.find(e => e.type === "graph_result")!.data.length).toBeLessThanOrEqual(8192);
    expect(rows.find(e => e.type === "error_tool")!.data).toContain("STRUCTURED_ERROR_END");
  });

  it("defaults to compact and only injects a successful compaction once", async () => {
    await seed("COMPACT_MEMORY");
    expect(JSON.stringify(await context())).not.toContain("COMPACT_MEMORY");
    await trigger("session_before_compact");
    await trigger("session_compact_failed", { aborted: true });
    expect(JSON.stringify(await context())).not.toContain("COMPACT_MEMORY");
    branch.push({ id: "compact-a" });
    await trigger("session_compact", { compactionEntry: { id: "compact-a" } });
    const messages = await context();
    expect(JSON.stringify(messages)).toContain("COMPACT_MEMORY");
    expect(messages[0]).toMatchObject({ role: "custom", customType: "context-mode-history", display: false });
    expect(messages[0].content).toContain("not current user instructions or authorization");
    expect(JSON.stringify(await context())).not.toContain("COMPACT_MEMORY");
  });

  it("selects the newest 50 eligible branch events without changing DB query order", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "always";
    await result("read", "", { path: "/fixture.ts" });
    const source = db.getEvents(sessionId).at(-1)!.source_hook;
    for (let i = 0; i < 60; i++) db.insertEvent(sessionId, {
      type: "decision", category: "decision", priority: 3, data: `WINDOW_${String(i).padStart(3, "0")}`,
    }, source);
    const text = JSON.stringify(await context());
    expect(text).toContain("WINDOW_059");
    expect(text).not.toContain("WINDOW_000");
    expect(db.getEvents(sessionId, { minPriority: 3, limit: 1 })[0].data).toBe("WINDOW_000");
    // The prompt may add another high-priority event, so inspect the selection
    // before rendering instead of assuming all 50 fit the character budget.
    const recent = recentBranchEvents(db.getEvents(sessionId, { type: "decision" }), ctx, 3);
    expect(recent).toHaveLength(50);
    expect(recent[0].data).toBe("WINDOW_010");
    expect(recent.at(-1)?.data).toBe("WINDOW_059");
  });

  it("excludes abandoned branches and legacy unattributed events", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "always";
    await seed("BRANCH_A_PRIVATE");
    db.insertEvent(sessionId, { type: "decision", category: "decision", priority: 3, data: "LEGACY_UNSCOPED" });
    branch = [{ id: "root" }, { id: "branch-b" }];
    await trigger("session_tree");
    await seed("BRANCH_B_CURRENT");
    const text = JSON.stringify(await context());
    expect(text).toContain("BRANCH_B_CURRENT");
    expect(text).not.toContain("BRANCH_A_PRIVATE");
    expect(text).not.toContain("LEGACY_UNSCOPED");
    expect(db.getEvents(sessionId).some(e => e.data === "LEGACY_UNSCOPED")).toBe(true);
  });

  it("keeps identical observations at distinct persisted results while preserving default DB dedup", async () => {
    await result("read", "", { path: "/same.ts" });
    await result("read", "", { path: "/same.ts" });
    branch = [{ id: "root" }, { id: "branch-b" }];
    await result("read", "", { path: "/same.ts" });
    const rows = db.getEvents(sessionId, { type: "file_read" });
    expect(rows).toHaveLength(3);
    expect(rows.map(row => row.source_hook).join(" ")).toContain("result-call-3");
    const event = { type: "default_dedup", category: "pi", priority: 1, data: "same" };
    db.insertEvent(sessionId, event, "hook-a");
    db.insertEvent(sessionId, event, "hook-b");
    expect(db.getEvents(sessionId, { type: "default_dedup" })).toHaveLength(1);
  });

  it("discards prepared memory on tree navigation and never consumes an undelivered resume", async () => {
    await seed("RESUME_ON_BRANCH_A");
    branch.push({ id: "compact-a" });
    await trigger("session_compact", { compactionEntry: { id: "compact-a" } });
    await trigger("before_agent_start", { prompt: "Continue" });
    expect(db.getResume(sessionId)?.consumed).toBe(0);
    branch = [{ id: "root" }, { id: "branch-b" }];
    await trigger("session_tree");
    const messages: any[] = [];
    await trigger("context", { messages });
    expect(JSON.stringify(messages)).not.toContain("RESUME_ON_BRANCH_A");
    expect(JSON.stringify(await context())).not.toContain("RESUME_ON_BRANCH_A");
  });

  it("off disables automatic history while retaining captured searchable events", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "off";
    await seed("OFF_HISTORY");
    branch.push({ id: "compact-a" });
    await trigger("session_compact", { compactionEntry: { id: "compact-a" } });
    expect(JSON.stringify(await context())).not.toContain("OFF_HISTORY");
    expect(db.getEvents(sessionId).some(e => e.data === "OFF_HISTORY")).toBe(true);
  });

  it("keeps a scoped resume across reload but does not replay it into a new session", async () => {
    await seed("PERSISTED_COMPACT_HISTORY");
    branch.push({ id: "compact-a" });
    await trigger("session_compact", { compactionEntry: { id: "compact-a" } });
    // Reopen the real temporary database through a fresh extension registration.
    await trigger("session_shutdown");
    db.close();
    const ensure = vi.spyOn(SessionDB.prototype, "ensureSession");
    const { default: extension } = await import("../src/adapters/pi/extension.js");
    extension({ on: (name: string, fn: any) => { handlers[name] = fn; }, registerCommand: vi.fn(), registerTool: vi.fn() });
    await trigger("session_start");
    db = ensure.mock.contexts.at(-1)!;
    ensure.mockRestore();
    expect(JSON.stringify(await context())).toContain("PERSISTED_COMPACT_HISTORY");
    await trigger("session_start");
    expect(JSON.stringify(await context())).not.toContain("PERSISTED_COMPACT_HISTORY");
    ctx.sessionManager.getSessionFile = () => join(dir, "different-session.jsonl");
    await trigger("session_start");
    expect(JSON.stringify(await context())).not.toContain("PERSISTED_COMPACT_HISTORY");
  });

  it("fails closed for missing ancestry and legacy resume snapshots", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "always";
    await seed("SCOPED_HISTORY");
    db.upsertResume(sessionId, "<session_resume>LEGACY_RESUME</session_resume>", 1);
    ctx.sessionManager.getBranch = undefined;
    const text = JSON.stringify(await context());
    expect(text).not.toContain("SCOPED_HISTORY");
    expect(text).not.toContain("LEGACY_RESUME");
  });

  it("bounds automatic memory and leaves large source bodies available only through search", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "always";
    await result("ctx_search", "RAW_SOURCE_BODY_" + "x".repeat(40_000));
    for (let i = 0; i < 12; i++) await seed(`decision-${i} ` + "n".repeat(800));
    const messages = await context();
    const content = String(messages[0].content);
    expect(content).toContain("decision-11");
    expect(content).not.toContain("RAW_SOURCE_BODY_");
    const memory = content.slice(content.indexOf("<active_memory"));
    expect(memory.length).toBeLessThanOrEqual(2_000);
    expect(db.getEvents(sessionId).some(e => e.data.includes("RAW_SOURCE_BODY_"))).toBe(true);
  });

  it("points Pi history to timeline retrieval without a nonexistent source filter", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "always";
    await result("ctx_search", "stored source evidence");
    const text = String((await context())[0].content);
    expect(text).toContain('ctx_search({sort:"timeline", queries:["specific terms"]})');
    expect(text).not.toContain("session-events");
    expect(text).toContain("timestamps and original records");
    expect(text).toContain("use the timeline query above");
  });

  it("binds prompts after user persistence instead of the previous common ancestor", async () => {
    branch = [{ id: "common" }];
    const promptA = "Choose BRANCH_A_PLAN; keep this decision on A.";
    await trigger("before_agent_start", { prompt: promptA });
    await trigger("agent_start");
    await trigger("message_end", { message: { role: "user", content: promptA } });
    // Real SDK emits these hooks before appendMessage(user).
    expect(db.getEvents(sessionId).some(e => e.data.includes("BRANCH_A_PLAN"))).toBe(false);
    branch.push({ id: "user-a", type: "message", message: { role: "user", content: [{ type: "text", text: promptA }] } });
    await trigger("context", { messages: [] });
    const captured = db.getEvents(sessionId).find(e => e.data.includes("BRANCH_A_PLAN"))!;
    expect(captured?.source_hook).toContain("user-a");
    branch = [{ id: "common" }];
    await trigger("session_tree");
    const promptB = "Choose BRANCH_B_PLAN; keep this decision on B.";
    await trigger("before_agent_start", { prompt: promptB });
    branch.push({ id: "user-b", type: "message", message: { role: "user", content: promptB } });
    await trigger("context", { messages: [] });
    const selected = recentBranchEvents(db.getEvents(sessionId), ctx, 1);
    expect(selected.some(e => e.data.includes("BRANCH_A_PLAN"))).toBe(false);
    expect(selected.some(e => e.data.includes("BRANCH_B_PLAN"))).toBe(true);
  });

  it("binds tool observations to their persisted result, including nested calls", async () => {
    branch = [{ id: "assistant-call" }];
    await trigger("tool_result", { toolName: "ctx_search", toolCallId: "outer-1", input: {}, content: [{ type: "text", text: "RESULT_ONE" }] });
    expect(db.getEvents(sessionId)).toHaveLength(0);
    branch.push({ id: "result-one", type: "message", message: { role: "toolResult", toolCallId: "outer-1" } });
    await trigger("tool_result", { toolName: "graph_inspect", toolCallId: "nested-2", parentToolCallId: "outer-2", input: {}, content: [{ type: "text", text: "NESTED_TWO" }] });
    await trigger("tool_result", { toolName: "ctx_search", toolCallId: "outer-2", input: {}, content: [{ type: "text", text: "RESULT_TWO" }] });
    await trigger("message_end", { message: { role: "toolResult", toolCallId: "outer-2" } });
    expect(db.getEvents(sessionId).some(e => e.data.includes("RESULT_TWO"))).toBe(false);
    branch.push({ id: "result-two", type: "message", message: { role: "toolResult", toolCallId: "outer-2" } });
    await trigger("turn_end", {});
    expect(db.getEvents(sessionId).find(e => e.data.includes("NESTED_TWO"))?.source_hook).toContain("result-two");
    branch.pop();
    await trigger("session_tree");
    const selected = recentBranchEvents(db.getEvents(sessionId), ctx, 1);
    expect(selected.some(e => e.data.includes("RESULT_ONE"))).toBe(true);
    expect(selected.some(e => e.data.includes("RESULT_TWO") || e.data.includes("NESTED_TWO"))).toBe(false);
  });

  it("delivers a successful in-run compaction on context without before_agent_start", async () => {
    await seed("OVERFLOW_RECOVERY_HISTORY");
    branch.push({ id: "overflow-compact" });
    await trigger("session_compact", { compactionEntry: { id: "overflow-compact" } });
    const messages: any[] = [];
    await trigger("context", { messages });
    expect(JSON.stringify(messages)).toContain("OVERFLOW_RECOVERY_HISTORY");
    const retry: any[] = [];
    await trigger("context", { messages: retry });
    expect(JSON.stringify(retry)).not.toContain("OVERFLOW_RECOVERY_HISTORY");
  });

  it("flushes verified entries at shutdown and keeps unresolved captures searchable only", async () => {
    await trigger("tool_result", { toolName: "ctx_search", toolCallId: "saved-on-shutdown", input: {}, content: [{ type: "text", text: "PERSISTED_TOOL_EVIDENCE" }] });
    branch.push({ id: "saved-result", type: "message", message: { role: "toolResult", toolCallId: "saved-on-shutdown" } });
    await trigger("tool_result", { toolName: "ctx_search", toolCallId: "never-appended", input: {}, content: [{ type: "text", text: "UNRESOLVED_TOOL_EVIDENCE" }] });
    await trigger("session_shutdown");
    const rows = db.getEvents(sessionId);
    expect(rows.find(e => e.data.includes("PERSISTED_TOOL_EVIDENCE"))?.source_hook).toContain("saved-result");
    expect(rows.find(e => e.data.includes("UNRESOLVED_TOOL_EVIDENCE"))?.source_hook).toContain('"entryId":null');
    expect(recentBranchEvents(rows, ctx, 1).some(e => e.data.includes("UNRESOLVED_TOOL_EVIDENCE"))).toBe(false);
  });

  it("bounds unresolved capture queues and does not assign abandoned prompts to a later identical user message", async () => {
    const prompt = "Choose IDENTICAL_BRANCH_PLAN; keep evidence scoped.";
    await trigger("before_agent_start", { prompt });
    await trigger("session_tree");
    branch.push({ id: "other-user", type: "message", message: { role: "user", content: prompt } });
    await trigger("context", { messages: [] });
    expect(db.getEvents(sessionId).find(e => e.data.includes("IDENTICAL_BRANCH_PLAN"))?.source_hook).toContain('"entryId":null');
    for (let i = 0; i < 66; i++) await trigger("tool_result", {
      toolName: "ctx_search", toolCallId: `pending-${i}`, input: {}, content: [{ type: "text", text: `UNAPPENDED_${i}` }],
    });
    expect(db.getEvents(sessionId).some(e => e.data.includes("UNAPPENDED_0") && e.source_hook.includes('"entryId":null'))).toBe(true);
    expect(recentBranchEvents(db.getEvents(sessionId), ctx, 1).some(e => e.data.includes("UNAPPENDED_"))).toBe(false);
  });
});
