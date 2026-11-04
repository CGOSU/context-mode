import { afterEach, describe, expect, test, vi } from "vitest";
import { ContentStore } from "../../src/store.js";
import { registerExecutionTools } from "../../src/server-execution.js";
import { createExecutionSource } from "../../src/execution-source.js";
import type { ServerToolContext } from "../../src/server.js";
import type { ExecResult } from "../../src/types.js";

const stores: ContentStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.restoreAllMocks(); });

function fixture(initial: Partial<ExecResult> = {}) {
  const store = new ContentStore(":memory:");
  stores.push(store);
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const schemas = new Map<string, any>();
  const result = { stdout: "short output", stderr: "", exitCode: 0, timedOut: false, ...initial };
  const run = vi.fn(async () => ({ ...result }));
  let sessionId = "session-one";
  registerExecutionTools({
    server: {
      registerTool: (name: string, metadata: any, handler: any) => {
        handlers.set(name, handler); schemas.set(name, metadata.inputSchema);
      },
      server: { getClientVersion: () => ({ name: "pi-coding-agent-context-mode-bridge" }) },
    },
    executor: { execute: run, executeFile: run },
    getStore: () => store,
    currentAttribution: () => ({ sessionId }),
    trackResponse: (_tool: string, response: unknown) => response,
    trackIndexed: () => {},
    checkDenyPolicy: () => undefined,
    checkNonShellDenyPolicy: () => undefined,
    checkProjectBoundary: () => undefined,
    checkFilePathDenyPolicy: () => undefined,
    sessionStats: { bytesSandboxed: 0 }, bunNote: "", langList: "shell",
  } as unknown as ServerToolContext);
  return {
    store, result, run, setSession: (id: string) => { sessionId = id; },
    call: (name = "ctx_execute", args: object = {}) => handlers.get(name)!(schemas.get(name).parse({
      language: "shell", code: "run-checks", path: "sample.log", ...args,
    })),
  };
}
const body = (result: any): string => result.content.map((c: any) => c.text).join("\n");

describe("execution histories and truthful completion states", () => {
  test.each(["ctx_execute", "ctx_execute_file"])("%s repeated intent outputs remain independently searchable", async (tool) => {
    const { store, result, call } = fixture({ stdout: "albatross evidence\n".repeat(400) });
    const first = await call(tool, { intent: "albatross" });
    result.stdout = "kingfisher evidence\n".repeat(400);
    const second = await call(tool, { intent: "kingfisher" });
    const a = first.structuredContent.execution;
    const b = second.structuredContent.execution;
    expect(a.source).not.toBe(b.source);
    expect(a.outputIndexed).toBe(true);
    expect(body(first)).toContain(a.source);
    expect(store.searchWithFallback("albatross", 5, a.source).length).toBeGreaterThan(0);
    expect(store.searchWithFallback("kingfisher", 5, b.source).length).toBeGreaterThan(0);
    expect(store.listSources()).toHaveLength(2);
  });

  test.each(["ctx_execute", "ctx_execute_file"])("%s timeout preserves both streams, bounds preview, and remains failed", async (tool) => {
    const { store, call } = fixture({ stdout: "partial-progress\n".repeat(2000), stderr: "timeout-diagnostic-needle", timedOut: true });
    const result = await call(tool, { timeout: 10, maxOutputChars: 1000 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.execution).toMatchObject({ status: "timed_out", timedOut: true, outputIndexed: true });
    expect(body(result).length).toBeLessThanOrEqual(1000);
    expect(body(result)).toMatch(/timed.out/);
    const source = result.structuredContent.execution.source;
    expect(body(result)).toContain(source);
    expect(store.searchWithFallback("timeout-diagnostic-needle", 5, source).length).toBeGreaterThan(0);
    expect(store.searchWithFallback("timed_out", 5, source).some(hit => hit.content.includes("captured output is partial"))).toBe(true);
  });

  test.each(["", "listening"])("background timeout with %j stdout is still running, without a final exit code", async (stdout) => {
    const { call } = fixture({ stdout, timedOut: true, backgrounded: true });
    const result = await call("ctx_execute", { timeout: 10, background: true });
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent.execution).toMatchObject({ status: "backgrounded", exitCode: null, backgrounded: true });
    expect(body(result)).toContain("still running");
  });

  test("large shell failure retains stderr after a bounded preview", async () => {
    const { store, call } = fixture({ stdout: "test-progress\n".repeat(3000), stderr: "unique-assertion-failure", exitCode: 1 });
    const result = await call();
    expect(result.isError).toBe(true);
    expect(result.structuredContent.execution).toMatchObject({ status: "failed", exitCode: 1, outputIndexed: true });
    expect(body(result).length).toBeLessThanOrEqual(12_000);
    expect(store.searchWithFallback("unique-assertion-failure", 5, result.structuredContent.execution.source).length).toBeGreaterThan(0);
  });

  test("large success indexes full captured output before limiting the Pi preview", async () => {
    const { store, call } = fixture({ stdout: "large-progress\n".repeat(2000) + "final-proof-needle" });
    const result = await call();
    expect(body(result).length).toBeLessThanOrEqual(12_000);
    expect(result.structuredContent.execution.outputIndexed).toBe(true);
    expect(store.searchWithFallback("final-proof-needle", 5, result.structuredContent.execution.source).length).toBeGreaterThan(0);
  });

  test("huge runtime exceptions are failed, bounded, and retrievable", async () => {
    const { store, call, run } = fixture();
    run.mockRejectedValueOnce(new Error("runtime evidence\n".repeat(3000) + "runtime-tail-needle"));
    const result = await call("ctx_execute_file", { maxOutputChars: 1000 });
    expect(result.isError).toBe(true);
    expect(body(result).length).toBeLessThanOrEqual(1000);
    expect(store.searchWithFallback("runtime-tail-needle", 5, result.structuredContent.execution.source).length).toBeGreaterThan(0);
  });

  test("storage failure never promises recall or changes the execution outcome", async () => {
    const { store, call } = fixture({ stdout: "large-progress\n".repeat(2000), exitCode: 1 });
    vi.spyOn(store, "indexPlainText").mockImplementation(() => { throw new Error("storage unavailable"); });
    const result = await call("ctx_execute", { maxOutputChars: 1000 });
    expect(result.isError).toBe(true);
    expect(result.structuredContent.execution).toMatchObject({ status: "failed", outputIndexed: false });
    expect(body(result)).toContain("not indexed");
    expect(body(result)).not.toContain("evidence remains indexed");
    expect(body(result).length).toBeLessThanOrEqual(1000);
  });

  test("failed retention cleanup does not prevent storing the current execution", async () => {
    const { store, call } = fixture({ stdout: "durable evidence\n".repeat(2000) });
    vi.spyOn(store, "cleanupStaleSources").mockImplementation(() => { throw new Error("cleanup busy"); });
    const response = await call();
    expect(response.isError).toBe(false);
    expect(response.structuredContent.execution.outputIndexed).toBe(true);
    expect(store.listSources()).toHaveLength(1);
  });

  test("explicit document snapshots still replace while execution IDs never collide", () => {
    const { store } = fixture();
    store.indexPlainText("old snapshot", "document:readme");
    store.indexPlainText("new snapshot", "document:readme");
    expect(store.listSources()).toHaveLength(1);
    const ids = new Set(Array.from({ length: 100 }, () => createExecutionSource("execute:shell", "session-one")));
    expect(ids.size).toBe(100);
    expect([...ids].every(id => !id.includes("session-one"))).toBe(true);
  });

  test("execution attribution is captured before an asynchronous session change", async () => {
    const { store, call, run, setSession } = fixture();
    const index = vi.spyOn(store, "indexPlainText");
    run.mockImplementationOnce(async () => {
      setSession("session-two");
      return { stdout: "proof\n".repeat(3000), stderr: "", exitCode: 0, timedOut: false };
    });
    await call();
    expect(index.mock.calls[0][3]).toEqual({ sessionId: "session-one" });
  });
});
