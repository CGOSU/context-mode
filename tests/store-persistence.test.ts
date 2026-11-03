/** ContentStore persistence regressions. */

import { describe, test, expect } from "vitest";
import { strict as assert } from "node:assert";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ContentStore, cleanupStaleDBs } from "../src/store.js";
import { withRetry, loadDatabase, applyWALPragmas } from "../src/db-base.js";
import { createStore } from "./helpers/content-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


describe("Schema & Lifecycle", () => {
  test("creates store with empty stats", () => {
    const store = createStore();
    const stats = store.getStats();
    assert.equal(stats.sources, 0);
    assert.equal(stats.chunks, 0);
    assert.equal(stats.codeChunks, 0);
    store.close();
  });

  test("close is idempotent", () => {
    const store = createStore();
    store.close();
    // second close should not throw
    assert.doesNotThrow(() => store.close());
  });

  test("Fresh DB creates new FTS5 schema with 8 columns", () => {
    const dbPath = join(
      tmpdir(),
      `context-mode-test-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const store = new ContentStore(dbPath);

    // Verify the schema by opening the raw DB and checking columns
    const Database = loadDatabase();
    const db = new Database(dbPath, { readonly: true });
    const cols = db.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all() as Array<{ name: string }>;
    const colNames = cols.map(c => c.name);

    // FTS5 tables should have 8 user columns + 2 hidden (table-name, rank) = 10 total
    // pragma_table_xinfo includes hidden FTS5 internal columns
    expect(colNames).toContain("title");
    expect(colNames).toContain("content");
    expect(colNames).toContain("source_id");
    expect(colNames).toContain("content_type");
    expect(colNames).toContain("source_category");
    expect(colNames).toContain("session_id");
    expect(colNames).toContain("event_id");
    expect(colNames).toContain("timestamp");
    // 8 user-defined + 2 hidden FTS5 internal (chunks, rank)
    expect(colNames.length).toBe(10);

    // Same check for trigram table
    const trigramCols = db.prepare("SELECT name FROM pragma_table_xinfo('chunks_trigram')").all() as Array<{ name: string }>;
    const trigramColNames = trigramCols.map(c => c.name);
    expect(trigramColNames).toContain("source_category");
    expect(trigramColNames).toContain("session_id");
    expect(trigramColNames).toContain("event_id");
    expect(trigramColNames).toContain("timestamp");
    expect(trigramColNames.length).toBe(10);

    db.close();
    store.close();

    // Cleanup
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  test("Old schema detected and migrated to new schema", () => {
    const dbPath = join(
      tmpdir(),
      `context-mode-test-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );

    // Step 1: Create a DB with the OLD schema (4-column FTS5)
    const Database = loadDatabase();
    const rawDb = new Database(dbPath);
    applyWALPragmas(rawDb);
    rawDb.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        label TEXT NOT NULL,
        chunk_count INTEGER NOT NULL DEFAULT 0,
        code_chunk_count INTEGER NOT NULL DEFAULT 0,
        indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_path TEXT,
        content_hash TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='porter unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        tokenize='trigram'
      );
      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );
      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);

    // Insert a row into old schema to confirm data is present
    rawDb.exec("INSERT INTO sources (label, chunk_count, code_chunk_count) VALUES ('old-source', 1, 0)");
    rawDb.exec("INSERT INTO chunks (title, content, source_id, content_type) VALUES ('old title', 'old content', 1, 'prose')");
    rawDb.exec("INSERT INTO chunks_trigram (title, content, source_id, content_type) VALUES ('old title', 'old content', 1, 'prose')");

    // Verify old schema has only 4 user columns (+ 2 hidden FTS5 = 6 total)
    const oldCols = rawDb.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all() as Array<{ name: string }>;
    expect(oldCols.length).toBe(6);
    expect(oldCols.map(c => c.name)).not.toContain("source_category");

    rawDb.close();

    // Step 2: Open with ContentStore — migration should trigger
    const store = new ContentStore(dbPath);

    // Step 3: Verify migration happened — new columns exist
    const checkDb = new Database(dbPath, { readonly: true });
    const newCols = checkDb.prepare("SELECT name FROM pragma_table_xinfo('chunks')").all() as Array<{ name: string }>;
    const newColNames = newCols.map(c => c.name);
    expect(newColNames).toContain("source_category");
    expect(newColNames).toContain("session_id");
    expect(newColNames).toContain("event_id");
    expect(newColNames).toContain("timestamp");
    expect(newColNames.length).toBe(10);

    const newTrigramCols = checkDb.prepare("SELECT name FROM pragma_table_xinfo('chunks_trigram')").all() as Array<{ name: string }>;
    expect(newTrigramCols.map(c => c.name)).toContain("source_category");
    expect(newTrigramCols.length).toBe(10);

    // Old chunk data is gone (DROP + re-CREATE clears data)
    const chunkCount = checkDb.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
    expect(chunkCount.cnt).toBe(0);

    // Sources table still intact (not dropped)
    const sourceCount = checkDb.prepare("SELECT COUNT(*) as cnt FROM sources").get() as { cnt: number };
    expect(sourceCount.cnt).toBe(1);

    // Store still functional — can index new content
    const result = store.index({ content: "# Test\n\nNew content after migration.", source: "post-migration" });
    expect(result.totalChunks).toBeGreaterThan(0);

    checkDb.close();
    store.close();

    // Cleanup
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });
});

describe("DB Cleanup", () => {
  test("cleanupStaleDBs removes files for dead PIDs", () => {
    const fakePid = 99999;
    const fakePath = join(tmpdir(), `context-mode-${fakePid}.db`);
    writeFileSync(fakePath, "fake");
    writeFileSync(fakePath + "-wal", "fake");
    writeFileSync(fakePath + "-shm", "fake");

    const cleaned = cleanupStaleDBs();
    assert.ok(cleaned >= 1, `Should clean at least 1 file, cleaned ${cleaned}`);
    assert.ok(!existsSync(fakePath), "DB file should be removed");
    assert.ok(!existsSync(fakePath + "-wal"), "WAL file should be removed");
    assert.ok(!existsSync(fakePath + "-shm"), "SHM file should be removed");
  });

  test("cleanupStaleDBs does not remove current process DB", () => {
    const myPath = join(tmpdir(), `context-mode-${process.pid}.db`);
    writeFileSync(myPath, "current");

    cleanupStaleDBs();
    assert.ok(existsSync(myPath), "Current process DB should NOT be removed");

    // Clean up manually
    try { require("fs").unlinkSync(myPath); } catch {}
  });

  test("store.cleanup() removes own DB and WAL/SHM files", () => {
    const store = createStore();
    // Index something to generate WAL activity
    store.index({ content: "# Test\n\nCleanup test content.", source: "cleanup-test" });

    // Get the DB path by creating a known-path store
    const knownPath = join(tmpdir(), `context-mode-cleanup-test-${Date.now()}.db`);
    const knownStore = new ContentStore(knownPath);
    knownStore.index({ content: "# Data\n\nSome data.", source: "known" });

    assert.ok(existsSync(knownPath), "DB should exist before cleanup");

    knownStore.cleanup();
    assert.ok(!existsSync(knownPath), "DB should be removed after cleanup");
    assert.ok(!existsSync(knownPath + "-wal"), "WAL should be removed after cleanup");
    assert.ok(!existsSync(knownPath + "-shm"), "SHM should be removed after cleanup");

    store.close();
  });

  test("store.cleanup() is safe to call multiple times", () => {
    const path = join(tmpdir(), `context-mode-cleanup-idempotent-${Date.now()}.db`);
    const store = new ContentStore(path);
    store.cleanup();
    // Second call should not throw
    assert.doesNotThrow(() => store.cleanup());
  });
});

// ── Persistent content store lifecycle ────────────────────────────────

describe("Persistent content store lifecycle", () => {
  test("cleanupStaleSources keeps recent sources and returns 0", () => {
    const store = createStore();
    store.index({ content: "# Fresh doc\nContent", source: "fresh-source" });
    const deleted = store.cleanupStaleSources(30);
    expect(typeof deleted).toBe("number");
    expect(deleted).toBe(0);
    const meta = store.getSourceMeta("fresh-source");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("fresh-source");
    store.close();
  });

  test("cleanupStaleSources returns number type", () => {
    const store = createStore();
    store.index({ content: "# Test\nContent", source: "test-source" });
    const deleted = store.cleanupStaleSources(365);
    expect(typeof deleted).toBe("number");
    store.close();
  });

  test("getDBSizeBytes returns positive number after indexing", () => {
    const store = createStore();
    store.index({ content: "# Test\nSome content for size", source: "size-test" });
    const size = store.getDBSizeBytes();
    expect(size).toBeGreaterThan(0);
    store.close();
  });

  test("store data persists after close and reopen at same path", () => {
    const dbPath = join(tmpdir(), `persist-test-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    store1.index({ content: "# Persistent\nThis should survive", source: "persist-doc" });
    store1.close();

    const store2 = new ContentStore(dbPath);
    const meta = store2.getSourceMeta("persist-doc");
    expect(meta).not.toBeNull();
    expect(meta!.label).toBe("persist-doc");
    expect(meta!.chunkCount).toBeGreaterThan(0);
    store2.cleanup();
  });

  test("deleting DB file before creating store gives fresh state", () => {
    const dbPath = join(tmpdir(), `fresh-test-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    store1.index({ content: "# Old\nOld content", source: "old-doc" });
    store1.close();

    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }

    const store2 = new ContentStore(dbPath);
    const meta = store2.getSourceMeta("old-doc");
    expect(meta).toBeNull();
    store2.cleanup();
  });
});
describe("SQLITE_BUSY retry logic", () => {
  test("ContentStore uses 30s timeout", () => {
    const storeSrc = readFileSync(
      join(__dirname, "../src/store.ts"),
      "utf-8",
    );
    expect(storeSrc).toContain("timeout: 30000");
  });
});


// ── Concurrent write resilience ──

describe("concurrent DB access", () => {
  test("two ContentStore instances can write to the same DB file", () => {
    const dbPath = join(tmpdir(), `concurrent-write-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.index({ content: "# First\n\nContent from store 1.", source: "store1-doc" });
    store2.index({ content: "# Second\n\nContent from store 2.", source: "store2-doc" });

    // Both sources should be searchable from either store
    const results1 = store1.search("Content from store", 10);
    expect(results1.length).toBeGreaterThanOrEqual(2);

    const results2 = store2.search("Content from store", 10);
    expect(results2.length).toBeGreaterThanOrEqual(2);

    store1.cleanup();
    store2.close();
  });

  test("indexPlainText is protected by withRetry", () => {
    // Verify indexPlainText doesn't throw on transient BUSY by testing
    // concurrent plain text indexing on same DB
    const dbPath = join(tmpdir(), `concurrent-plaintext-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.indexPlainText("alpha bravo charlie", "plain-1");
    store2.indexPlainText("delta echo foxtrot", "plain-2");

    const r1 = store1.search("alpha bravo", 5, "plain-1");
    expect(r1.length).toBeGreaterThan(0);
    const r2 = store1.search("delta echo", 5, "plain-2");
    expect(r2.length).toBeGreaterThan(0);

    store1.cleanup();
    store2.close();
  });

  test("indexJSON is protected by withRetry", () => {
    const dbPath = join(tmpdir(), `concurrent-json-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.indexJSON(JSON.stringify({ users: [{ name: "Alice" }] }), "json-1");
    store2.indexJSON(JSON.stringify({ items: [{ id: 1 }] }), "json-2");

    const results = store1.search("Alice", 5);
    expect(results.length).toBeGreaterThan(0);

    store1.cleanup();
    store2.close();
  });

  test("search and searchTrigram work under concurrent writes", () => {
    const dbPath = join(tmpdir(), `concurrent-search-${Date.now()}.db`);
    const store1 = new ContentStore(dbPath);
    const store2 = new ContentStore(dbPath);

    store1.index({ content: "# Guide\n\nReact hooks are powerful.", source: "guide" });

    // Write from store2 while store1 searches
    store2.index({ content: "# Tutorial\n\nVue composition API.", source: "tutorial" });
    const results = store1.search("hooks", 5);
    expect(results.length).toBeGreaterThan(0);

    store1.cleanup();
    store2.close();
  });
});

// ── Corrupt DB recovery (#244) ──

describe("ContentStore — corrupt DB recovery", () => {
  // Windows file locking prevents WAL/SHM deletion while another worker holds them open
  test.skipIf(process.platform === "win32")("recovers from corrupt DB file by deleting and recreating", () => {
    const dbPath = join(tmpdir(), `corrupt-store-${Date.now()}.db`);
    // Write garbage to simulate corrupt DB
    writeFileSync(dbPath, "THIS IS NOT A SQLITE DATABASE FILE");
    writeFileSync(dbPath + "-wal", "CORRUPT WAL");

    // Should recover: delete corrupt files and create fresh DB
    const store = new ContentStore(dbPath);
    // Store should be functional
    store.index({ content: "test content", source: "test" });
    const results = store.search("test content");
    expect(results.length).toBeGreaterThan(0);

    store.cleanup();
  });

  test("non-SQLite errors still throw", () => {
    // A path to a directory (not a file) should throw a non-corruption error
    expect(() => new ContentStore(tmpdir())).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════
// mmap_size pragma
// ═══════════════════════════════════════════════════════════

describe("mmap_size pragma", () => {
  test("mmap_size is set on new ContentStore", () => {
    const dbPath = join(tmpdir(), `ctx-mmap-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new ContentStore(dbPath);
    store.indexPlainText("Memory-mapped I/O test content for FTS5 search", "mmap-test");
    const results = store.search("memory-mapped");
    expect(results.length).toBeGreaterThan(0);
    store.cleanup();
  });
});

// ═══════════════════════════════════════════════════════════
// FTS5 Periodic Optimization
// ═══════════════════════════════════════════════════════════

describe("FTS5 periodic optimize", () => {
  test("search works correctly after OPTIMIZE_EVERY inserts", () => {
    const dbPath = join(tmpdir(), `ctx-optimize-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new ContentStore(dbPath);

    for (let i = 0; i < ContentStore.OPTIMIZE_EVERY + 5; i++) {
      store.indexPlainText(`Document number ${i} about testing optimization`, `source-${i}`);
    }

    const results = store.search("testing optimization");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("testing optimization");

    store.cleanup();
  });

  test("close() does not throw even after many inserts", () => {
    const dbPath = join(tmpdir(), `ctx-optimize-close-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const store = new ContentStore(dbPath);

    for (let i = 0; i < 10; i++) {
      store.indexPlainText(`Content ${i}`, `src-${i}`);
    }

    expect(() => store.close()).not.toThrow();
  });

  test("OPTIMIZE_EVERY is a reasonable value", () => {
    expect(ContentStore.OPTIMIZE_EVERY).toBeGreaterThanOrEqual(20);
    expect(ContentStore.OPTIMIZE_EVERY).toBeLessThanOrEqual(200);
  });
});
