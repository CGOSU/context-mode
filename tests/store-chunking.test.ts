/** ContentStore chunking regressions. */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { ContentStore } from "../src/store.js";
import { createStore } from "./helpers/content-store.js";



describe("Heading-Aware Chunking", () => {
  test("splits on H1-H4 headings", () => {
    const store = createStore();
    const result = store.index({
      content:
        "# H1\n\nContent 1\n\n## H2\n\nContent 2\n\n### H3\n\nContent 3\n\n#### H4\n\nContent 4",
      source: "headings",
    });
    assert.equal(result.totalChunks, 4, "Should split into 4 chunks");
    store.close();
  });

  test("splits on --- separators (Context7 format)", () => {
    const store = createStore();
    const result = store.index({
      content:
        "### Section A\n\nContent A\n\n---\n\n### Section B\n\nContent B\n\n---\n\n### Section C\n\nContent C",
      source: "context7-style",
    });
    assert.equal(result.totalChunks, 3, "Should split on --- separators");
    store.close();
  });

  test("keeps code blocks intact (never split mid-block)", () => {
    const store = createStore();
    const result = store.index({
      content:
        '# Example\n\n```javascript\nfunction hello() {\n  console.log("world");\n}\nhello();\n```\n\nMore text after code.',
      source: "code-intact",
    });
    assert.equal(result.totalChunks, 1, "Code block stays with heading");

    // Search should return the complete code block
    const results = store.search("hello function", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].content.includes("console.log"),
      "Code block should be intact",
    );
    assert.ok(
      results[0].content.includes("hello()"),
      "Full code block preserved",
    );
    store.close();
  });

  test("tracks heading hierarchy in titles", () => {
    const store = createStore();
    store.index({
      content:
        "# React\n\n## Hooks\n\n### useEffect\n\nEffect documentation here.",
      source: "hierarchy",
    });
    const results = store.search("Effect documentation", 1);
    assert.ok(results.length > 0);
    assert.ok(
      results[0].title.includes("React"),
      `Title should include H1, got: ${results[0].title}`,
    );
    assert.ok(
      results[0].title.includes("Hooks"),
      `Title should include H2, got: ${results[0].title}`,
    );
    assert.ok(
      results[0].title.includes("useEffect"),
      `Title should include H3, got: ${results[0].title}`,
    );
    store.close();
  });

  test("marks chunks with code as 'code' contentType", () => {
    const store = createStore();
    store.index({
      content:
        "# Prose\n\nJust text.\n\n# Code\n\n```python\nprint('hello')\n```",
      source: "mixed",
    });

    const proseResults = store.search("Just text", 1);
    assert.ok(proseResults.length > 0);
    assert.equal(proseResults[0].contentType, "prose");

    const codeResults = store.search("python print hello", 1);
    assert.ok(codeResults.length > 0);
    assert.equal(codeResults[0].contentType, "code");

    store.close();
  });
});

describe("Plain Text Indexing", () => {
  test("indexPlainText: chunks by line groups", () => {
    const store = createStore();
    const lines = Array.from({ length: 100 }, (_, i) => `Log line ${i + 1}: processing request`).join("\n");
    const result = store.indexPlainText(lines, "build-output");
    assert.ok(result.totalChunks >= 5, `Expected >=5 chunks for 100 lines with 20-line groups, got ${result.totalChunks}`);
    assert.equal(result.label, "build-output");
    assert.equal(result.codeChunks, 0);
    store.close();
  });

  test("indexPlainText: single chunk for small output", () => {
    const store = createStore();
    const content = "Line 1\nLine 2\nLine 3";
    const result = store.indexPlainText(content, "small-output");
    assert.equal(result.totalChunks, 1, `Expected 1 chunk for 3 lines, got ${result.totalChunks}`);
    assert.equal(result.label, "small-output");
    store.close();
  });

  test("indexPlainText: blank-line splitting for sectioned output", () => {
    const store = createStore();
    const content = [
      "Section A line 1\nSection A line 2",
      "Section B line 1\nSection B line 2",
      "Section C line 1\nSection C line 2",
    ].join("\n\n");
    const result = store.indexPlainText(content, "sectioned-output");
    assert.equal(result.totalChunks, 3, `Expected 3 chunks for 3 blank-line-separated sections, got ${result.totalChunks}`);
    store.close();
  });

  test("indexPlainText: searchable after indexing", () => {
    const store = createStore();
    const lines = Array.from({ length: 200 }, (_, i) => {
      if (i === 149) return "ERROR: connection refused to database host";
      return `[INFO] ${i + 1}: normal operation continued`;
    }).join("\n");
    store.indexPlainText(lines, "server-logs");
    const results = store.search("connection refused", 3);
    assert.ok(results.length > 0, "Should find the error line via search");
    assert.ok(
      results[0].content.includes("connection refused"),
      `Result should contain 'connection refused', got: ${results[0].content.slice(0, 100)}`,
    );
    store.close();
  });

  test("indexPlainText: empty content returns 0 chunks", () => {
    const store = createStore();
    const result = store.indexPlainText("", "empty-output");
    assert.equal(result.totalChunks, 0, "Empty content should produce 0 chunks");
    assert.equal(result.label, "empty-output");
    store.close();
  });

  test("indexPlainText: in-memory store works", () => {
    const store = new ContentStore(":memory:");
    const content = "Line 1\nLine 2\nLine 3";
    const result = store.indexPlainText(content, "memory-test");
    assert.equal(result.totalChunks, 1);
    assert.equal(result.label, "memory-test");

    const searchResults = store.search("Line 1", 1);
    assert.ok(searchResults.length > 0, "In-memory store should support search");
    assert.ok(searchResults[0].content.includes("Line 1"));
    store.close();
  });
});

describe("Smart Chunk Titles", () => {
  test("smart chunk titles: blank-line split uses first line as title", () => {
    const store = createStore();
    // 4 blank-line-separated sections with meaningful first lines
    const content = [
      "v2.3.0 - Performance improvements\nFixed memory leak in connection pool\nReduced startup time by 40%",
      "v2.2.1 - Security patch\nPatched XSS vulnerability in template engine\nUpdated dependencies",
      "v2.2.0 - New features\nAdded WebSocket support\nNew configuration API",
      "v2.1.0 - Bug fixes\nFixed race condition in worker threads\nImproved error messages",
    ].join("\n\n");
    store.indexPlainText(content, "changelog-sections");

    // Search for a term in the first section
    const results = store.search("memory leak connection pool", 1);
    assert.ok(results.length > 0, "Should find the section");
    assert.ok(
      results[0].title.startsWith("v2.3.0"),
      `Title should be first line 'v2.3.0 - Performance improvements', got: '${results[0].title}'`,
    );
    // Should NOT be a generic "Section N" title
    assert.ok(
      !results[0].title.startsWith("Section"),
      `Title should not be generic 'Section N', got: '${results[0].title}'`,
    );

    // Verify another section too
    const results2 = store.search("XSS vulnerability template", 1);
    assert.ok(results2.length > 0, "Should find second section");
    assert.ok(
      results2[0].title.startsWith("v2.2.1"),
      `Title should be 'v2.2.1 - Security patch', got: '${results2[0].title}'`,
    );
    store.close();
  });

  test("smart chunk titles: line-group chunks use first line as title", () => {
    const store = createStore();
    // Create enough lines (>20) to trigger line-group chunking (not blank-line splitting)
    // by making it a single block of lines with no blank-line sections
    const lines = Array.from({ length: 60 }, (_, i) => {
      if (i === 0) return "ERROR: Failed to compile module 'auth-service'";
      if (i === 20) return "WARNING: Deprecated API usage in routes/v2.ts";
      if (i === 40) return "INFO: Build completed with 2 warnings";
      return `[LOG] Step ${i}: processing task ${i}`;
    });
    const content = lines.join("\n");
    store.indexPlainText(content, "build-log");

    // Search for content in the first chunk
    const results = store.search("Failed compile auth-service", 1);
    assert.ok(results.length > 0, "Should find the first chunk");
    assert.ok(
      results[0].title.includes("ERROR"),
      `Title should be first line of chunk containing 'ERROR', got: '${results[0].title}'`,
    );
    // Should NOT be a generic "Lines N-M" title
    assert.ok(
      !results[0].title.startsWith("Lines"),
      `Title should not be generic 'Lines N-M', got: '${results[0].title}'`,
    );
    store.close();
  });
});

describe("Max Chunk Size", () => {
  test("splits oversized markdown chunk at paragraph boundaries", () => {
    const store = createStore();
    const paragraphs = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i + 1}. ${"Lorem ipsum dolor sit amet. ".repeat(20)}`
    );
    const content = `# Big Section\n\n${paragraphs.join("\n\n")}`;

    const result = store.index({ content, source: "max-chunk-test" });
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const searchResult = store.search("Paragraph", 10, "max-chunk-test");
    for (const r of searchResult) {
      assert.ok(r.title.includes("Big Section"), `Expected heading in title, got: ${r.title}`);
    }
    store.close();
  });

  test("does not split chunks already under maxChunkBytes", () => {
    const store = createStore();
    const content = `# Small Section\n\nJust a few lines of text.\n\nAnother paragraph.`;
    const result = store.index({ content, source: "small-chunk-test" });
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  test("keeps code blocks intact when splitting oversized chunks", () => {
    const store = createStore();
    const codeBlock = "```typescript\n" + "const x = 1;\n".repeat(100) + "```";
    const prose = Array.from({ length: 10 }, (_, i) =>
      `Paragraph ${i}. ${"Text content here. ".repeat(20)}`
    ).join("\n\n");
    const content = `# Code Section\n\n${codeBlock}\n\n${prose}`;

    const result = store.index({ content, source: "code-chunk-test" });
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    const codeResults = store.search("const x", 5, "code-chunk-test");
    assert.ok(codeResults.length > 0, "Should find the code block");
    assert.ok(
      codeResults[0].content.includes("```typescript"),
      "Code block should be intact with opening fence",
    );
    store.close();
  });
});
