/** Server regressions: pool. */


import { createRequire } from "node:module";
import { describe, test, expect } from "vitest";
// ═══════════════════════════════════════════════════════════════════════════
// runPool — shared concurrency primitive (PRD finding G)
// ═══════════════════════════════════════════════════════════════════════════

import { runPool, type PoolJob } from "../../src/runPool.js";




// ═══════════════════════════════════════════════════════════════════════════
// 3. Turndown HTML-to-markdown conversion
// ═══════════════════════════════════════════════════════════════════════════

// Resolve turndown path the same way server.ts will
const require = createRequire(import.meta.url);


describe("runPool primitive", () => {
  test("empty jobs returns empty settled array", async () => {
    const { settled, effectiveConcurrency, capped } = await runPool([], { concurrency: 4 });
    expect(settled).toHaveLength(0);
    expect(effectiveConcurrency).toBe(0);
    expect(capped).toBe(false);
  });

  test("happy path: order preserved, all fulfilled", async () => {
    const jobs: PoolJob<number>[] = [10, 20, 30, 40].map((v, i) => ({
      run: async () => {
        await new Promise((r) => setTimeout(r, (4 - i) * 10)); // reverse-order delay
        return v;
      },
    }));
    const { settled, effectiveConcurrency } = await runPool(jobs, { concurrency: 4 });
    expect(effectiveConcurrency).toBe(4);
    expect(settled.map((s) => s.status === "fulfilled" ? s.value : null)).toEqual([10, 20, 30, 40]);
  });

  test("throw isolation: one job rejects, siblings still fulfill", async () => {
    const jobs: PoolJob<string>[] = [
      { run: async () => "a" },
      { run: async () => { throw new Error("boom"); } },
      { run: async () => "c" },
    ];
    const { settled } = await runPool(jobs, { concurrency: 3 });
    expect(settled[0]).toEqual({ status: "fulfilled", value: "a" });
    expect(settled[1].status).toBe("rejected");
    expect((settled[1] as { reason: Error }).reason.message).toBe("boom");
    expect(settled[2]).toEqual({ status: "fulfilled", value: "c" });
  });

  test("in-flight cap: never exceeds concurrency", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const jobs: PoolJob<void>[] = Array.from({ length: 10 }, () => ({
      run: async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
      },
    }));
    const { effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThanOrEqual(2); // proves at least some parallelism
    expect(effectiveConcurrency).toBe(3);
    expect(capped).toBe(false);
  });

  test("auto-clamp to job count when concurrency > jobs.length", async () => {
    const jobs: PoolJob<number>[] = [{ run: async () => 1 }, { run: async () => 2 }];
    const { effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 8 });
    expect(effectiveConcurrency).toBe(2);
    expect(capped).toBe(true);
  });

  test("capByCpuCount caps by os.cpus().length", async () => {
    // We can't predict the test runner's cpu count, so just assert the bounds.
    const jobs: PoolJob<number>[] = Array.from({ length: 32 }, (_, i) => ({ run: async () => i }));
    const { effectiveConcurrency, capped } = await runPool(jobs, { concurrency: 32, capByCpuCount: true });
    const cores = require("node:os").cpus().length;
    expect(effectiveConcurrency).toBeLessThanOrEqual(cores);
    expect(effectiveConcurrency).toBeLessThanOrEqual(32);
    expect(capped).toBe(effectiveConcurrency < 32);
  });

  test("onSettled callback fires per job in completion order", async () => {
    const events: number[] = [];
    const jobs: PoolJob<number>[] = [
      { run: async () => { await new Promise((r) => setTimeout(r, 30)); return 0; } },
      { run: async () => { await new Promise((r) => setTimeout(r, 10)); return 1; } },
      { run: async () => { await new Promise((r) => setTimeout(r, 20)); return 2; } },
    ];
    await runPool(jobs, { concurrency: 3, onSettled: (idx) => { events.push(idx); } });
    // Job 1 (10ms) completes first, then 2 (20ms), then 0 (30ms)
    expect(events).toEqual([1, 2, 0]);
  });
});
