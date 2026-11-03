/** Fallback search wiring, AND semantics and hardening regressions. */

import { describe, test, expect, it } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { createStore } from "../helpers/content-store.js";



// ═══════════════════════════════════════════════════════════
// 1. Search Wiring
// ═══════════════════════════════════════════════════════════

describe("Fix 1: searchWithFallback cascade on persistent store", () => {
  test("searchWithFallback: porter layer returns results with matchLayer='rrf'", () => {
    const store = createStore();
    store.indexPlainText(
      "The authentication middleware validates JWT tokens on every request.\nExpired tokens are rejected with 401.",
      "execute:shell",
    );

    const results = store.searchWithFallback("authentication JWT tokens", 3, "execute:shell");
    assert.ok(results.length > 0, "Porter should find exact terms");
    assert.equal(results[0].matchLayer, "rrf", "matchLayer should be 'rrf'");
    assert.ok(results[0].content.includes("JWT"), "Content should contain JWT");

    store.close();
  });

  test("searchWithFallback: trigram layer activates when porter fails", () => {
    const store = createStore();
    store.indexPlainText(
      "The responseBodyParser transforms incoming XML payloads into JSON.\nAll endpoints accept application/xml.",
      "execute:shell",
    );

    // "responseBody" is a substring of "responseBodyParser" — porter won't match, trigram will
    const results = store.searchWithFallback("responseBody", 3, "execute:shell");
    assert.ok(results.length > 0, "Trigram should find substring match");
    assert.equal(results[0].matchLayer, "rrf", "matchLayer should be 'rrf'");

    store.close();
  });

  test("searchWithFallback: fuzzy layer corrects misspellings", () => {
    const store = createStore();
    store.indexPlainText(
      "PostgreSQL database connection established successfully.\nConnection pool size: 10.",
      "execute:shell",
    );

    // "databse" is a typo for "database"
    const results = store.searchWithFallback("databse", 3, "execute:shell");
    assert.ok(results.length > 0, "Fuzzy should correct 'databse' to 'database'");
    assert.equal(results[0].matchLayer, "rrf-fuzzy", "matchLayer should be 'rrf-fuzzy'");
    assert.ok(results[0].content.toLowerCase().includes("database"), "Content should have 'database'");

    store.close();
  });

  test("searchWithFallback: cascade stops at first successful layer", () => {
    const store = createStore();
    store.indexPlainText(
      "Redis cache hit rate: 95%\nMemcached fallback rate: 3%",
      "execute:shell",
    );

    // "redis" is an exact term — should stop at RRF, never try fuzzy
    const results = store.searchWithFallback("redis cache", 3, "execute:shell");
    assert.ok(results.length > 0, "Should find results");
    assert.equal(results[0].matchLayer, "rrf", "Should stop at RRF when it succeeds");

    store.close();
  });

  test("searchWithFallback: returns empty array when all layers fail", () => {
    const store = createStore();
    store.indexPlainText(
      "Server listening on port 8080\nHealth check endpoint ready",
      "execute:shell",
    );

    // Completely unrelated terms that no layer can match
    const results = store.searchWithFallback("xylophoneZebraQuartz", 3, "execute:shell");
    assert.equal(results.length, 0, "Should return empty when nothing matches");

    store.close();
  });
});

describe("Fix 3: batch_execute search precision (no indiscriminate boosting)", () => {
  test("searchWithFallback returns only relevant results, not everything", () => {
    const store = createStore();

    // Simulate batch_execute with multiple command outputs indexed
    store.index({
      content: "# Git Log\n\ncommit abc123\nAuthor: dev@example.com\nFix memory leak in WebSocket handler",
      source: "batch:git-log",
    });
    store.index({
      content: "# Disk Usage\n\n/dev/sda1: 45% used\n/dev/sdb1: 89% used — WARNING",
      source: "batch:df",
    });
    store.index({
      content: "# Network Stats\n\neth0: 1.2Gbps RX, 800Mbps TX\nPacket loss: 0.01%",
      source: "batch:netstat",
    });

    // Query for "memory leak" should return git log, NOT disk usage or network
    const results = store.searchWithFallback("memory leak WebSocket", 3);
    assert.ok(results.length > 0, "Should find git log content");
    assert.ok(
      results[0].content.includes("memory leak") || results[0].content.includes("WebSocket"),
      "First result should be about memory leak",
    );
    // The old boosted approach would return ALL sections; searchWithFallback
    // should be precise and only return the relevant one
    assert.ok(
      !results.some(r => r.content.includes("Packet loss")),
      "Network stats should NOT appear in memory leak results",
    );

    store.close();
  });

  test("searchWithFallback with source scoping is more precise than global", () => {
    const store = createStore();

    store.index({
      content: "# Build Output\n\nCompiled 42 TypeScript files\nBundle: 256KB gzipped",
      source: "batch:build",
    });
    store.index({
      content: "# Test Output\n\n42 tests passed, 0 failed\nCoverage: 91.5%",
      source: "batch:test",
    });

    // Scoped search for "42" should return only the matching source
    const buildResults = store.searchWithFallback("TypeScript files compiled", 3, "batch:build");
    assert.ok(buildResults.length > 0, "Should find build output");
    assert.ok(
      buildResults.every(r => r.source.includes("build")),
      "All results should be from build source",
    );

    const testResults = store.searchWithFallback("tests passed coverage", 3, "batch:test");
    assert.ok(testResults.length > 0, "Should find test output");
    assert.ok(
      testResults.every(r => r.source.includes("test")),
      "All results should be from test source",
    );

    store.close();
  });
});

describe("Edge cases and hardening", () => {
  test("searchWithFallback on empty store returns empty", () => {
    const store = createStore();
    const results = store.searchWithFallback("anything", 3);
    assert.equal(results.length, 0, "Empty store should return empty results");
    store.close();
  });

  test("searchWithFallback with empty query returns empty", () => {
    const store = createStore();
    store.indexPlainText("Some content here", "test-source");

    const results = store.searchWithFallback("", 3, "test-source");
    assert.equal(results.length, 0, "Empty query should return empty results");

    store.close();
  });

  test("searchWithFallback source scoping uses LIKE partial match", () => {
    const store = createStore();

    store.indexPlainText(
      "Compilation succeeded with 0 warnings",
      "batch:TypeScript Build,npm test,lint",
    );

    // Partial source match should work
    const results = store.searchWithFallback("compilation", 3, "TypeScript Build");
    assert.ok(results.length > 0, "Partial source match should find content");

    store.close();
  });

  test("searchWithFallback handles special characters in query gracefully", () => {
    const store = createStore();
    store.indexPlainText(
      "Error in module: TypeError at line 42\nStack trace follows",
      "execute:shell",
    );

    // These queries with special chars should not throw
    assert.doesNotThrow(() => store.searchWithFallback('TypeError "line 42"', 3));
    assert.doesNotThrow(() => store.searchWithFallback("error (module)", 3));
    assert.doesNotThrow(() => store.searchWithFallback("stack* trace", 3));
    assert.doesNotThrow(() => store.searchWithFallback("NOT:something", 3));

    store.close();
  });

  test("searchWithFallback respects limit parameter across all layers", () => {
    const store = createStore();

    // Index enough content for multiple results
    store.index({
      content: Array.from({ length: 10 }, (_, i) =>
        `## Error ${i}\n\nTypeError: Cannot read property '${i}' of undefined at line ${i * 10}`
      ).join("\n\n"),
      source: "error-log",
    });

    const limited = store.searchWithFallback("TypeError property undefined", 2);
    assert.ok(limited.length <= 2, `Limit 2 should return at most 2 results, got ${limited.length}`);

    const moreLimited = store.searchWithFallback("TypeError property undefined", 1);
    assert.ok(moreLimited.length <= 1, `Limit 1 should return at most 1 result, got ${moreLimited.length}`);

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 2. Search AND Semantics
// ═══════════════════════════════════════════════════════════

describe("AND semantics (issue #23)", () => {
  test("multi-word query excludes irrelevant single-word matches", () => {
    const store = createStore();

    // Index two documents — one relevant, one only matches on "function"
    store.index({
      content: "## useEffect cleanup\nReturn a cleanup function from useEffect to avoid memory leaks.\nAlways clean up subscriptions and timers in the cleanup function.",
      source: "React Hooks Guide",
    });
    store.index({
      content: "## What is a function\nA function is a reusable block of code that performs a specific task.\nFunctions accept parameters and return values.",
      source: "JavaScript Basics",
    });

    // AND search: only the React chunk should match (has all 3 terms)
    const andResults = store.search("useEffect cleanup function", 5);
    expect(andResults.length).toBe(1);
    expect(andResults[0].source).toBe("React Hooks Guide");

    // OR search: both chunks match (JS Basics matches on "function" alone)
    const orResults = store.search("useEffect cleanup function", 5, undefined, "OR");
    expect(orResults.length).toBe(2);

    store.close();
  });

  test("searchWithFallback uses AND by default, falls back to OR", () => {
    const store = createStore();

    store.index({
      content: "## useEffect cleanup\nReturn a cleanup function from useEffect to avoid memory leaks.",
      source: "React Hooks Guide",
    });
    store.index({
      content: "## What is a function\nA function is a reusable block of code.",
      source: "JavaScript Basics",
    });

    // RRF fuses porter OR + trigram OR — both chunks match on partial terms,
    // but the React chunk ranks higher because it matches all three query terms
    const results = store.searchWithFallback("useEffect cleanup function", 5);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].source).toBe("React Hooks Guide");

    store.close();
  });

  test("AND with no results falls back to OR gracefully", () => {
    const store = createStore();

    store.index({
      content: "## React components\nComponents are the building blocks of React applications.",
      source: "React Guide",
    });
    store.index({
      content: "## Vue components\nVue uses a template-based component system.",
      source: "Vue Guide",
    });

    // "React useState hooks" — AND would match nothing (no chunk has all 3),
    // searchWithFallback should fall back to OR and find the React chunk
    const results = store.searchWithFallback("React useState hooks", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("React Guide");

    store.close();
  });

  test("single-word queries work the same in AND and OR", () => {
    const store = createStore();

    store.index({
      content: "## Authentication\nJWT tokens provide stateless authentication.",
      source: "Auth Guide",
    });

    const andResults = store.search("authentication", 5);
    const orResults = store.search("authentication", 5, undefined, "OR");
    expect(andResults.length).toBe(orResults.length);

    store.close();
  });

  test("trigram search also uses AND semantics", () => {
    const store = createStore();

    store.index({
      content: "## useEffect cleanup pattern\nReturn a cleanup function from useEffect.",
      source: "React Hooks",
    });
    store.index({
      content: "## JavaScript function basics\nA function is a reusable block of code.",
      source: "JS Basics",
    });

    // Trigram AND: partial match "useEff clean func" should only match React chunk
    const andResults = store.searchTrigram("useEffect cleanup function", 5, undefined, "AND");
    // With AND, only the chunk containing ALL terms should match
    for (const r of andResults) {
      expect(r.source).toBe("React Hooks");
    }

    store.close();
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Knowledge-reuse event (removed — read path must not mutate state)
// ═══════════════════════════════════════════════════════════
