/** Server regressions: analytics. */


import { describe, test, expect } from "vitest";
import { ContentStore } from "../../src/store.js";




// ─────────────────────────────────────────────────────────
// homedir() import smoke test (round-5 finding from cluster C+E+G).
// The merge at 43c63cb dropped this import; b8ca35e restored it. A future
// merge could lose it again silently. Pin the contract: enumerateAdapterDirs
// must work with a stubbed home and resolve to a path under that home.
// ─────────────────────────────────────────────────────────
describe("analytics homedir() import is alive (#43c63cb regression guard)", () => {
  test("enumerateAdapterDirs() resolves a sessionsDir under the host home", async () => {
    const { enumerateAdapterDirs } = await import("../../src/session/analytics.js");
    const { homedir } = await import("node:os");
    const dirs = enumerateAdapterDirs();
    expect(dirs.length).toBeGreaterThan(0);
    // At least one entry must mention the actual home directory — proves
    // homedir() resolution is wired all the way through.
    const home = homedir();
    expect(dirs.every((d) => d.sessionsDir.startsWith(home))).toBe(true);
  });
});


describe("ctx_stats cache observability + index_state (issue #697)", () => {
  test("ContentStore.getIndexState aggregates totals correctly", async () => {
    const store = new ContentStore(":memory:");
    expect(store.getIndexState()).toEqual({ totalChunks: 0, totalSources: 0, lastIndexedAt: undefined });
    store.index({ content: "# A\n\nalpha\n", source: "src-alpha" });
    store.index({ content: "# B\n\nbeta\n\n# C\n\ngamma\n", source: "src-beta" });
    const state = store.getIndexState();
    expect(state.totalSources).toBe(2);
    expect(state.totalChunks).toBeGreaterThanOrEqual(2);
    expect(state.lastIndexedAt).toBeDefined();
    expect(typeof state.lastIndexedAt).toBe("string");
  });

  test("AnalyticsEngine exposes cache_hit_rate computed from hits + misses (no Observability rendering)", async () => {
    // hit_rate is still computed correctly on the report; we just don't render
    // the machine-readable Observability block in ctx_stats output any more.
    const { AnalyticsEngine, formatReport } = await import("../../src/session/analytics.js");
    const Database = (await import("better-sqlite3")).default;
    const sdb = new Database(":memory:");
    sdb.exec(`
      CREATE TABLE session_meta (session_id TEXT PRIMARY KEY, started_at TEXT, compact_count INTEGER DEFAULT 0);
      CREATE TABLE session_events (id INTEGER PRIMARY KEY, session_id TEXT, category TEXT, type TEXT, data TEXT, created_at TEXT);
      CREATE TABLE session_resume (id INTEGER PRIMARY KEY, session_id TEXT, event_count INTEGER, consumed INTEGER, created_at TEXT);
    `);
    const engine = new AnalyticsEngine(sdb);
    const report = engine.queryAll({
      bytesReturned: {},
      bytesIndexed: 0,
      bytesSandboxed: 0,
      calls: {},
      sessionStart: Date.now() - 60_000,
      cacheHits: 3,
      cacheMisses: 1,
      cacheBytesSaved: 1024,
    });
    expect(report.cache).toBeDefined();
    expect(report.cache?.hits).toBe(3);
    expect(report.cache?.misses).toBe(1);
    expect(report.cache?.hit_rate).toBeCloseTo(0.75, 5);

    // formatReport MUST NOT emit the Observability block any longer — neither
    // on the narrative path nor on the legacy path, regardless of whether
    // indexState is passed.
    const textLegacy = formatReport(report, "0.0.0-test", null, {
      indexState: { totalChunks: 42, totalSources: 7, lastIndexedAt: "2026-05-24T12:00:00" },
    });
    expect(textLegacy).not.toContain("## Observability");
    expect(textLegacy).not.toContain("cache.hit_rate:");
    expect(textLegacy).not.toContain("index.total_chunks");
    expect(textLegacy).not.toContain("index.total_sources");
    expect(textLegacy).not.toContain("index.last_indexed_at");

    // Same expectation on the narrative early-return path.
    const conversation = {
      sessionId: "observability-removed-narrative-test",
      events: 12,
      dbCount: 1,
      daysAlive: 1.5,
      snapshotBytes: 0,
      snapshotsConsumed: 0,
      byCategory: [],
      firstEventMs: Date.now() - 86_400_000,
      lastEventMs: Date.now(),
    };
    const textNarrative = formatReport(report, "0.0.0-test", null, {
      conversation: conversation as any,
      indexState: { totalChunks: 42, totalSources: 7, lastIndexedAt: "2026-05-24T12:00:00" },
      cwd: "/test/repo",
      now: 1716552000000,
      locale: "en-US",
      tz: "UTC",
    });
    expect(textNarrative).not.toContain("## Observability");
    expect(textNarrative).not.toContain("cache.hit_rate:");
    expect(textNarrative).not.toContain("index.total_chunks");
    expect(textNarrative).not.toContain("index.total_sources");
    expect(textNarrative).not.toContain("index.last_indexed_at");
  });
});
