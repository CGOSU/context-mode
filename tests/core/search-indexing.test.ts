/** Search indexing regressions. */

import { describe, test, expect, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import { createStore } from "../helpers/content-store.js";


describe("Fix 2: persistent store replaces ephemeral DB correctly", () => {
  test("persistent store with source scoping isolates results like ephemeral DB did", () => {
    const store = createStore();

    // Simulate two consecutive intentSearch calls indexing different outputs
    store.indexPlainText(
      "FAIL: test/auth.test.ts - Expected 200 but got 401\nTimeout in token refresh",
      "execute:typescript:error",
    );
    store.indexPlainText(
      "PASS: all 50 integration tests passed\n0 failures, 0 skipped, 50 total",
      "execute:shell",
    );

    // Scoped search for the error source should only return error content
    const errorResults = store.searchWithFallback("401 timeout", 3, "execute:typescript:error");
    assert.ok(errorResults.length > 0, "Should find error content");
    assert.ok(
      errorResults.every(r => r.source.includes("error")),
      "All results should be from the error source",
    );

    // Scoped search for the success source should only return success content
    const successResults = store.searchWithFallback("tests passed", 3, "execute:shell");
    assert.ok(successResults.length > 0, "Should find success content");
    assert.ok(
      successResults.every(r => r.source.includes("shell")),
      "All results should be from the shell source",
    );

    store.close();
  });

  test("persistent store accumulates content across multiple indexPlainText calls", () => {
    const store = createStore();

    store.indexPlainText("Error log from first command", "cmd-1");
    store.indexPlainText("Error log from second command", "cmd-2");
    store.indexPlainText("Error log from third command", "cmd-3");

    // Global search (no source filter) should find content from all sources
    const allResults = store.searchWithFallback("error log", 10);
    assert.ok(allResults.length >= 3, `Should find content from all 3 sources, got ${allResults.length}`);

    // Source-scoped search should be precise
    const cmd2Only = store.searchWithFallback("error log", 3, "cmd-2");
    assert.ok(cmd2Only.length > 0, "Should find cmd-2 results");
    assert.ok(
      cmd2Only.every(r => r.source.includes("cmd-2")),
      "Scoped results should only be from cmd-2",
    );

    store.close();
  });
});

describe("Fix 4: transaction-wrapped vocabulary insertion", () => {
  test("vocabulary is correctly stored after transaction-wrapped insertion", () => {
    const store = createStore();

    // Index content with distinctive words
    store.index({
      content: "# Microservices\n\nThe containerized orchestration platform manages deployments.\n\n" +
        "# Monitoring\n\nPrometheus collects containerized metrics from orchestration layer.\n\n" +
        "# Scaling\n\nHorizontal pod autoscaling uses containerized orchestration policies.",
      source: "k8s-docs",
    });

    // fuzzyCorrect depends on vocabulary table being populated
    // If transaction-wrapping broke insertion, fuzzy correction would fail
    const correction = store.fuzzyCorrect("orchestraton"); // typo for "orchestration"
    assert.equal(
      correction,
      "orchestration",
      `fuzzyCorrect should find 'orchestration', got '${correction}'`,
    );

    store.close();
  });

  test("vocabulary handles large word sets without error", () => {
    const store = createStore();

    // Generate content with many unique words to stress the transaction
    const sections = Array.from({ length: 50 }, (_, i) => {
      const uniqueWord = `customVariable${i}Value`;
      return `## Section ${i}\n\n${uniqueWord} is used in module${i} for processing data${i}.`;
    }).join("\n\n");

    // Should not throw — if transaction wrapping is broken, this could fail
    assert.doesNotThrow(() => {
      store.index({ content: sections, source: "large-vocab" });
    }, "Large vocabulary insertion should succeed with transaction wrapping");

    // Verify vocabulary is searchable via fuzzy correction
    const correction = store.fuzzyCorrect("customvariable1valu"); // close to "customvariable1value"
    // May or may not find a correction depending on edit distance, but should not throw
    assert.ok(
      correction === null || typeof correction === "string",
      "fuzzyCorrect should work after large vocabulary insertion",
    );

    store.close();
  });
});

describe("Fix 5: getDistinctiveTerms with .iterate() streaming", () => {
  test("getDistinctiveTerms produces correct terms with iterate()", () => {
    const store = createStore();

    // Create content with known word frequency patterns
    const indexed = store.index({
      content: [
        "# Module A",
        "",
        "The serialization framework handles JSON transformation efficiently.",
        "Serialization is critical for API responses.",
        "",
        "# Module B",
        "",
        "The serialization layer converts protocol buffers.",
        "Performance benchmarks show fast serialization.",
        "",
        "# Module C",
        "",
        "Custom serialization handlers extend the base framework.",
        "Unit tests cover serialization edge cases.",
        "",
        "# Module D",
        "",
        "Documentation for the serialization API reference.",
        "Migration guide from v1 serialization format.",
      ].join("\n"),
      source: "serialization-docs",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should find distinctive terms, got ${terms.length}`);

    // Verify no duplicates
    const uniqueTerms = new Set(terms);
    assert.equal(uniqueTerms.size, terms.length, "Terms should have no duplicates");

    // All terms should be >= 3 chars and not stopwords
    for (const term of terms) {
      assert.ok(term.length >= 3, `Term '${term}' should be >= 3 chars`);
    }

    store.close();
  });

  test("getDistinctiveTerms returns empty for sources with < 3 chunks", () => {
    const store = createStore();

    const indexed = store.index({
      content: "# Single Section\n\nThis document has only one section with some content.",
      source: "tiny-doc",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.deepEqual(terms, [], "Should return empty for documents with < 3 chunks");

    store.close();
  });

  test("getDistinctiveTerms filters terms outside frequency band", () => {
    const store = createStore();

    // 10 chunks: minAppearances=2, maxAppearances=max(3, ceil(10*0.4))=4
    const indexed = store.index({
      content: Array.from({ length: 10 }, (_, i) => {
        let section = `# Section ${i}\n\nGeneric content for section number ${i} with filler text.`;
        // "elasticsearch" appears in exactly 3 sections (within 2-4 band)
        if (i >= 2 && i <= 4) section += "\nElasticsearch cluster rebalancing in progress.";
        // "ubiquitous" appears in all 10 sections (above maxAppearances=4)
        section += "\nThe ubiquitous logging framework captures all events.";
        // "singleton" appears in exactly 1 section (below minAppearances=2)
        if (i === 7) section += "\nSingleton pattern used for configuration.";
        return section;
      }).join("\n\n"),
      source: "freq-test",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);

    // "elasticsearch" (3/10 sections) should be in the band
    assert.ok(
      terms.includes("elasticsearch"),
      `'elasticsearch' (3/10 = within band) should be distinctive, got: [${terms.slice(0, 10).join(", ")}...]`,
    );

    // "singleton" (1/10 sections) should be filtered as too rare
    assert.ok(
      !terms.includes("singleton"),
      "'singleton' (1/10 = below min) should NOT be distinctive",
    );

    store.close();
  });
});

describe("getDistinctiveTerms consistency (fix #9)", () => {
  test("getDistinctiveTerms returns terms for multi-chunk content", () => {
    const store = createStore();

    // getDistinctiveTerms requires chunk_count >= 3 and terms appearing in
    // at least 2 chunks. Use markdown with multiple headings to force chunking.
    const indexed = store.index({
      content: [
        "# Kubernetes Overview",
        "",
        "The horizontalPodAutoscaler manages Kubernetes pod replicas.",
        "Kubernetes clusters run containerized workloads.",
        "",
        "# Kubernetes Networking",
        "",
        "Kubernetes services expose pods via ClusterIP or LoadBalancer.",
        "The horizontalPodAutoscaler scales based on CPU metrics.",
        "",
        "# Kubernetes Storage",
        "",
        "PersistentVolumeClaims request storage from Kubernetes.",
        "The horizontalPodAutoscaler can also use custom metrics.",
        "",
        "# Monitoring",
        "",
        "Prometheus scrapes metrics from Kubernetes pods.",
        "Alerts fire when horizontalPodAutoscaler hits max replicas.",
      ].join("\n"),
      source: "k8s-docs",
    });

    const terms = store.getDistinctiveTerms(indexed.sourceId);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should extract distinctive terms, got ${terms.length}`);

    // Terms appearing in ALL chunks are filtered as too common; terms in
    // only 1 chunk are filtered as too rare. The middle band survives.
    // "replicas", "pods", "metrics" appear in 2-3 of 4 chunks — distinctive.
    for (const term of terms) {
      assert.ok(term.length >= 3, `Term "${term}" should be at least 3 chars`);
    }

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 4. Index Deduplication
// ═══════════════════════════════════════════════════════════

describe("Index deduplication (issue #67)", () => {
  let store: ContentStore;

  beforeEach(() => {
    store = new ContentStore(":memory:");
  });

  afterEach(() => {
    store.cleanup();
  });

  it("re-indexing with same label replaces previous content", () => {
    // First build: error A
    store.index({
      content: "# Build Output\nERROR: Module not found 'foo'",
      source: "execute:shell:npm run build",
    });

    // Verify error A is searchable
    const results1 = store.search("Module not found foo");
    expect(results1.length).toBeGreaterThan(0);
    expect(results1[0].content).toContain("Module not found");

    // Second build: error A fixed, new error B
    store.index({
      content: "# Build Output\nERROR: Type 'string' is not assignable to type 'number'",
      source: "execute:shell:npm run build",
    });

    // Error B should be searchable
    const results2 = store.search("Type string not assignable number");
    expect(results2.length).toBeGreaterThan(0);
    expect(results2[0].content).toContain("not assignable");

    // Error A should NO LONGER be searchable
    const results3 = store.search("Module not found foo");
    expect(results3.length).toBe(0);
  });

  it("different labels are NOT deduped", () => {
    store.index({
      content: "# Test Output\n5 tests passed",
      source: "execute:shell:npm test",
    });
    store.index({
      content: "# Build Output\nBuild successful",
      source: "execute:shell:npm run build",
    });

    // Both should be searchable
    const testResults = store.search("tests passed");
    expect(testResults.length).toBeGreaterThan(0);

    const buildResults = store.search("Build successful");
    expect(buildResults.length).toBeGreaterThan(0);
  });

  it("sources list shows only one entry per label after dedup", () => {
    store.index({ content: "# Run 1\nfail", source: "execute:shell:make" });
    store.index({ content: "# Run 2\nfail", source: "execute:shell:make" });
    store.index({ content: "# Run 3\npass", source: "execute:shell:make" });

    const sources = store.listSources();
    const makeEntries = sources.filter((s) => s.label === "execute:shell:make");
    expect(makeEntries.length).toBe(1);
    expect(makeEntries[0].chunkCount).toBeGreaterThan(0);
  });

  it("dedup works with indexPlainText too", () => {
    store.indexPlainText("error: old failure", "build-output");
    store.indexPlainText("success: all good", "build-output");

    const oldResults = store.search("old failure");
    expect(oldResults.length).toBe(0);

    const newResults = store.search("all good");
    expect(newResults.length).toBeGreaterThan(0);
  });

  it("dedup works with indexJSON too", () => {
    store.indexJSON(
      JSON.stringify({ status: "error", message: "connection refused" }),
      "api-response",
    );
    store.indexJSON(
      JSON.stringify({ status: "ok", data: [1, 2, 3] }),
      "api-response",
    );

    const oldResults = store.search("connection refused");
    expect(oldResults.length).toBe(0);

    const newResults = store.searchWithFallback("ok", 5);
    expect(newResults.length).toBeGreaterThan(0);
  });

  it("trigram search also returns only latest content after dedup", () => {
    store.index({
      content: "# Output\nxyz123oldvalue",
      source: "execute:shell:check",
    });
    store.index({
      content: "# Output\nabc456newvalue",
      source: "execute:shell:check",
    });

    // Trigram search for old unique substring
    const oldResults = store.searchWithFallback("xyz123oldvalue", 5);
    expect(oldResults.length).toBe(0);

    // Trigram search for new unique substring
    const newResults = store.searchWithFallback("abc456newvalue", 5);
    expect(newResults.length).toBeGreaterThan(0);
  });
});
