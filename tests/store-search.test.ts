/** ContentStore search regressions. */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { createStore } from "./helpers/content-store.js";



describe("BM25 Search", () => {
  test("basic keyword search returns results", () => {
    const store = createStore();
    store.index({
      content:
        "# Authentication\n\nUse JWT tokens for API auth.\n\n# Caching\n\nRedis for session caching.",
      source: "docs",
    });
    const results = store.search("JWT authentication", 2);
    assert.ok(results.length > 0, "Should find results");
    assert.ok(
      results[0].content.includes("JWT"),
      "First result should be about JWT",
    );
    store.close();
  });

  test("title match weighted higher than content match", () => {
    const store = createStore();
    store.index({
      content:
        "# useEffect\n\nThe effect hook.\n\n# useState\n\nuseEffect is mentioned here in passing.",
      source: "hooks",
    });
    const results = store.search("useEffect", 2);
    assert.ok(results.length >= 1);
    // The chunk with useEffect in the TITLE should rank first
    assert.ok(
      results[0].title.includes("useEffect"),
      `Title match should rank first, got title: ${results[0].title}`,
    );
    store.close();
  });

  test("porter stemming matches word variants", () => {
    const store = createStore();
    store.index({
      content:
        "# Connecting\n\nEstablish connections to the database.\n\n# Caching\n\nCache your responses.",
      source: "stemming",
    });
    // "connect" should match "connecting" and "connections"
    const results = store.search("connect", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].content.includes("connections") ||
        results[0].title.includes("Connecting"),
      "Stemming should match variants",
    );
    store.close();
  });

  test("search with no results returns empty array", () => {
    const store = createStore();
    store.index({
      content: "# React\n\nComponent lifecycle.",
      source: "react",
    });
    const results = store.search("kubernetes deployment yaml", 3);
    assert.equal(results.length, 0, "Should return empty for irrelevant query");
    store.close();
  });

  test("limit parameter controls result count", () => {
    const store = createStore();
    store.index({
      content:
        "# A\n\nApple.\n\n# B\n\nBanana.\n\n# C\n\nCherry.\n\n# D\n\nDate.",
      source: "fruits",
    });
    const results1 = store.search("fruit", 1);
    assert.ok(results1.length <= 1);

    const results3 = store.search("fruit", 10);
    // May return less if not all match
    assert.ok(results3.length >= 0);
    store.close();
  });

  test("results include source label", () => {
    const store = createStore();
    store.index({
      content: "# Setup\n\nInstall the package.",
      source: "Context7: React docs",
    });
    const results = store.search("Install package", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: React docs");
    store.close();
  });

  test("results include rank score", () => {
    const store = createStore();
    store.index({
      content: "# Test\n\nSome test content here.",
      source: "ranked",
    });
    const results = store.search("test content", 1);
    assert.ok(results.length > 0);
    assert.equal(typeof results[0].rank, "number");
    store.close();
  });
});

describe("Query Sanitization", () => {
  test("handles special FTS5 characters in query", () => {
    const store = createStore();
    store.index({
      content: "# Test\n\nSome content here.",
      source: "sanitize",
    });
    // These should not throw FTS5 parse errors
    assert.doesNotThrow(() => store.search('test "quoted"', 1));
    assert.doesNotThrow(() => store.search("test AND OR NOT", 1));
    assert.doesNotThrow(() => store.search("test()", 1));
    assert.doesNotThrow(() => store.search("test*", 1));
    assert.doesNotThrow(() => store.search("test:value", 1));
    assert.doesNotThrow(() => store.search("test^2", 1));
    assert.doesNotThrow(() => store.search("{test}", 1));
    assert.doesNotThrow(() => store.search("NEAR/3", 1));
    store.close();
  });

  test("empty query returns empty results", () => {
    const store = createStore();
    store.index({
      content: "# Doc\n\nContent.",
      source: "empty-q",
    });
    const results = store.search("", 3);
    assert.equal(results.length, 0, "Empty query should return no results");
    store.close();
  });
});

describe("getDistinctiveTerms", () => {
  test("getDistinctiveTerms: returns terms in moderate frequency range", () => {
    const store = createStore();
    // Create content with 10 sections. A distinctive term appears in 3-4 sections
    // (i.e., >= 2 and <= 40% of 10 = 4).
    const sections = Array.from({ length: 10 }, (_, i) => {
      const base = `## Section ${i}\n\nGeneric content for section number ${i}.`;
      if (i < 3) return `${base}\n\nThe authentication middleware validates tokens.`;
      if (i < 5) return `${base}\n\nThe database connection pool handles queries.`;
      return `${base}\n\nPlain filler paragraph without special keywords.`;
    }).join("\n\n");
    const result = store.indexPlainText(sections, "distinctive-moderate");
    const terms = store.getDistinctiveTerms(result.sourceId);
    assert.ok(Array.isArray(terms), "Should return an array");
    assert.ok(terms.length > 0, `Should return some distinctive terms, got ${terms.length}`);
    // "authentication" appears in 3/10 sections — should be distinctive
    assert.ok(
      terms.includes("authentication"),
      `Expected 'authentication' in distinctive terms, got: ${terms.join(", ")}`,
    );
    store.close();
  });

  test("getDistinctiveTerms: returns empty for too few sections", () => {
    const store = createStore();
    // Only 2 sections — below the chunk_count < 3 threshold
    const content = "Section A content here.\n\nSection B content here.";
    const result = store.indexPlainText(content, "too-few-sections");
    assert.ok(result.totalChunks <= 2, `Expected <=2 chunks, got ${result.totalChunks}`);
    const terms = store.getDistinctiveTerms(result.sourceId);
    assert.deepEqual(terms, [], "Should return empty array for fewer than 3 chunks");
    store.close();
  });

  test("getDistinctiveTerms: excludes stopwords", () => {
    const store = createStore();
    // Create 5 sections where stopwords "the", "this", "that", "with" appear in every section.
    // "encryption" appears in 2 sections (moderate frequency).
    const sections = Array.from({ length: 5 }, (_, i) => {
      const base = `## Part ${i}\n\nThis is the content that comes with part number ${i}.`;
      if (i < 2) return `${base}\n\nEncryption algorithms protect the data.`;
      return base;
    }).join("\n\n");
    const result = store.indexPlainText(sections, "stopwords-test");
    const terms = store.getDistinctiveTerms(result.sourceId);
    // Stopwords should never appear
    const stopwords = ["the", "this", "that", "with", "for", "and"];
    for (const sw of stopwords) {
      assert.ok(
        !terms.includes(sw),
        `Stopword '${sw}' should not be in distinctive terms`,
      );
    }
    // "encryption" appears in 2/5 sections — should qualify
    assert.ok(
      terms.includes("encryption"),
      `Expected 'encryption' in terms, got: ${terms.join(", ")}`,
    );
    store.close();
  });
});

describe("Sanitize query token deduplication", () => {
  test("sanitizeQuery removes duplicate tokens (case-insensitive)", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    assert.equal(
      sanitizeQuery("error error error"),
      '"error"',
      "three identical tokens should compile to a single quoted term",
    );
    assert.equal(
      sanitizeQuery("Error ERROR error"),
      '"Error"',
      "case differences should not create duplicate tokens",
    );
  });

  test("sanitizeQuery preserves first-occurrence casing after dedup", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    assert.equal(sanitizeQuery("Database database DATABASE"), '"Database"');
  });

  test("sanitizeQuery preserves distinct tokens and their order", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    // "update" is a stopword, but the meaningful terms remain distinct.
    assert.equal(
      sanitizeQuery("database query database index query"),
      '"database" "query" "index"',
      "distinct tokens should be kept; duplicates collapsed in first-seen order",
    );
  });

  test("sanitizeTrigramQuery removes duplicate tokens", async () => {
    const { sanitizeTrigramQuery } = await import("../src/store.js");
    assert.equal(
      sanitizeTrigramQuery("error error error"),
      '"error"',
    );
    assert.equal(
      sanitizeTrigramQuery("error ERROR Error"),
      '"error"',
      "case-insensitive dedup across all three trigram sanitize paths",
    );
  });

  test("dedup in OR mode collapses duplicates but preserves distinct terms", async () => {
    const { sanitizeQuery } = await import("../src/store.js");
    assert.equal(
      sanitizeQuery("error error database", "OR"),
      '"error" OR "database"',
    );
  });

  test("search returns identical results for duplicated and deduplicated queries", () => {
    const store = createStore();
    store.index({
      content:
        "# Error Handling\n\nThe database connection threw an error during migration.\n\n# Overview\n\nPlain content.",
      source: "dedup-behavioral",
    });

    const duplicated = store.search("error error error database database");
    const unique = store.search("error database");

    assert.equal(duplicated.length, unique.length);
    for (let i = 0; i < duplicated.length; i++) {
      assert.equal(duplicated[i].title, unique[i].title);
      assert.equal(duplicated[i].content, unique[i].content);
    }
    store.close();
  });
});

describe("Stopword filtering in search queries", () => {
  test("stopwords are filtered from search — meaningful terms drive ranking", () => {
    const store = createStore();
    // "fix" and "update" are stopwords in the domain list.
    // "database" and "connection" are meaningful terms.
    store.index({
      content:
        "# Database Connection Pool\n\nManage database connections with pooling.\n\n# Update Log\n\nFix applied to update module on Tuesday.",
      source: "stopword-search",
    });

    // Search with stopwords mixed in — results should prioritize "database connection"
    const results = store.search("fix database connection", 2);
    assert.ok(results.length > 0, "Should return results");
    assert.ok(
      results[0].content.toLowerCase().includes("database") &&
        results[0].content.toLowerCase().includes("connection"),
      `Top result should match meaningful terms 'database connection', got: ${results[0].title}`,
    );
    store.close();
  });

  test("all-stopword query still returns results (fallback)", () => {
    const store = createStore();
    store.index({
      content: "# Updates\n\nUpdate the test runner to fix the issue.\n\n# Other\n\nUnrelated content.",
      source: "all-stopwords",
    });

    // "update test fix" are all stopwords — should fall back to using them
    const results = store.search("update test fix", 2);
    assert.ok(results.length > 0, "All-stopword query should still return results via fallback");
    store.close();
  });

  test("stopwords filtered from trigram search", () => {
    const store = createStore();
    store.index({
      content:
        "# Encryption Module\n\nAES encryption with key rotation.\n\n# Testing Guide\n\nRun tests using the test framework.",
      source: "trigram-stopwords",
    });

    // "using" is a stopword, "encryption" is meaningful
    const results = store.searchTrigram("using encryption", 2);
    assert.ok(results.length > 0, "Should return results");
    assert.ok(
      results[0].content.toLowerCase().includes("encryption"),
      `Should match on meaningful term 'encryption', got: ${results[0].title}`,
    );
    store.close();
  });

  test("proximity reranking ignores stopwords for boost calculation", () => {
    const store = createStore();
    // Two chunks: one has "database error" close together, the other has them far apart
    // but has "fix" (stopword) nearby
    store.index({
      content:
        "# Error Handling\n\nThe database threw an error during migration.\n\n# Fix Log\n\nWe fix things. Much later in this document we mention database. Even later we see error.",
      source: "proximity-stopwords",
    });

    const results = store.searchWithFallback("fix database error", 2);
    assert.ok(results.length > 0, "Should return results");
    // The chunk with "database" and "error" close together should rank higher
    // because "fix" (stopword) is excluded from proximity calculation
    assert.ok(
      results[0].content.toLowerCase().includes("database") &&
        results[0].content.toLowerCase().includes("error") &&
        results[0].title.includes("Error"),
      `Proximity should favor chunk with meaningful terms close together, got: ${results[0].title}`,
    );
    store.close();
  });
});
