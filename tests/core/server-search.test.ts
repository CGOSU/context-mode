/** Server regressions: search. */



import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


describe("ctx_search progressive throttle observability (issue #697)", () => {
  const serverSrc = readServerSource();

  test("env vars override throttle thresholds with positive-number validation", () => {
    expect(serverSrc).toContain("CONTEXT_MODE_SEARCH_WINDOW_MS");
    expect(serverSrc).toContain("CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER");
    expect(serverSrc).toContain("CONTEXT_MODE_SEARCH_BLOCK_AFTER");
    expect(serverSrc).toMatch(/readPositiveEnv\("CONTEXT_MODE_SEARCH_WINDOW_MS"/);
  });

  test("throttle counter line is surfaced on every response, not only after soft cap", () => {
    // Branch before the soft cap — should still inform the agent.
    expect(serverSrc).toMatch(/Throttle:\s*call\s+#\$\{searchCallCount\}/);
    // Branch at/after soft cap keeps the historical warning shape.
    expect(serverSrc).toMatch(/⚠ search call #\$\{searchCallCount\}/);
  });

  test("ctx_search description documents the throttle policy", () => {
    expect(serverSrc).toMatch(/RETURNS:[\s\S]{0,2000}rolling time window/i);
    expect(serverSrc).toMatch(/CONTEXT_MODE_SEARCH_WINDOW_MS/);
  });
});
