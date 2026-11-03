/** ContentStore indexing, fixture integration and filesystem safety regressions. */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ContentStore } from "../src/store.js";
import { closeDB, loadDatabase } from "../src/db-base.js";
import { createStore } from "./helpers/content-store.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");


describe("Basic Indexing", () => {
  test("index simple markdown content", () => {
    const store = createStore();
    const result = store.index({
      content: "# Hello\n\nThis is a test document.",
      source: "test-doc",
    });
    assert.equal(result.label, "test-doc");
    assert.equal(result.totalChunks, 1);
    assert.equal(result.codeChunks, 0);
    assert.ok(result.sourceId > 0);
    store.close();
  });

  test("index content with code blocks", () => {
    const store = createStore();
    const result = store.index({
      content:
        "# API Guide\n\n```javascript\nconsole.log('hello');\n```\n\n## Usage\n\nSome text.",
      source: "api-guide",
    });
    assert.ok(result.totalChunks >= 1);
    assert.ok(result.codeChunks >= 1, "Should detect code chunks");
    store.close();
  });

  test("index empty content throws (falsy content requires path)", () => {
    const store = createStore();
    // Empty string is falsy — same as not providing content
    assert.throws(() => store.index({ content: "", source: "empty" }), /Either content or path/);
    store.close();
  });

  test("index whitespace-only content returns 0 chunks", () => {
    const store = createStore();
    const result = store.index({
      content: "   \n\n   \n",
      source: "whitespace",
    });
    assert.equal(result.totalChunks, 0);
    store.close();
  });

  test("index from file path", () => {
    const store = createStore();
    const result = store.index({
      path: join(fixtureDir, "context7-react-docs.md"),
      source: "Context7: React useEffect",
    });
    assert.ok(result.totalChunks > 0, "Should chunk the fixture");
    assert.ok(result.codeChunks > 0, "React docs have code blocks");
    assert.equal(result.label, "Context7: React useEffect");
    store.close();
  });

  test("index throws when neither content nor path provided", () => {
    const store = createStore();
    assert.throws(() => store.index({}), /Either content or path/);
    store.close();
  });

  test("index reads file when content is empty string and path is provided (regression #350)", () => {
    // Some MCP clients send `content: ""` together with `path`. The previous
    // implementation used `content ?? readFileSync(path)` which kept the empty
    // string and indexed 0 chunks. Empty content + a valid path must fall
    // back to reading the file.
    const store = createStore();
    const result = store.index({
      content: "",
      path: join(fixtureDir, "context7-react-docs.md"),
      source: "Context7: empty-content path repro",
    });
    assert.ok(result.totalChunks > 0, "Should chunk the fixture from path even when content is empty string");
    assert.ok(result.codeChunks > 0, "React docs have code blocks");
    assert.equal(result.label, "Context7: empty-content path repro");
    store.close();
  });

  test("stats update after indexing", () => {
    const store = createStore();
    store.index({
      content: "# Title\n\nSome content.\n\n## Section\n\nMore content.",
      source: "doc-1",
    });
    const stats = store.getStats();
    assert.ok(stats.sources >= 1);
    assert.ok(stats.chunks >= 1);
    store.close();
  });

  test("attribution flows through to chunks.session_id and chunks.event_id (#FK)", () => {
    // SLICE 1: index*() must accept an optional `attribution` so chunks rows
    // carry the session/event that triggered them. Hardcoded "" defeats the
    // FK to session_events that powers per-session honest-savings stats.
    const dbPath = join(
      tmpdir(),
      `context-mode-attrfk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const store = new ContentStore(dbPath);
    store.index({
      content: "# Hello\n\nAttribution test body.",
      source: "attr-doc",
      attribution: { sessionId: "sess-FK-1", eventId: "evt-FK-9" },
    } as Parameters<typeof store.index>[0]);

    store.indexPlainText(
      "log line one\nlog line two\nlog line three",
      "attr-plain",
      20,
      { sessionId: "sess-FK-2", eventId: "evt-FK-10" },
    );

    store.indexJSON(
      JSON.stringify({ a: 1, b: { c: "x" } }),
      "attr-json",
      undefined,
      { sessionId: "sess-FK-3", eventId: "evt-FK-11" },
    );

    // Read raw rows back through a fresh handle to confirm persisted columns.
    store.close();
    const Database = loadDatabase();
    const db = new Database(dbPath, { readonly: true });
    try {
      const rows = db
        .prepare(
          "SELECT title, source_id, session_id, event_id FROM chunks WHERE session_id != '' ORDER BY rowid",
        )
        .all() as Array<{ title: string; session_id: string; event_id: string }>;
      const sessions = rows.map((r) => r.session_id);
      const events = rows.map((r) => r.event_id);
      assert.ok(rows.length >= 3, `expected attributed chunks across 3 indexers, got ${rows.length}`);
      assert.ok(sessions.includes("sess-FK-1"), "index() must persist sessionId");
      assert.ok(sessions.includes("sess-FK-2"), "indexPlainText() must persist sessionId");
      assert.ok(sessions.includes("sess-FK-3"), "indexJSON() must persist sessionId");
      assert.ok(events.includes("evt-FK-9"), "index() must persist eventId");
      assert.ok(events.includes("evt-FK-10"), "indexPlainText() must persist eventId");
      assert.ok(events.includes("evt-FK-11"), "indexJSON() must persist eventId");
    } finally {
      closeDB(db);
    }
  });
});

describe("Fixture-Based Tests (Real MCP Output)", () => {
  test("Context7 React docs: index and search code examples", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-react-docs.md"),
      "utf-8",
    );
    const result = store.index({
      content,
      source: "Context7: React useEffect",
    });
    assert.ok(result.totalChunks >= 3, `Expected >=3 chunks, got ${result.totalChunks}`);
    assert.ok(result.codeChunks >= 1, "Should detect code chunks");

    // Search for specific code patterns
    const cleanup = store.search("cleanup function disconnect", 2);
    assert.ok(cleanup.length > 0, "Should find cleanup pattern");
    assert.ok(
      cleanup[0].content.includes("disconnect"),
      "Should contain exact disconnect code",
    );

    // Search for fetch pattern
    const fetch = store.search("fetch data ignore stale", 2);
    assert.ok(fetch.length > 0, "Should find fetch pattern");
    assert.ok(
      fetch[0].content.includes("ignore"),
      "Should contain ignore flag pattern",
    );

    store.close();
  });

  test("Context7 Next.js docs: index and search", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-nextjs-docs.md"),
      "utf-8",
    );
    const result = store.index({
      content,
      source: "Context7: Next.js App Router",
    });
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    // Search should return relevant content
    const results = store.search("App Router", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: Next.js App Router");
    store.close();
  });

  test("Context7 Tailwind docs: index and search", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-tailwind-docs.md"),
      "utf-8",
    );
    const result = store.index({
      content,
      source: "Context7: Tailwind CSS",
    });
    assert.ok(result.totalChunks >= 1);

    const results = store.search("Tailwind", 1);
    assert.ok(results.length > 0);
    assert.equal(results[0].source, "Context7: Tailwind CSS");
    store.close();
  });

  test("MCP tools JSON: index and search tool signatures", () => {
    const store = createStore();
    // Convert JSON to searchable markdown format
    const raw = readFileSync(join(fixtureDir, "mcp-tools.json"), "utf-8");
    const tools = JSON.parse(raw);

    const markdown = tools
      .map(
        (t: { name: string; description: string }) =>
          `### ${t.name}\n\n${t.description}`,
      )
      .join("\n\n---\n\n");

    const result = store.index({
      content: markdown,
      source: "MCP: tools/list",
    });
    assert.ok(
      result.totalChunks >= 5,
      `Expected >=5 chunks for 40 tools, got ${result.totalChunks}`,
    );
    store.close();
  });
});

describe("Edge Cases", () => {
  test("content with no headings creates single chunk", () => {
    const store = createStore();
    const result = store.index({
      content: "Just plain text without any markdown headings.",
      source: "plain",
    });
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  test("nested code blocks (triple backtick inside fenced)", () => {
    const store = createStore();
    const content =
      '# Example\n\n````markdown\n```javascript\nconsole.log("nested");\n```\n````';
    const result = store.index({ content, source: "nested" });
    assert.ok(result.totalChunks >= 1);
    assert.ok(result.codeChunks >= 1);

    const results = store.search("nested console", 1);
    assert.ok(results.length > 0);
    assert.ok(results[0].content.includes("nested"), "Nested code preserved");
    store.close();
  });

  test("very long content chunks correctly", () => {
    const store = createStore();
    const sections = Array.from(
      { length: 20 },
      (_, i) => `## Section ${i}\n\nContent for section ${i}.\n`,
    ).join("\n");
    const result = store.index({
      content: sections,
      source: "long-doc",
    });
    assert.equal(
      result.totalChunks,
      20,
      `Expected 20 chunks, got ${result.totalChunks}`,
    );
    store.close();
  });

  test("heading-only content (no body) still creates chunk", () => {
    const store = createStore();
    const result = store.index({
      content: "# Title Only\n\n## Another Heading",
      source: "headings-only",
    });
    // The heading lines themselves are content
    assert.ok(result.totalChunks >= 1);
    store.close();
  });
});

describe("Context Savings Measurement", () => {
  test("index+search uses less context than raw content", () => {
    const store = createStore();
    const content = readFileSync(
      join(fixtureDir, "context7-react-docs.md"),
      "utf-8",
    );
    const rawBytes = Buffer.byteLength(content);

    store.index({ content, source: "React docs" });

    // Search returns only relevant chunk, not full doc
    const results = store.search("useEffect cleanup", 1);
    assert.ok(results.length > 0);

    const resultBytes = Buffer.byteLength(
      results.map((r) => `${r.title}\n${r.content}`).join("\n"),
    );
    assert.ok(
      resultBytes < rawBytes,
      "Search result should be smaller than full doc",
    );
    store.close();
  });
});

describe("ctx_index TOCTOU symlink swap (#442 round-3)", () => {
  test("index() rejects non-regular files (e.g. /dev/null) via fd-bound fstat", () => {
    // RED proof: prior to the fix, `readFileSync('/dev/null', 'utf-8')`
    // returned "" so the index call silently produced 0 chunks instead
    // of rejecting. After the fix, openSync + fstat + isFile() check
    // throws because /dev/null is a character device, not a regular
    // file. This invariant closes the swap-mid-flight window: any
    // post-gate path swap to a non-regular target fails fstat.
    if (process.platform === "win32") return; // /dev/null differs on win32
    const charDev = "/dev/null";
    const store = createStore();
    try {
      assert.throws(
        () => store.index({ path: charDev, source: "chardev" }),
        /not a regular file/,
        "non-regular files must be rejected by fd-bound fstat",
      );
    } finally {
      store.close();
    }
  });

  test("index() rejects non-regular files via fd-bound fstat (directory)", () => {
    // If the path is swapped to a directory between gate and read,
    // fstat on the opened fd reveals it and the read is rejected.
    const dirPath = join(
      tmpdir(),
      `ctx-toctou-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const requireFn = createRequire(import.meta.url);
    const fsSync = requireFn("node:fs");
    fsSync.mkdirSync(dirPath);

    try {
      const store = createStore();
      assert.throws(
        () => store.index({ path: dirPath, source: "dir" }),
        /not a regular file|EISDIR/,
        "directory must not be readable through index()",
      );
      store.close();
    } finally {
      try { fsSync.rmdirSync(dirPath); } catch { /* ignore */ }
    }
  });

  test("index() reads file content via fd (regression: normal indexing still works)", () => {
    // After fd-bound read fix, normal file indexing must still produce
    // the same chunks/content as before. Validates the GREEN path.
    const requireFn = createRequire(import.meta.url);
    const fsSync = requireFn("node:fs");
    const safePath = join(
      tmpdir(),
      `ctx-toctou-safe-${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
    );
    fsSync.writeFileSync(
      safePath,
      "# Safe Doc\n\nfd-bound read should produce normal chunks.\n",
    );

    try {
      const store = createStore();
      const result = store.index({ path: safePath, source: "safe-fd" });
      assert.ok(result.totalChunks > 0, "fd-bound read indexed content");
      assert.equal(result.label, "safe-fd");
      store.close();
    } finally {
      try { fsSync.unlinkSync(safePath); } catch { /* ignore */ }
    }
  });
});
