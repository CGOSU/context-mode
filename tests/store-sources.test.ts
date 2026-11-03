/** ContentStore sources regressions. */

import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { createStore } from "./helpers/content-store.js";



describe("Multi-Source Indexing", () => {
  test("search across multiple indexed sources", () => {
    const store = createStore();
    store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "Context7: React",
    });
    store.index({
      content: "# Supabase Auth\n\nRow Level Security policies.",
      source: "Context7: Supabase",
    });
    store.index({
      content: "# Tailwind\n\nResponsive breakpoints with sm, md, lg.",
      source: "Context7: Tailwind",
    });

    const reactResults = store.search("useEffect", 1);
    assert.ok(reactResults.length > 0);
    assert.equal(reactResults[0].source, "Context7: React");

    const supaResults = store.search("Row Level Security", 1);
    assert.ok(supaResults.length > 0);
    assert.equal(supaResults[0].source, "Context7: Supabase");

    const twResults = store.search("responsive breakpoints", 1);
    assert.ok(twResults.length > 0);
    assert.equal(twResults[0].source, "Context7: Tailwind");

    const stats = store.getStats();
    assert.equal(stats.sources, 3);
    store.close();
  });

  test("re-indexing same source replaces previous entry (dedup)", () => {
    const store = createStore();
    store.index({
      content: "# Part 1\n\nFirst batch.",
      source: "incremental",
    });
    store.index({
      content: "# Part 2\n\nSecond batch.",
      source: "incremental",
    });
    const stats = store.getStats();
    assert.equal(stats.sources, 1, "Dedup replaces previous source with same label");
    assert.ok(stats.chunks >= 1);
    store.close();
  });
});

describe("Source-Scoped Search", () => {
  test("search with source filter returns only matching source", () => {
    const store = createStore();
    store.index({
      content: "# Zod Transform\n\nUse .transform() to map values.\n\n## Refine\n\nUse .refine() for custom validation.",
      source: "Zod API docs",
    });
    store.index({
      content: "# Security Release\n\nCVE-2025-1234: Fixed transform injection vulnerability.\n\n## Fixes\n\nRefine permission checks.",
      source: "Node.js v22 CHANGELOG",
    });

    // Without source filter — both sources may match (OR mode for cross-chunk terms)
    const allResults = store.search("transform refine", 5, undefined, "OR");
    assert.ok(allResults.length >= 2, "Should find results from both sources");

    // With source filter — only Zod
    const zodResults = store.search("transform refine", 5, "Zod", "OR");
    assert.ok(zodResults.length > 0, "Should find Zod results");
    assert.ok(
      zodResults.every((r) => r.source.includes("Zod")),
      `All results should be from Zod, got: ${zodResults.map((r) => r.source).join(", ")}`,
    );

    // With source filter — only Node.js
    const nodeResults = store.search("transform refine", 5, "Node.js", "OR");
    assert.ok(nodeResults.length > 0, "Should find Node.js results");
    assert.ok(
      nodeResults.every((r) => r.source.includes("Node.js")),
      `All results should be from Node.js, got: ${nodeResults.map((r) => r.source).join(", ")}`,
    );

    store.close();
  });

  test("search with non-matching source returns empty", () => {
    const store = createStore();
    store.index({
      content: "# React Hooks\n\nuseEffect for side effects.",
      source: "React docs",
    });
    const results = store.search("useEffect", 3, "Vue");
    assert.equal(results.length, 0, "Should return empty for non-matching source");
    store.close();
  });

  test("listSources returns all indexed sources", () => {
    const store = createStore();
    store.index({ content: "# A\n\nContent A.", source: "Source A" });
    store.index({ content: "# B\n\nContent B.", source: "Source B" });
    store.index({ content: "# C\n\nContent C.", source: "Source C" });

    const sources = store.listSources();
    assert.equal(sources.length, 3, `Expected 3 sources, got ${sources.length}`);
    const labels = sources.map((s) => s.label);
    assert.ok(labels.includes("Source A"));
    assert.ok(labels.includes("Source B"));
    assert.ok(labels.includes("Source C"));
    assert.ok(sources.every((s) => s.chunkCount >= 1));
    store.close();
  });

  test("source filter uses partial match (LIKE)", () => {
    const store = createStore();
    store.index({ content: "# Config\n\nDatabase config.", source: "Node.js v22 CHANGELOG" });
    store.index({ content: "# Config\n\nApp config.", source: "Zod API docs" });

    // Partial match "v22" should match "Node.js v22 CHANGELOG"
    const results = store.search("config", 5, "v22");
    assert.ok(results.length > 0, "Partial source match should work");
    assert.ok(
      results.every((r) => r.source.includes("v22")),
      "Should only return v22 source",
    );
    store.close();
  });

  // Regression: #646 — LIKE wildcards in user-supplied source labels must not leak.
  // SQLite LIKE treats `_` as "any single char" and `%` as "any sequence". Sources
  // that naturally contain these (URL-encoded paths, versioned API endpoints,
  // underscored filenames) silently turned into wildcards and pulled in chunks
  // from unrelated sources. Fix escapes `_`, `%`, and `\` with ESCAPE '\'.
  test("source filter does not leak via `_` wildcard in source label (#646)", () => {
    const store = createStore();
    store.index({ content: "# A\n\nfoo bar baz qux content matter", source: "api_v1" });
    store.index({ content: "# B\n\nfoo bar baz qux different content matter", source: "apiXv1" });
    store.index({ content: "# C\n\nfoo bar baz qux another content matter", source: "api-v1" });
    store.index({ content: "# D\n\nfoo bar baz qux unrelated matter", source: "completely-other" });

    // BM25 (porter) path
    const porter = store.search("foo bar baz qux matter", 10, "api_v1");
    assert.ok(porter.length > 0, "Should match the literal source");
    assert.ok(
      porter.every((r) => r.source === "api_v1"),
      `Underscore must be literal, not LIKE wildcard. Got: ${porter.map((r) => r.source).join(", ")}`,
    );

    // Trigram path — same scoping contract
    const trigram = store.searchTrigram("foo bar baz qux matter", 10, "api_v1", "OR");
    assert.ok(
      trigram.every((r) => r.source === "api_v1"),
      `Trigram path must also escape underscore. Got: ${trigram.map((r) => r.source).join(", ")}`,
    );

    // Fallback (RRF + fuzzy) path
    const fallback = store.searchWithFallback("foo bar baz qux matter", 10, "api_v1");
    assert.ok(
      fallback.every((r) => r.source === "api_v1"),
      `Fallback path must also escape underscore. Got: ${fallback.map((r) => r.source).join(", ")}`,
    );

    store.close();
  });

  test("source filter does not leak via `%` wildcard in source label (#646)", () => {
    const store = createStore();
    store.index({ content: "# E\n\nhello world content matter", source: "100%off" });
    store.index({ content: "# F\n\nhello world stuff matter", source: "100ANYTHINGoff" });
    store.index({ content: "# G\n\nhello world other matter", source: "unrelated-source" });

    const results = store.search("hello world matter", 10, "100%off");
    assert.ok(results.length > 0, "Should match literal `100%off`");
    assert.ok(
      results.every((r) => r.source === "100%off"),
      `Percent must be literal, not LIKE wildcard. Got: ${results.map((r) => r.source).join(", ")}`,
    );
    store.close();
  });

  test("source filter still treats partial substring as substring after escaping (#646)", () => {
    // Confirms the escape fix did not regress legitimate substring matching
    // for sources without LIKE metacharacters.
    const store = createStore();
    store.index({ content: "# H\n\nConfig database.", source: "Node.js v22 CHANGELOG" });
    store.index({ content: "# I\n\nApp config.", source: "Zod API docs" });

    const results = store.search("config", 5, "v22");
    assert.ok(results.length > 0, "Plain partial match must still work after escape fix");
    assert.ok(
      results.every((r) => r.source.includes("v22")),
      `Plain substring still works. Got: ${results.map((r) => r.source).join(", ")}`,
    );
    store.close();
  });

  test("source filter handles backslash literal in source label (#646)", () => {
    // Backslash is the ESCAPE character — must itself be escaped to remain literal.
    const store = createStore();
    store.index({ content: "# J\n\nbackslash content matter", source: "path\\to\\thing" });
    store.index({ content: "# K\n\nbackslash other matter", source: "pathXtoXthing" });

    const results = store.search("backslash matter", 10, "path\\to\\thing");
    assert.ok(results.length > 0, "Should match the literal backslash source");
    assert.ok(
      results.every((r) => r.source === "path\\to\\thing"),
      `Backslash must be literal. Got: ${results.map((r) => r.source).join(", ")}`,
    );
    store.close();
  });
});

// ── Source metadata & TTL cache ───────────────────────────────────────

describe("Source metadata (TTL cache)", () => {
  test("getSourceMeta returns null for unknown source", () => {
    const store = createStore();
    const meta = store.getSourceMeta("nonexistent-source");
    expect(meta).toBeNull();
    store.close();
  });

  test("getSourceMeta returns metadata after indexing", () => {
    const store = createStore();
    store.index({ content: "# Hello\nWorld", source: "test-doc" });
    const meta = store.getSourceMeta("test-doc");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("test-doc");
    expect(meta!.chunkCount).toBeGreaterThan(0);
    expect(meta!.indexedAt).toBeTruthy();
    store.close();
  });

  test("getSourceMeta indexedAt is valid datetime", () => {
    const store = createStore();
    store.index({ content: "# Test\nContent here", source: "datetime-test" });
    const meta = store.getSourceMeta("datetime-test");
    const parsed = new Date(meta!.indexedAt);
    expect(parsed.getTime()).not.toBeNaN();
    store.close();
  });

  test("getSourceMeta updates after re-indexing same source", () => {
    const store = createStore();
    store.index({ content: "# V1\nFirst version", source: "evolving-doc" });
    const meta1 = store.getSourceMeta("evolving-doc");
    store.index({ content: "# V2\nSecond version\n## Extra\nMore content", source: "evolving-doc" });
    const meta2 = store.getSourceMeta("evolving-doc");
    expect(meta2!.chunkCount).toBeGreaterThanOrEqual(meta1!.chunkCount);
    store.close();
  });
});
