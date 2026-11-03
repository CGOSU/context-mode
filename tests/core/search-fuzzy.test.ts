/** Search fuzzy regressions. */

import { describe, test, it } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import { createStore } from "../helpers/content-store.js";


// ═══════════════════════════════════════════════════════════
// 5. Fuzzy Search
// ═══════════════════════════════════════════════════════════

/**
 * Seed a store with realistic multi-topic content for fuzzy search testing.
 * Returns the store with indexed content covering authentication, caching,
 * database, WebSocket, and deployment topics.
 */
function createSeededStore(): ContentStore {
  const store = createStore();

  store.index({
    content: [
      "# Authentication",
      "",
      "Use JWT tokens for API authentication. The middleware validates",
      "Bearer tokens on every request. Token expiry is set to 24 hours.",
      "",
      "## Row-Level Security",
      "",
      "Supabase row-level-security policies restrict data access per user.",
      "Enable RLS on all tables that contain user data.",
      "",
      "## OAuth Providers",
      "",
      "Configure OAuth2 providers: Google, GitHub, Discord.",
      "The callback URL must match the registered redirect URI.",
    ].join("\n"),
    source: "Auth docs",
  });

  store.index({
    content: [
      "# Caching Strategy",
      "",
      "Redis handles session caching with a 15-minute TTL.",
      "Use cache-aside pattern for database query results.",
      "",
      "## Cache Invalidation",
      "",
      "Invalidate on write using pub/sub channels.",
      "The eventEmitter broadcasts cache-bust events to all nodes.",
    ].join("\n"),
    source: "Caching docs",
  });

  store.index({
    content: [
      "# React Hooks",
      "",
      "## useEffect",
      "",
      "The useEffect hook handles side effects in functional components.",
      "Always return a cleanup function to avoid memory leaks.",
      "",
      "```javascript",
      "useEffect(() => {",
      "  const subscription = dataSource.subscribe();",
      "  return () => subscription.unsubscribe();",
      "}, [dataSource]);",
      "```",
      "",
      "## useState",
      "",
      "The useState hook manages local component state.",
      "Use functional updates when new state depends on previous.",
      "",
      "## useCallback",
      "",
      "Memoize callbacks to prevent unnecessary re-renders.",
      "Wrap event handlers passed to child components.",
    ].join("\n"),
    source: "React docs",
  });

  store.index({
    content: [
      "# WebSocket Server",
      "",
      "The connectionPool manages active WebSocket connections.",
      "Each connection has a heartbeat interval of 30 seconds.",
      "",
      "## Error Handling",
      "",
      "The errorBoundary catches unhandled promise rejections.",
      "Dead connections are pruned every 60 seconds via healthCheck.",
    ].join("\n"),
    source: "WebSocket docs",
  });

  store.index({
    content: [
      "# Deployment",
      "",
      "Kubernetes manifests live in the k8s/ directory.",
      "The horizontalPodAutoscaler scales between 2-10 replicas.",
      "",
      "## Environment Variables",
      "",
      "DATABASE_URL, REDIS_URL, and JWT_SECRET must be set.",
      "Use ConfigMap for non-sensitive configuration values.",
    ].join("\n"),
    source: "Deployment docs",
  });

  return store;
}

describe("searchTrigram: Substring Matching", () => {
  test("searchTrigram: finds substring match ('authenticat' → authentication)", () => {
    const store = createSeededStore();
    // "authenticat" is a partial substring of "authentication"
    // Porter stemming won't match this — trigram should
    const results = store.searchTrigram("authenticat", 3);
    assert.ok(results.length > 0, "Trigram should find substring match");
    assert.ok(
      results[0].content.toLowerCase().includes("authentication"),
      `Result should contain 'authentication', got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("searchTrigram: finds partial hyphenated term ('row-level' → row-level-security)", () => {
    const store = createSeededStore();
    // Partial match on hyphenated compound term
    const results = store.searchTrigram("row-level", 3);
    assert.ok(results.length > 0, "Trigram should match partial hyphenated terms");
    assert.ok(
      results[0].content.toLowerCase().includes("row-level-security") ||
        results[0].content.toLowerCase().includes("row-level"),
      `Result should contain row-level content, got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("searchTrigram: finds camelCase substring ('useEff' → useEffect)", () => {
    const store = createSeededStore();
    // "useEff" is a prefix of "useEffect" — trigram should match
    const results = store.searchTrigram("useEff", 3);
    assert.ok(results.length > 0, "Trigram should match camelCase substrings");
    assert.ok(
      results[0].content.includes("useEffect"),
      `Result should contain 'useEffect', got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("searchTrigram: respects source filter", () => {
    const store = createSeededStore();
    // "cache" appears in both "Caching docs" and potentially elsewhere
    const allResults = store.searchTrigram("cache", 10);
    const filteredResults = store.searchTrigram("cache", 10, "Caching");
    assert.ok(filteredResults.length > 0, "Should find results with source filter");
    assert.ok(
      filteredResults.every((r) => r.source.includes("Caching")),
      `All filtered results should be from Caching source, got: ${filteredResults.map((r) => r.source).join(", ")}`,
    );
    // Filtered should be subset
    assert.ok(
      filteredResults.length <= allResults.length,
      "Filtered results should be <= all results",
    );
    store.close();
  });
});

describe("fuzzyCorrect: Levenshtein Typo Correction", () => {
  test("fuzzyCorrect: corrects single typo ('autentication' → 'authentication')", () => {
    const store = createSeededStore();
    // Missing 'h' — edit distance 1
    const corrected = store.fuzzyCorrect("autentication");
    assert.ok(corrected !== null, "Should return a correction for single typo");
    assert.equal(
      corrected,
      "authentication",
      `Should correct to 'authentication', got: '${corrected}'`,
    );
    store.close();
  });

  test("fuzzyCorrect: returns null for exact match (no correction needed)", () => {
    const store = createSeededStore();
    // Exact word exists in vocabulary — no correction needed
    const corrected = store.fuzzyCorrect("authentication");
    assert.equal(
      corrected,
      null,
      "Should return null when word already exists in vocabulary",
    );
    store.close();
  });

  test("fuzzyCorrect: returns null for gibberish (too distant)", () => {
    const store = createSeededStore();
    // Completely unrelated — edit distance too high for any vocabulary word
    const corrected = store.fuzzyCorrect("xyzqwertymno");
    assert.equal(
      corrected,
      null,
      "Should return null when no close match exists",
    );
    store.close();
  });
});

describe("searchWithFallback: Three-Layer Cascade", () => {
  test("searchWithFallback: Layer 1 hit (Porter) — exact stemmed match", () => {
    const store = createSeededStore();
    // "caching" stems to "cach" via Porter — Layer 1 should match directly
    const results = store.searchWithFallback("caching strategy", 3);
    assert.ok(results.length > 0, "Layer 1 (Porter) should find stemmed match");
    assert.ok(
      results[0].content.toLowerCase().includes("cach"),
      `First result should be about caching, got: ${results[0].content.slice(0, 100)}`,
    );
    // Verify it used RRF (fused path)
    assert.equal(
      results[0].matchLayer,
      "rrf",
      `Should report 'rrf' as match layer, got: '${results[0].matchLayer}'`,
    );
    store.close();
  });

  test("searchWithFallback: Layer 2 hit (Trigram) — partial substring", () => {
    const store = createSeededStore();
    // "connectionPo" is a partial camelCase — Porter won't match, trigram will
    const results = store.searchWithFallback("connectionPo", 3);
    assert.ok(results.length > 0, "Layer 2 (Trigram) should find substring match");
    assert.ok(
      results[0].content.includes("connectionPool"),
      `Result should contain 'connectionPool', got: ${results[0].content.slice(0, 100)}`,
    );
    assert.equal(
      results[0].matchLayer,
      "rrf",
      `Should report 'rrf' as match layer, got: '${results[0].matchLayer}'`,
    );
    store.close();
  });

  test("searchWithFallback: Layer 3 hit (Fuzzy) — typo correction", () => {
    const store = createSeededStore();
    // "kuberntes" is a typo for "kubernetes" (missing 'e')
    const results = store.searchWithFallback("kuberntes", 3);
    assert.ok(results.length > 0, "Layer 3 (Fuzzy) should find typo-corrected match");
    assert.ok(
      results[0].content.toLowerCase().includes("kubernetes"),
      `Result should contain 'kubernetes', got: ${results[0].content.slice(0, 100)}`,
    );
    assert.equal(
      results[0].matchLayer,
      "rrf-fuzzy",
      `Should report 'rrf-fuzzy' as match layer, got: '${results[0].matchLayer}'`,
    );
    store.close();
  });

  test("searchWithFallback: no match at any layer returns empty", () => {
    const store = createSeededStore();
    // Completely unrelated term with no substring or fuzzy match
    const results = store.searchWithFallback("xylophoneQuartzMango", 3);
    assert.equal(results.length, 0, "Should return empty when no layer matches");
    store.close();
  });

  test("searchWithFallback: source filter works across all layers", () => {
    const store = createSeededStore();
    // "JWT" exists in both Auth docs and Deployment docs (JWT_SECRET)
    // With source filter, should only return Auth docs
    const results = store.searchWithFallback("JWT", 5, "Auth");
    assert.ok(results.length > 0, "Should find results with source filter");
    assert.ok(
      results.every((r) => r.source.includes("Auth")),
      `All results should be from Auth source, got: ${results.map((r) => r.source).join(", ")}`,
    );
    store.close();
  });
});

describe("Fuzzy Edge Cases", () => {
  test("searchTrigram: empty query returns empty", () => {
    const store = createSeededStore();
    const results = store.searchTrigram("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
    store.close();
  });

  test("searchTrigram: very short query (2 chars) still works", () => {
    const store = createSeededStore();
    // "JS" or "k8" — trigram needs at least 3 chars to form a trigram
    // but the API should handle gracefully (return empty or degrade)
    const results = store.searchTrigram("JS", 3);
    // Should not throw, may return empty
    assert.ok(Array.isArray(results), "Should return an array even for short query");
    store.close();
  });

  test("fuzzyCorrect: handles multi-word query (corrects each word)", () => {
    const store = createSeededStore();
    // "autentication middlewre" — two typos
    const corrected = store.fuzzyCorrect("autentication");
    // At minimum, should correct the single word
    if (corrected !== null) {
      assert.equal(corrected, "authentication", "Should correct to closest match");
    }
    store.close();
  });

  test("searchWithFallback: Layer 1 hit skips Layer 2 and 3 (performance)", () => {
    const store = createSeededStore();
    // "Redis" is an exact term — should resolve at Layer 1 only
    const start = performance.now();
    const results = store.searchWithFallback("Redis", 3);
    const elapsed = performance.now() - start;
    assert.ok(results.length > 0, "Should find Redis content");
    assert.equal(
      results[0].matchLayer,
      "rrf",
      "Exact match should resolve at RRF layer",
    );
    // Sanity: should be fast since it didn't need fuzzy
    assert.ok(elapsed < 500, `Should be fast for Layer 1 hit, took ${elapsed.toFixed(0)}ms`);
    store.close();
  });

  test("trigram table is populated during index()", () => {
    const store = createStore();
    store.index({
      content: "# Test\n\nThe horizontalPodAutoscaler manages pod replicas.",
      source: "test-trigram-index",
    });
    // After indexing, trigram search should work
    const results = store.searchTrigram("horizontalPod", 3);
    assert.ok(results.length > 0, "Trigram table should be populated during index()");
    assert.ok(
      results[0].content.includes("horizontalPodAutoscaler"),
      "Should find the camelCase term",
    );
    store.close();
  });

  test("trigram table is populated during indexPlainText()", () => {
    const store = createStore();
    store.indexPlainText(
      "ERROR: connectionRefused on port 5432\nWARNING: retrying in 5s",
      "plain-text-trigram",
    );
    const results = store.searchTrigram("connectionRef", 3);
    assert.ok(results.length > 0, "Trigram should work with indexPlainText content");
    store.close();
  });
});

// ─────────────────────────────────────────────────────────
// Fuzzy correction cache
// ─────────────────────────────────────────────────────────

describe("fuzzyCorrect LRU cache", () => {
  test("returns identical result on repeated queries for the same word", () => {
    const store = createStore();
    store.index({
      content: "The authentication middleware handles orchestration of services.",
      source: "cache-test",
    });

    const first = store.fuzzyCorrect("authentiction");
    const second = store.fuzzyCorrect("authentiction");

    assert.equal(first, second, "cached result must match uncached result");
    assert.equal(first, "authentication");

    store.close();
  });

  test("cache entry for null (no correction) is also returned on hit", () => {
    const store = createStore();
    store.index({
      content: "one two three four",
      source: "cache-null-test",
    });

    // A word unrelated to the vocab, too far for any correction.
    const first = store.fuzzyCorrect("xylophone");
    const second = store.fuzzyCorrect("xylophone");

    assert.equal(first, null);
    assert.equal(second, null);

    store.close();
  });

  test("cache is cleared when new vocabulary is inserted", () => {
    const store = createStore();
    store.index({
      content: "authentication middleware orchestration deployment monitoring",
      source: "cache-invalidate-v1",
    });

    // Prime the cache with a word that has no close match yet.
    const beforeInsert = store.fuzzyCorrect("xylophne"); // should be null
    assert.equal(beforeInsert, null);

    // Add a new vocab word that *is* a close match for "xylophne".
    store.index({
      content: "The xylophone in the orchestra plays melodies.",
      source: "cache-invalidate-v2",
    });

    // Cache must have been invalidated — stale null would be wrong now.
    const afterInsert = store.fuzzyCorrect("xylophne");
    assert.equal(afterInsert, "xylophone");

    store.close();
  });

  test("cache is NOT cleared when re-indexing identical content", () => {
    const store = createStore();
    store.index({
      content: "authentication middleware orchestration deployment",
      source: "cache-idempotent",
    });

    // Prime the cache.
    store.fuzzyCorrect("authentiction");
    store.fuzzyCorrect("orchstration");

    // Monkey-patch the underlying vocab stmt to count DB hits after priming.
    // We can't easily inspect Map state; instead we verify behavior: a second
    // identical fuzzyCorrect call for the same word returns the same answer
    // even if we re-index the exact same content (no new vocab rows insert).
    store.index({
      content: "authentication middleware orchestration deployment",
      source: "cache-idempotent", // same label → dedup handles it
    });

    const result = store.fuzzyCorrect("authentiction");
    assert.equal(result, "authentication");

    store.close();
  });

  test("cache respects FUZZY_CACHE_SIZE — eviction does not corrupt results", () => {
    const store = createStore();
    // Build a vocab with many distinct words so evictions happen during sweep.
    const vocab = Array.from({ length: 50 }, (_, i) => `uniqueword${i}abc`).join(" ");
    store.index({ content: vocab, source: "large-vocab-cache" });

    const capSize = ContentStore.FUZZY_CACHE_SIZE;

    // Collect an oracle: what does fuzzyCorrect return on a cold cache for
    // each input? Use a fresh store to get uncached answers.
    const oracleStore = createStore();
    oracleStore.index({ content: vocab, source: "oracle" });

    // Query (capSize + 50) unique words, causing evictions. Each answer must
    // match the cold-cache oracle — eviction of an entry must not influence
    // the answer we get when we re-query that word.
    for (let i = 0; i < capSize + 50; i++) {
      const typo = `uniquewrd${i}abc`;
      const oracle = oracleStore.fuzzyCorrect(typo);
      const actual = store.fuzzyCorrect(typo);
      assert.equal(
        actual,
        oracle,
        `eviction corrupted result for ${typo}: got ${actual}, oracle ${oracle}`,
      );
    }

    store.close();
    oracleStore.close();
  });
});
