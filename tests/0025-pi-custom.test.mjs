import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piExtension from "../src/entries/pi.ts";
import { branchHistory, capturedResultInfo, PI_EVIDENCE_ENTRY, PI_HISTORY_LIMIT, PI_RESUME_ENTRY, PiCaptureBuffer } from "../src/entries/pi-history.ts";
import { INSTRUCTIONS } from "../src/entries/server.ts";

import { applyPiResponseBudget, normalizePiCall } from "../src/entries/pi-budget.ts";
import { openDb, closeDb } from "../src/core/store/db.ts";
import { ctxExecute } from "../src/core/tools/execute.ts";
import { ctxSearch } from "../src/core/tools/search.ts";
import { indexText } from "../src/core/index/text.ts";

describe("Pi fork: verified branch memory and in-process tools", { concurrency: false }, () => {
  let root;
  let originalEnvironment;
  let serial = 0;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "cm-pi-fork-"));
    originalEnvironment = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
      PI_CONTEXT_MODE_AUTO_MEMORY: process.env.PI_CONTEXT_MODE_AUTO_MEMORY };
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    delete process.env.PI_CONTEXT_MODE_AUTO_MEMORY;
  });
  after(() => {
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function fakeHost({ sourceEntries = [], transcriptEntries = sourceEntries, session = "session-" + ++serial, discovery, appendThrows = false } = {}) {
    const cwd = join(root, "project-" + ++serial);
    mkdirSync(cwd, { recursive: true });
    let entries = sourceEntries;
    const transcript = new Map(transcriptEntries.map(entry => [entry.id, entry]));
    const handlers = new Map();
    const tools = new Map();
    const ctx = { cwd, sessionManager: { getSessionId: () => session,
      getBranch: () => entries, getEntries: () => [...transcript.values()], getLeafId: () => entries.at(-1)?.id ?? null } };
    const api = {
      on: (name, handler) => handlers.set(name, handler), registerTool: tool => tools.set(tool.name, tool),
      appendEntry: (customType, data) => {
        if (appendThrows) throw new Error("transcript write failed");
        const entry = { id: "custom-" + ++serial, type: "custom", customType, data };
        entries.push(entry);
        transcript.set(entry.id, entry);
      }, ...discovery,
    };
    piExtension(api);
    return { ctx, handlers, tools, api,
      get entries() { return entries; },
      set entries(value) { for (const entry of [...entries, ...value]) transcript.set(entry.id, entry); entries = value; },
      async fire(name, event = {}) { return handlers.get(name)?.(event, ctx); },
      async start() { return handlers.get("before_agent_start")({ systemPrompt: "BASE" }, ctx); },
      async context(messages = []) { return handlers.get("context")({ messages }, ctx); },
    };
  }

  const user = (id, text) => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
  const result = (id, toolCallId, toolName, text, extra = {}) => ({ id, type: "message", message: {
    role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], ...extra,
  } });
  const historyText = (out) => out?.messages?.filter(message => message.customType === "context-mode-history")
    .map(message => message.content).join("\n") ?? "";

  test("current ctx_resume follows /tree ancestry and never promotes the abandoned branch", async () => {
    const shared = user("common", "Shared requirement");
    const host = fakeHost({ sourceEntries: [shared, user("a", "ABANDONED_PURPLE_WIDGETS")] });
    await host.start();
    await host.fire("input", { text: "ABANDONED_PURPLE_WIDGETS" });
    host.entries = [shared, user("b", "CURRENT_GREEN_WIDGETS")];
    await host.fire("session_tree");
    const reply = await host.tools.get("ctx_resume").execute("resume", {});
    assert.match(reply.content[0].text, /CURRENT_GREEN_WIDGETS/);
    assert.doesNotMatch(reply.content[0].text, /ABANDONED_PURPLE_WIDGETS/);
    assert.match(reply.content[0].text, /not current instructions or authorization/);
  });

  test("missing ancestry fails closed, and only explicit historical requests can read session-wide records", async () => {
    const host = fakeHost();
    delete host.ctx.sessionManager.getBranch;
    delete host.ctx.sessionManager.getLeafId;
    await host.start();
    await host.fire("input", { text: "UNSCOPED_HISTORICAL_REQUEST" });
    const summary = await host.tools.get("ctx_resume").execute("resume", {});
    assert.match(summary.content[0].text, /No verified current-branch history/);
    assert.doesNotMatch(summary.content[0].text, /UNSCOPED_HISTORICAL_REQUEST/);
  });

  test("history selects newest eligible entries and remains bounded with Unicode and long source bodies", () => {
    const entries = Array.from({ length: 80 }, (_, i) => user("user-" + i, "request " + i + " 🧭".repeat(100)));
    entries.push(result("tool-80", "call-80", "graph_query", "NEVER_REPLAY_RAW_GRAPH_BODY".repeat(500)));
    const history = branchHistory({ sessionManager: { getSessionId: () => "s", getBranch: () => entries } }, "s");
    assert.ok(history.length <= PI_HISTORY_LIMIT);
    assert.match(history, /request 79/);
    assert.doesNotMatch(history, /"entry":"user-0"|NEVER_REPLAY_RAW_GRAPH_BODY/);
    assert.doesNotMatch(history, /\uFFFD/);
  });

  test("history retains flat v2 and nested v1 execution status and exact source handles", () => {
    const entries = [
      result("v1", "c1", "ctx_execute", "old output", { details: { execution: { status: "backgrounded", source: "v1-source" } } }),
      result("v2", "c2", "ctx_execute", "new output", { details: { status: "failed", exitCode: 2, source: "s42" }, isError: true }),
    ];
    const text = branchHistory({ sessionManager: { getSessionId: () => "s", getBranch: () => entries } }, "s");
    assert.match(text, /"status":"backgrounded"/);
    assert.match(text, /"source":"v1-source"/);
    assert.match(text, /"status":"failed"/);
    assert.match(text, /"source":"s42"/);
    assert.match(text, /"exitCode":2/);
  });

  test("history retains the saved reply reference when a successful execution has only a Pi preview source", async () => {
    const host = fakeHost({ sourceEntries: [user("u-preview", "Inspect the complete output")] });
    await host.start();
    const output = await host.tools.get("ctx_execute").execute("preview-call", {
      language: "shell", code: "printf '%s' '" + "preview evidence ".repeat(130) + "'", maxOutputChars: 1000,
    });
    assert.equal(output.isError, false);
    assert.equal(output.details.source, undefined, "the output fits the core byte cap without indexing");
    assert.equal(typeof output.details.previewSource, "string", "Pi stores the character-limited reply");
    host.entries.push(result("preview-result", "preview-call", "ctx_execute", output.content[0].text,
      { details: output.details, isError: output.isError }));
    const history = branchHistory(host.ctx, host.ctx.sessionManager.getSessionId());
    assert.ok(history.includes(JSON.stringify({ previewSource: output.details.previewSource }).slice(1, -1)));
  });

  test("compact is the default: failed preparation injects nothing; successful same-run compaction delivers once", async () => {
    const host = fakeHost({ sourceEntries: [user("u1", "Keep the verified green requirement")] });
    const initial = await host.start();
    assert.equal(initial.systemPrompt, "BASE\n\n" + INSTRUCTIONS);
    assert.equal(await host.context(), undefined);
    await host.fire("session_before_compact");
    assert.equal(await host.context(), undefined);
    host.entries.push({ id: "compact-1", type: "compaction" });
    await host.fire("session_compact", { compactionEntry: { id: "compact-1" } });
    // No new before_agent_start: Pi overflow recovery continues within this run.
    const delivered = await host.context();
    assert.match(historyText(delivered), /verified green requirement/);
    assert.equal(await host.context(), undefined);
    assert.equal((await host.start()).systemPrompt, initial.systemPrompt);
  });

  test("undelivered compaction survives reload, is consumed after delivery, and cannot move to another session", async () => {
    const host = fakeHost({ session: "reload-session", sourceEntries: [user("u1", "RELOAD_ONLY_HISTORY"), { id: "compact", type: "compaction" }] });
    await host.start();
    await host.fire("session_compact", { compactionEntry: { id: "compact" } });
    assert.ok(host.entries.some(entry => entry.customType === PI_RESUME_ENTRY));
    const copied = structuredClone(host.entries);
    const reload = fakeHost({ session: "reload-session", sourceEntries: copied });
    await reload.start();
    assert.match(historyText(await reload.context()), /RELOAD_ONLY_HISTORY/);
    const secondReload = fakeHost({ session: "reload-session", sourceEntries: structuredClone(reload.entries) });
    await secondReload.start();
    assert.equal(await secondReload.context(), undefined);
    // A /tree rewind can hide the consumed marker from this branch, but it remains in the transcript.
    const rewound = fakeHost({ session: "reload-session", sourceEntries: structuredClone(host.entries),
      transcriptEntries: structuredClone(reload.entries) });
    await rewound.start();
    assert.equal(await rewound.context(), undefined);
    const other = fakeHost({ session: "different-session", sourceEntries: structuredClone(host.entries) });
    await other.start();
    assert.equal(await other.context(), undefined);
  });

  test("navigation discards undelivered branch history; a failed append cannot consume an undelivered response", async () => {
    const shared = user("common", "Shared requirement");
    const host = fakeHost({ sourceEntries: [shared, user("old", "ABANDONED_MEMORY"), { id: "compact-old", type: "compaction" }] });
    await host.start();
    await host.fire("session_compact", { compactionEntry: { id: "compact-old" } });
    host.entries = [shared, user("new", "ACTIVE_MEMORY")];
    await host.fire("session_tree");
    assert.equal(await host.context(), undefined);

    const failing = fakeHost({ appendThrows: true, sourceEntries: [user("u", "DELIVER_DESPITE_PERSISTENCE_ERROR"), { id: "c", type: "compaction" }] });
    await failing.start();
    await failing.fire("session_compact", { compactionEntry: { id: "c" } });
    assert.match(historyText(await failing.context()), /DELIVER_DESPITE_PERSISTENCE_ERROR/);
    assert.equal(await failing.context(), undefined);
  });

  test("off disables automatic memory, always delivers bounded current-branch observations without rewriting the system prompt", async () => {
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "off";
    const off = fakeHost({ sourceEntries: [user("u", "OFF_HISTORY"), { id: "c", type: "compaction" }] });
    await off.start();
    await off.fire("session_compact", { compactionEntry: { id: "c" } });
    assert.equal(await off.context(), undefined);
    assert.match((await off.tools.get("ctx_resume").execute("explicit", {})).content[0].text, /OFF_HISTORY/);
    process.env.PI_CONTEXT_MODE_AUTO_MEMORY = "always";
    const always = fakeHost({ sourceEntries: [user("u", "ALWAYS_HISTORY")] });
    const prompt = await always.start();
    const quoted = { role: "user", content: "Please review this quote: ALWAYS_HISTORY" };
    const out = await always.context([quoted]);
    assert.equal(out.messages[0], quoted);
    assert.match(historyText(out), /ALWAYS_HISTORY/);
    assert.doesNotMatch(prompt.systemPrompt, /ALWAYS_HISTORY/);
    assert.equal(await always.context(), undefined);
    delete process.env.PI_CONTEXT_MODE_AUTO_MEMORY;
  });

  test("core and resume tools stay direct; maintenance requires active verified discovery before deferring", async () => {
    const maintenance = ["ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge"];
    const host = fakeHost({ discovery: { getActiveTools: () => ["tool_search"],
      getAllTools: () => [{ name: "tool_search", reachesTools: () => "all" }] } });
    await host.start();
    assert.equal(host.tools.size, 9);
    for (const tool of host.tools.values()) assert.equal(tool.exposure, maintenance.includes(tool.name) ? "deferred" : "direct");
    for (const discovery of [{}, { getActiveTools: () => [], getAllTools: () => [{ name: "tool_search", reachesTools: () => "all" }] },
      { getActiveTools: () => ["tool_search"], getAllTools: () => [{ name: "tool_search" }] }]) {
      const fallback = fakeHost({ discovery });
      await fallback.start();
      assert.ok([...fallback.tools.values()].every(tool => tool.exposure === "direct"));
    }
  });

  test("structured graph evidence binds to the persisted result and stays searchable without changing the live result", async () => {
    const host = fakeHost({ sourceEntries: [user("u", "Inspect the graph")] });
    await host.start();
    const event = { toolName: "graph_query", toolCallId: "graph-1", input: { symbol: "Widget" },
      content: [{ type: "image", data: "DO_NOT_PERSIST_IMAGE_BYTES" }],
      structuredContent: { observation: "STRUCTURED_GRAPH_MARKER", status: "ready" } };
    const original = structuredClone(event);
    assert.equal(await host.fire("tool_result", event), undefined);
    assert.deepEqual(event, original);
    assert.ok(!host.entries.some(entry => entry.customType === PI_EVIDENCE_ENTRY));
    host.entries.push(result("persisted-tool", "graph-1", "graph_query", "", { details: event.structuredContent }));
    await host.fire("turn_end");
    const receipt = host.entries.find(entry => entry.customType === PI_EVIDENCE_ENTRY);
    assert.equal(receipt.data.entryId, "persisted-tool");
    assert.equal(receipt.data.toolCallId, "graph-1");
    const search = await host.tools.get("ctx_search").execute("search", { queries: ["STRUCTURED_GRAPH_MARKER"], source: receipt.data.source });
    assert.match(search.content[0].text, /STRUCTURED_GRAPH_MARKER/);
    assert.doesNotMatch(search.content[0].text, /DO_NOT_PERSIST_IMAGE_BYTES/);
  });

  test("native text remains complete in the main index even when the result also carries structured metadata", async () => {
    const host = fakeHost({ sourceEntries: [user("u", "Find the final native line")] });
    await host.start();
    const text = "ordinary native output line\n".repeat(3500) + "FULL_NATIVE_FINAL_MARKER\n";
    const replacement = await host.fire("tool_result", { toolName: "bash", toolCallId: "large-native", input: { command: "produce output" },
      content: [{ type: "text", text }], details: { status: "completed" }, isError: false });
    assert.ok(replacement?.content?.length);
    const found = await host.tools.get("ctx_search").execute("search-native", { queries: ["FULL_NATIVE_FINAL_MARKER"] });
    assert.match(found.content[0].text, /FULL_NATIVE_FINAL_MARKER/);
  });

  test("large mixed image/text results retain the original live shape and report no textual replacement", async () => {
    const host = fakeHost();
    await host.start();
    const event = { toolName: "image_tool", toolCallId: "image", input: {},
      content: [{ type: "text", text: "large text\n".repeat(1000) }, { type: "image", data: "IMAGE_BYTES" }] };
    const original = structuredClone(event);
    assert.equal(await host.fire("tool_result", event), undefined);
    assert.deepEqual(event, original);
  });

  test("capture binding supports nested results and fails closed across abandoned branches", () => {
    const buffer = new PiCaptureBuffer();
    let entries = [user("before", "request")];
    const ctx = { cwd: root, sessionManager: { getSessionId: () => "s", getBranch: () => entries, getLeafId: () => entries.at(-1).id } };
    buffer.enqueue({ toolName: "graph_nested", toolCallId: "child", parentToolCallId: "parent", structuredContent: { value: 1 } }, ctx, "s");
    assert.deepEqual(buffer.drain(ctx, "s"), []);
    entries.push(result("persisted-parent", "parent", "parent_tool", "parent result"));
    assert.equal(buffer.drain(ctx, "s")[0].entryId, "persisted-parent");
    buffer.enqueue({ toolName: "graph_other", toolCallId: "other", structuredContent: { value: 2 } }, ctx, "s");
    entries = [user("new-branch", "other request")];
    assert.equal(buffer.drain(ctx, "s", true)[0].entryId, null);
  });

  test("escaped graph observations stay below 8192 bytes and declare excerpt bounds of the captured text", () => {
    const event = { toolName: "graph_query", toolCallId: "escaped", input: { symbol: "\u0000".repeat(20_000) },
      content: [{ type: "text", text: "\u0000\"\\".repeat(40_000) }],
      structuredContent: { status: "STRUCTURED_STATUS", count: 9 } };
    assert.equal(capturedResultInfo(event).excerpted, true);
    const buffer = new PiCaptureBuffer();
    buffer.enqueue(event, undefined, "s");
    const capture = buffer.drain(undefined, "s", true)[0];
    assert.ok(Buffer.byteLength(capture.content) <= 8192);
    const observation = JSON.parse(capture.content);
    assert.equal(observation.excerpted, true);
    assert.equal(observation.digestScope, "captured-text");
    assert.match(observation.structured, /STRUCTURED_STATUS/);
  });

  test("Pi upgrade returns scoped guidance without migrating v1 data or host configuration", async () => {
    const host = fakeHost();
    const oldDir = join(root, ".context-mode", "sessions");
    const configDir = join(root, ".pi", "agent");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const oldFile = join(oldDir, "v1-preserve.txt");
    const configFile = join(configDir, "settings.json");
    writeFileSync(oldFile, "KEEP V1 DATA");
    writeFileSync(configFile, JSON.stringify({ packages: ["git:github.com/CGOSU/context-mode"] }));
    const beforeConfig = readFileSync(configFile, "utf8");
    await host.start();
    const out = await host.tools.get("ctx_upgrade").execute("upgrade", {});
    assert.match(out.content[0].text, /original source|source checkout/);
    assert.match(out.content[0].text, /npm run build:pi/);
    assert.match(out.content[0].text, /release-out/);
    assert.doesNotMatch(out.content[0].text, /pi update --extensions|npm update -g context-mode/);
    assert.equal(readFileSync(oldFile, "utf8"), "KEEP V1 DATA");
    assert.equal(readFileSync(configFile, "utf8"), beforeConfig);
  });

  test("Pi budgets preserve required upstream schema fields and propagate failure metadata", async () => {
    const host = fakeHost();
    await host.start();
    const execute = host.tools.get("ctx_execute");
    assert.ok(execute.parameters.properties.maxOutputChars);
    assert.ok(execute.parameters.required.includes("language"));
    assert.ok(execute.parameters.required.includes("code"));
    const badBudget = await execute.execute("bad-budget", { language: "shell", code: "printf okay", maxOutputChars: 5 });
    assert.equal(badBudget.isError, true);
    assert.match(badBudget.content[0].text, /maxOutputChars/);
    const invalid = await execute.execute("large-invalid-call", { language: "shell", code: "printf okay", maxOutputChars: 1000,
      ["invalid_argument_".repeat(1500)]: true });
    assert.equal(invalid.isError, true);
    assert.ok(invalid.content[0].text.length <= 1000);
    assert.ok(invalid.details.previewSource);
    const failure = await execute.execute("failed", { language: "shell", code: "printf failure >&2; exit 2", maxOutputChars: 1000 });
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /failure|exit 2/);
    assert.equal(failure.details.status, "failed");
    assert.equal(failure.details.exitCode, 2);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctx-pi-budget-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  return { root, ctx: {
    project: { projectKey: "1".repeat(16), projectDir: join(root, "data"), dbPath: join(root, "data/context.db"),
      worktree: workspace, containmentRoot: workspace, agent: "pi", source: "pi:ctx.cwd" },
    sessionId: "pi-budget-session", turn: 1, signal: new AbortController().signal, protocolVersion: "",
  } };
}

test("Pi shortened replies preserve the complete evidence, unique snapshots, and failure/source metadata", async () => {
  const { root, ctx } = fixture();
  try {
    const full = "Failure diagnostic\n" + "中文😀 evidence\n".repeat(2000) + "UNIQUE_TAIL_EVIDENCE";
    const original = { text: full, isError: true, sandboxBytes: 100,
      details: { status: "timed_out", exitCode: 124, source: "@1", sourceId: 1 } };
    const short = await applyPiResponseBudget("ctx_execute", original, ctx, 1000);
    assert.ok(short.text.length <= 1000);
    assert.equal(short.isError, true);
    assert.match(short.text, /timed_out; exit 124/);
    assert.match(short.text, /Failure diagnostic/);
    assert.match(short.text, /Original source: @1/);
    assert.equal(short.details.source, "@1");
    assert.ok(!/[\uD800-\uDBFF]$/.test(short.text));
    const again = await applyPiResponseBudget("ctx_execute", original, ctx, 1000);
    assert.notEqual(short.details.previewSourceId, again.details.previewSourceId);
    const db = await openDb(ctx.project);
    try {
      const text = db.raw.prepare("SELECT body FROM chunks WHERE source_id = ? ORDER BY CAST(ord AS INTEGER)")
        .all(short.details.previewSourceId).map(row => row.body).join("\n");
      assert.ok(text.includes("UNIQUE_TAIL_EVIDENCE"));
    } finally { closeDb(db); }
    const found = await ctxSearch.handler({ queries: ["UNIQUE_TAIL_EVIDENCE"], source: short.details.previewSource }, ctx);
    assert.match(found.text, /UNIQUE_TAIL_EVIDENCE/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi can expand execution previews beyond the upstream fixed cap while default responses remain bounded", async () => {
  const { root, ctx } = fixture();
  try {
    const input = { language: "javascript", code: 'console.log("q".repeat(18000))' };
    const expanded = normalizePiCall("ctx_execute", { ...input, maxOutputChars: 20000 });
    const expandedCtx = { ...ctx, outputBudgetBytes: expanded.maxOutputChars * 4 };
    const long = await applyPiResponseBudget("ctx_execute", await ctxExecute.handler(expanded.params, expandedCtx), expandedCtx, expanded.maxOutputChars);
    assert.equal(long.text, "q".repeat(18000) + "\n");
    const normal = normalizePiCall("ctx_execute", input);
    const defaultCtx = { ...ctx, outputBudgetBytes: normal.maxOutputChars * 4 };
    const short = await applyPiResponseBudget("ctx_execute", await ctxExecute.handler(normal.params, defaultCtx), defaultCtx, normal.maxOutputChars);
    assert.ok(short.text.length <= 12000);
    assert.ok(short.details.previewSource);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi preview references cannot collide with existing user source labels", async () => {
  const { root, ctx } = fixture();
  try {
    const db = await openDb(ctx.project);
    let originalId;
    try {
      originalId = indexText(db, ctx.project, ctx.sessionId, "s2", "ORIGINAL_USER_EVIDENCE", "text").sourceId;
    } finally { closeDb(db); }
    const short = await applyPiResponseBudget("ctx_search", {
      text: "SAVED_PREVIEW_EVIDENCE " + "x".repeat(15000), isError: false, sandboxBytes: 0,
    }, ctx, 1000);
    assert.equal(short.details.previewSourceId, 2);
    assert.match(short.details.previewSource, /^pi-preview:ctx_search:/);
    const found = await ctxSearch.handler({ queries: [""], source: short.details.previewSource }, ctx);
    assert.match(found.text, /SAVED_PREVIEW_EVIDENCE/);
    assert.doesNotMatch(found.text, /ORIGINAL_USER_EVIDENCE/);
    const original = await ctxSearch.handler({ queries: [""], source: "s2" }, ctx);
    assert.match(original.text, /ORIGINAL_USER_EVIDENCE/);
    const after = await openDb(ctx.project);
    try {
      assert.equal(after.raw.prepare("SELECT body FROM chunks WHERE source_id = ?").get(originalId).body, "ORIGINAL_USER_EVIDENCE");
    } finally { closeDb(after); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("Pi reports a storage failure honestly when a preview cannot be preserved", async () => {
  const { root, ctx } = fixture();
  try {
    const bad = { ...ctx, project: { ...ctx.project, dbPath: root } };
    const result = await applyPiResponseBudget("ctx_search", { text: "x".repeat(15000), isError: false, sandboxBytes: 0 }, bad, 1000);
    assert.equal(result.isError, true);
    assert.equal(result.details.storageError, true);
    assert.equal(result.details.previewSource, undefined);
    assert.match(result.text, /Output storage failed/);
    assert.doesNotMatch(result.text, /Search saved reply: ctx_search/);
    assert.ok(result.text.length <= 1000);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
