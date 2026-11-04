import { afterEach, describe, expect, test } from "vitest";
import { ContentStore } from "../../src/store.js";
import { registerSearchTool } from "../../src/server-search.js";
import { registerBatchTool } from "../../src/server-batch.js";
import { runBatchCommands } from "../../src/server-batch.js";
import { boundResponse } from "../../src/response-budget.js";
import { buildCtxSearchInputSchema } from "../../src/search/ctx-search-schema.js";
import { searchAllSources } from "../../src/search/unified.js";
import type { ServerToolContext } from "../../src/server.js";

const stores: ContentStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

function fixture(result = { stdout: "needle proof", stderr: "", exitCode: 0, timedOut: false }) {
  const store = new ContentStore(":memory:");
  stores.push(store);
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const context = {
    server: {
      registerTool: (name: string, _metadata: unknown, handler: any) => handlers.set(name, handler),
      server: { getClientVersion: () => ({ name: "pi-coding-agent-context-mode-bridge" }) },
    },
    getStore: () => store,
    currentAttribution: () => ({ sessionId: "budget-test" }),
    trackResponse: (_name: string, value: unknown) => value,
    trackIndexed: () => {},
    getProjectDir: () => "/unused-budget-test",
    getSessionDir: () => "/unused-budget-test",
    _detectedAdapter: { getConfigDir: () => "/unused-budget-test" },
    executor: { execute: async () => result },
    checkDenyPolicy: () => undefined,
    runtimes: { shell: "/bin/sh" },
    CM_FS_PRELOAD: "/unused-preload",
    sessionStats: { bytesSandboxed: 0 },
  } as unknown as ServerToolContext;
  registerSearchTool(context);
  registerBatchTool(context);
  return { store, context, call: (name: string, args: object) => handlers.get(name)!(args) };
}

const body = (result: any): string => result.content.map((c: any) => c.text ?? "").join("\n");

describe("bounded retrieval with retained evidence", () => {
  test("persisted content is not labelled as current-session or assigned a fabricated current timestamp", () => {
    const results = searchAllSources({
      query: "needle", limit: 3, store: {} as ContentStore,
      search: (() => [{ title: "Old proof", content: "needle", source: "old-source" }]) as any,
    });
    expect(results[0].origin).toBe("indexed-content");
    expect(results[0].timestamp).toBeUndefined();
  });
  test("search schema rejects unbounded/invalid result limits and budgets", () => {
    const schema = buildCtxSearchInputSchema(false);
    for (const limit of [-1, 0, 1.5, 21]) expect(schema.safeParse({ limit }).success).toBe(false);
    for (const maxOutputChars of [999, 1e9]) expect(schema.safeParse({ maxOutputChars }).success).toBe(false);
    expect(schema.parse({ limit: "5", maxOutputChars: "1200" })).toMatchObject({ limit: 5, maxOutputChars: 1200 });
  });

  test("preview boundaries keep unicode intact", () => {
    const result = boundResponse("🙂".repeat(1000), 1000, "more");
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.isWellFormed()).toBe(true);
  });
  test("Pi search caps the complete response, including no-match query headings", async () => {
    const { store, call } = fixture();
    store.index({ source: "proof-source", content: "# Proof\n" + "needle detail ".repeat(1000) });
    const found = body(await call("ctx_search", { queries: Array(60).fill("needle"), limit: 3 }));
    expect(found.length).toBeLessThanOrEqual(12_000);
    expect(found).toContain("proof-source");
    expect(found).toContain("output cap reached");
    const missing = body(await call("ctx_search", { queries: Array(60).fill("nomatch".repeat(200)), limit: 3 }));
    expect(missing.length).toBeLessThanOrEqual(12_000);
    expect(missing).toContain("output cap reached");
    expect(store.getStats().chunks).toBeGreaterThan(0);
  });

  test("an explicit smaller search budget retains a source and an expansion notice", async () => {
    const { store, call } = fixture();
    store.index({ source: "focused-proof", content: "# Proof\n" + "needle detail ".repeat(1000) });
    const text = body(await call("ctx_search", { queries: ["needle"], maxOutputChars: 1000 }));
    expect(text.length).toBeLessThanOrEqual(1000);
    expect(text).toContain("focused-proof");
    expect(text).toContain("output cap reached");
  });

  test("same-label batches retain both executions and return their distinct sources", async () => {
    const { store, call } = fixture();
    const args = { commands: [{ label: "checks", command: "run-checks" }], queries: ["needle"], concurrency: 1 };
    const first = body(await call("ctx_batch_execute", args));
    const second = body(await call("ctx_batch_execute", args));
    const sources = store.listSources();
    expect(sources).toHaveLength(2);
    expect(sources[0].label).not.toBe(sources[1].label);
    expect(sources.some(s => first.includes(s.label))).toBe(true);
    expect(sources.some(s => second.includes(s.label))).toBe(true);
  });

  test.each([
    { stdout: "needle partial", stderr: "", exitCode: 1, timedOut: false },
    { stdout: "needle partial", stderr: "timeout detail", exitCode: 0, timedOut: true },
  ])("failed batches keep status outside bounded previews: %j", async (execution) => {
    const { store, call } = fixture(execution);
    const result = await call("ctx_batch_execute", {
      commands: [{ label: "checks", command: "run-checks" }],
      queries: Array(30).fill("needle"), concurrency: 1, maxOutputChars: 1000,
    });
    expect(result.isError).toBe(true);
    expect(body(result).length).toBeLessThanOrEqual(1000);
    expect(body(result)).toMatch(/failed|timed out/i);
    expect(store.getStats().chunks).toBeGreaterThan(0);
  });

  test("large batch inventories cannot crowd all matching evidence out of the response", async () => {
    const { call } = fixture({ stdout: "needle ANSWER_PROOF", stderr: "", exitCode: 0, timedOut: false });
    const result = await call("ctx_batch_execute", {
      commands: Array.from({ length: 60 }, (_, i) => ({ label: `section-${i}`, command: "x".repeat(2000) })),
      queries: ["needle"], concurrency: 1,
    });
    expect(result.isError).toBe(false);
    expect(body(result).length).toBeLessThanOrEqual(12_000);
    expect(body(result)).toContain("ANSWER_PROOF");
    expect(body(result)).toContain("Source: batch:");
    expect(result.structuredContent.batch.totalCommands).toBe(60);
    expect(result.structuredContent.batch.outcomes.length).toBeLessThanOrEqual(50);
    expect(result.structuredContent.batch.omittedOutcomes).toBe(10);
  });

  test("a serial executor error retains previous evidence and marks later commands skipped", async () => {
    const { store, context, call } = fixture();
    context.executor.execute = (async ({ code }: { code: string }) => {
      if (code.includes("explode")) throw new Error("spawn error");
      return { stdout: "earlier-proof", stderr: "", exitCode: 0, timedOut: false };
    }) as any;
    const result = await call("ctx_batch_execute", {
      commands: [{ label: "first", command: "ok" }, { label: "second", command: "explode" }, { label: "third", command: "later" }],
      queries: ["earlier-proof"], concurrency: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.batch.outcomes.map((o: any) => o.status)).toEqual(["completed", "failed", "skipped"]);
    expect(store.searchWithFallback("earlier-proof", 3, result.structuredContent.batch.source).length).toBeGreaterThan(0);
    expect(body(result)).toContain("Attempted 2/3");
  });

  test("parallel executor throws and failed exit codes remain failures with sibling output", async () => {
    const result = await runBatchCommands(
      [{ label: "ok", command: "ok" }, { label: "failed", command: "fail" }, { label: "crash", command: "crash" }],
      { timeout: undefined, concurrency: 3, nodeOptsPrefix: "" },
      { execute: async ({ code }) => {
        if (code === "crash") throw new Error("spawn error");
        return { stdout: `${code} evidence`, exitCode: code === "fail" ? 1 : 0 };
      } },
    );
    expect(result.outcomes.map(o => o.status)).toEqual(["completed", "failed", "failed"]);
    expect(result.outputs.join("\n")).toContain("ok evidence");
    expect(result.outputs.join("\n")).toContain("spawn error");
  });
});
