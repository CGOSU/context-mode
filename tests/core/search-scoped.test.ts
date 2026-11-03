/** Search scoped regressions. */

import { describe, test, it } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import { formatBatchQueryResults } from "../../src/server.js";
import { createStore } from "../helpers/content-store.js";


// ═══════════════════════════════════════════════════════════
// 3. Search Fallback Integration
// ═══════════════════════════════════════════════════════════

describe("Source-scoped searchWithFallback (intentSearch path)", () => {
  test("intentSearch path: porter layer finds exact terms in source-scoped search", () => {
    const store = createStore();

    // Index two different sources (simulates multiple execute calls)
    store.indexPlainText(
      "ERROR: connection refused to database at 10.0.0.5:5432\nRetry 3/3 failed",
      "cmd-1: psql status",
    );
    store.indexPlainText(
      "All 42 tests passed in 3.2s\nCoverage: 87%",
      "cmd-2: npm test",
    );

    // Source-scoped search should only find results from the target source
    const results = store.searchWithFallback("connection refused", 3, "cmd-1");
    assert.ok(results.length > 0, "Should find results in cmd-1");
    assert.ok(
      results[0].content.includes("connection refused"),
      "Result should contain the search term",
    );
    assert.equal(results[0].matchLayer, "rrf", "Should match via RRF layer");

    // Should NOT leak results from other sources
    const wrongSource = store.searchWithFallback("connection refused", 3, "cmd-2");
    assert.equal(wrongSource.length, 0, "Should not find database errors in test output source");

    store.close();
  });

  test("intentSearch path: trigram layer activates for partial/camelCase terms", () => {
    const store = createStore();

    store.indexPlainText(
      "The horizontalPodAutoscaler scaled deployment to 5 replicas\nCPU usage at 78%",
      "cmd-1: kubectl status",
    );

    // "horizontalPod" is a partial camelCase term — porter won't match, trigram will
    const results = store.searchWithFallback("horizontalPod", 3, "cmd-1");
    assert.ok(results.length > 0, "Trigram should find partial camelCase match");
    assert.ok(
      results[0].content.includes("horizontalPodAutoscaler"),
      "Should find the full term",
    );
    assert.equal(results[0].matchLayer, "rrf", "Should match via RRF layer");

    store.close();
  });

  test("intentSearch path: fuzzy layer activates for typos", () => {
    const store = createStore();

    store.indexPlainText(
      "Kubernetes deployment rolled out successfully\nAll pods healthy",
      "cmd-1: kubectl rollout",
    );

    // "kuberntes" is a typo for "kubernetes" — fuzzy layer should correct
    const results = store.searchWithFallback("kuberntes", 3, "cmd-1");
    assert.ok(results.length > 0, "Fuzzy should correct typo and find match");
    assert.ok(
      results[0].content.toLowerCase().includes("kubernetes"),
      "Should find kubernetes content",
    );
    assert.equal(results[0].matchLayer, "rrf-fuzzy", "Should match via RRF-fuzzy layer");

    store.close();
  });

  test("intentSearch path: no match returns empty (not an error)", () => {
    const store = createStore();

    store.indexPlainText(
      "Server started on port 3000\nReady to accept connections",
      "cmd-1: node server",
    );

    const results = store.searchWithFallback("xylophoneQuartzMango", 3, "cmd-1");
    assert.equal(results.length, 0, "Completely unrelated query should return empty");

    store.close();
  });
});

describe("Multi-source isolation (batch_execute path)", () => {
  test("batch_execute path: scoped search isolates results per source", () => {
    const store = createStore();

    // Simulate batch_execute indexing multiple command outputs
    store.index({
      content: "# Git Status\n\nOn branch main\n3 files changed, 42 insertions",
      source: "batch: git status",
    });
    store.index({
      content: "# Test Results\n\nAll 100 tests passed\n0 failures, 0 skipped",
      source: "batch: npm test",
    });
    store.index({
      content: "# Build Output\n\nCompiled 47 files in 2.3s\nBundle size: 142KB",
      source: "batch: npm build",
    });

    // Each scoped search should only return results from its source
    const gitResults = store.searchWithFallback("files changed", 3, "batch: git status");
    assert.ok(gitResults.length > 0, "Should find git status results");
    assert.ok(gitResults.every(r => r.source.includes("git status")), "All results should be from git status");

    const testResults = store.searchWithFallback("tests passed", 3, "batch: npm test");
    assert.ok(testResults.length > 0, "Should find test results");
    assert.ok(testResults.every(r => r.source.includes("npm test")), "All results should be from npm test");

    // Global fallback (no source filter) should search across all sources
    const globalResults = store.searchWithFallback("files", 10);
    assert.ok(globalResults.length > 0, "Global search should find results");

    store.close();
  });

  test("batch_execute path: global fallback when scoped search fails", () => {
    const store = createStore();

    // Index content into one source
    store.index({
      content: "# Authentication\n\nJWT tokens expire after 24 hours\nRefresh tokens last 7 days",
      source: "docs: auth",
    });

    // Scoped search against wrong source returns empty
    const wrongScope = store.searchWithFallback("JWT tokens", 3, "docs: nonexistent");
    assert.equal(wrongScope.length, 0, "Wrong source scope should return empty");

    // Global fallback (no source) should find it
    const globalFallback = store.searchWithFallback("JWT tokens", 3);
    assert.ok(globalFallback.length > 0, "Global fallback should find the content");

    store.close();
  });

  test("batch_execute formatter never inlines previous indexed content", () => {
    const store = createStore();

    store.index({
      content: "# Current Batch\n\nOnly current batch details live here.",
      source: "batch: current",
    });
    store.index({
      content: "# Older Indexed Content\n\nJWT tokens expire after 24 hours.",
      source: "docs: auth",
    });

    const output = formatBatchQueryResults(store, ["JWT tokens"], "batch: current").join("\n");
    assert.ok(output.includes("No matching sections found."), "Expected scoped batch result to stay empty");
    assert.ok(!output.includes("previously indexed content"), "Should not mention cross-source fallback");
    assert.ok(!output.includes("JWT tokens expire after 24 hours"), "Should not inline stale cross-source text");

    store.close();
  });

  test("batch_execute formatter does not leak overlapping batch labels", () => {
    const store = createStore();

    store.index({
      content: "# Current Build\n\nCurrent batch contains only build timing details.",
      source: "batch:Build",
    });
    store.index({
      content: "# Older Build and Test\n\nJWT tokens expire after 24 hours.",
      source: "batch:Build,Test",
    });

    const output = formatBatchQueryResults(store, ["JWT tokens"], "batch:Build").join("\n");
    assert.ok(output.includes("No matching sections found."), "Expected exact batch label filtering");
    assert.ok(!output.includes("JWT tokens expire after 24 hours"), "Should not leak overlapping older batch label content");

    store.close();
  });

  test("batch_execute formatter returns matches from the current batch", () => {
    const store = createStore();

    store.index({
      content: "# Current Batch\n\nJWT tokens expire after 12 hours for the current batch.",
      source: "batch: current",
    });
    store.index({
      content: "# Older Indexed Content\n\nJWT tokens expire after 24 hours.",
      source: "docs: auth",
    });

    const output = formatBatchQueryResults(store, ["JWT tokens"], "batch: current").join("\n");
    assert.ok(output.includes("Current Batch"), "Expected current batch heading in formatter output");
    assert.ok(output.includes("12 hours for the current batch"), "Expected current batch content in formatter output");
    assert.ok(!output.includes("24 hours"), "Should not leak older source content when current batch matches");

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Content Type Filter
// ═══════════════════════════════════════════════════════════

describe("Content type filter", () => {
  function createMixedStore(): ContentStore {
    const store = createStore();
    // Index content with code blocks (will get contentType="code")
    store.index({
      content: "# API Reference\n\n```javascript\nfunction authenticate(user, pass) {\n  return jwt.sign({ user }, SECRET);\n}\n```\n\nThis function handles user authentication.",
      source: "api-docs",
    });
    // Index prose-only content (will get contentType="prose")
    store.index({
      content: "# Architecture Overview\n\nThe authentication flow uses JWT tokens for session management. Users authenticate via the login endpoint.",
      source: "arch-docs",
    });
    return store;
  }

  test("search() with contentType='code' returns only code chunks", () => {
    const store = createMixedStore();
    try {
      const results = store.search("authenticate", 10, undefined, "AND", "code");
      assert.ok(results.length > 0, "Should find code chunks");
      for (const r of results) {
        assert.equal(r.contentType, "code", `Expected code, got ${r.contentType} in "${r.title}"`);
      }
    } finally {
      store.close();
    }
  });

  test("search() with contentType='prose' returns only prose chunks", () => {
    const store = createMixedStore();
    try {
      const results = store.search("authentication", 10, undefined, "AND", "prose");
      assert.ok(results.length > 0, "Should find prose chunks");
      for (const r of results) {
        assert.equal(r.contentType, "prose", `Expected prose, got ${r.contentType} in "${r.title}"`);
      }
    } finally {
      store.close();
    }
  });

  test("searchTrigram() respects contentType filter", () => {
    const store = createMixedStore();
    try {
      const results = store.searchTrigram("authenticat", 10, undefined, "AND", "prose");
      for (const r of results) {
        assert.equal(r.contentType, "prose", `Trigram should respect contentType filter`);
      }
    } finally {
      store.close();
    }
  });

  test("searchWithFallback() passes contentType through all layers", () => {
    const store = createMixedStore();
    try {
      const results = store.searchWithFallback("authenticate", 5, undefined, "code");
      assert.ok(results.length > 0, "Should find results");
      for (const r of results) {
        assert.equal(r.contentType, "code", `searchWithFallback should filter by contentType`);
      }
    } finally {
      store.close();
    }
  });

  test("contentType + source combined filter", () => {
    const store = createMixedStore();
    try {
      const results = store.searchWithFallback("authentication", 5, "arch-docs", "prose");
      assert.ok(results.length > 0, "Should find results with both filters");
      for (const r of results) {
        assert.equal(r.contentType, "prose");
        assert.ok(r.source.includes("arch-docs"), `Source should match filter`);
      }
    } finally {
      store.close();
    }
  });

  test("contentType undefined returns all types (backward compat)", () => {
    const store = createMixedStore();
    try {
      const results = store.searchWithFallback("authentication", 10);
      assert.ok(results.length > 0, "Should find results without contentType filter");
      // Should include both code and prose chunks (no filter applied)
    } finally {
      store.close();
    }
  });
});
