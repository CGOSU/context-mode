import { afterEach, expect, test, vi } from "vitest";
import { cleanupExecutionSources, createExecutionSource } from "../../src/execution-source.js";

afterEach(() => { vi.useRealTimers(); });

test("long-lived stores apply the existing 14-day retention at most daily", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const store = { cleanupStaleSources: vi.fn(() => 0) };
  cleanupExecutionSources(store);
  cleanupExecutionSources(store);
  expect(store.cleanupStaleSources).toHaveBeenCalledExactlyOnceWith(14);
  vi.setSystemTime(new Date("2026-01-01T23:59:59Z"));
  cleanupExecutionSources(store);
  expect(store.cleanupStaleSources).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
  cleanupExecutionSources(store);
  expect(store.cleanupStaleSources).toHaveBeenCalledTimes(2);
  const reopened = { cleanupStaleSources: vi.fn(() => 0) };
  cleanupExecutionSources(reopened);
  expect(reopened.cleanupStaleSources).toHaveBeenCalledExactlyOnceWith(14);
});

test("failed cleanup is isolated and retried the next day, including after a backwards clock change", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const store = { cleanupStaleSources: vi.fn(() => { throw new Error("database busy"); }) };
  expect(() => cleanupExecutionSources(store)).not.toThrow();
  cleanupExecutionSources(store);
  expect(store.cleanupStaleSources).toHaveBeenCalledTimes(1);
  vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
  expect(() => cleanupExecutionSources(store)).not.toThrow();
  expect(store.cleanupStaleSources).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date("2025-12-01T00:00:00Z"));
  expect(() => cleanupExecutionSources(store)).not.toThrow();
  expect(store.cleanupStaleSources).toHaveBeenCalledTimes(3);
});

test("long labels cannot displace the execution ID or exceed the minimum preview budget", () => {
  const source = createExecutionSource("file:" + "huge\npath".repeat(1000), "session");
  expect(source.length).toBeLessThan(200);
  expect(source).not.toContain("\n");
  expect(source).toMatch(/:session:[a-f0-9]{16}:run:[a-f0-9-]{36}$/);
});
