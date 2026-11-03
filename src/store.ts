/**
 * ContentStore — FTS5 BM25-based knowledge base for context-mode.
 *
 * Chunks markdown content by headings (keeping code blocks intact),
 * stores in SQLite FTS5, and retrieves via BM25-ranked search.
 *
 * Use for documentation, API references, and any content where
 * you need EXACT text later — not summaries.
 */

import type { Database as DatabaseInstance } from "better-sqlite3";
import { loadDatabase, applyWALPragmas, closeDB, cleanOrphanedWALFiles, withRetry, deleteDBFiles, isSQLiteCorruptionError } from "./db-base.js";
import type { PreparedStatement } from "./db-base.js";
import { readFileSync, readdirSync, unlinkSync, existsSync, statSync, openSync, fstatSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkDirectoryDetailed, type WalkOptions } from "./store-directory.js";

import { chunkMarkdown, chunkPlainText, walkJSON, MAX_CHUNK_BYTES, type Chunk } from "./store-chunks.js";
import { STOPWORDS, sanitizeQuery, sanitizeTrigramQuery, levenshtein, maxEditDistance, applyProximityReranking, reciprocalRankFusion, rankDistinctiveTerms } from "./store-search.js";
export { sanitizeQuery, sanitizeTrigramQuery } from "./store-search.js";

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

type SourceMatchMode = "like" | "exact";

type SearchRow = {
  title: string;
  content: string;
  content_type: string;
  timestamp: string | null;
  label: string;
  rank: number;
  highlighted: string;
  /** Attribution session_id (empty string for legacy unattributed chunks). */
  session_id: string;
};

import type { IndexResult, SearchResult, StoreStats } from "./types.js";
export type { IndexResult, SearchResult, StoreStats } from "./types.js";

// ─────────────────────────────────────────────────────────
// ContentStore
// ─────────────────────────────────────────────────────────

/**
 * Remove stale DB files from previous sessions whose processes no longer exist.
 */
export function cleanupStaleDBs(): number {
  const dir = tmpdir();
  let cleaned = 0;
  try {
    const files = readdirSync(dir);
    for (const file of files) {
      const match = file.match(/^context-mode-(\d+)\.db$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      if (pid === process.pid) continue;
      try {
        process.kill(pid, 0);
      } catch {
        const base = join(dir, file);
        for (const suffix of ["", "-wal", "-shm"]) {
          try { unlinkSync(base + suffix); } catch { /* ignore */ }
        }
        cleaned++;
      }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

/**
 * Check if a PID is still alive (not a zombie holding a WAL lock).
 * Returns true if the process exists, false if it's dead.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up stale per-project content store DBs older than maxAgeDays.
 * Scans the given directory for *.db files and checks mtime.
 * Also detects zombie processes holding WAL locks — if a WAL file exists
 * but the owning PID is dead, the DB files are cleaned up regardless of age.
 */
export function cleanupStaleContentDBs(contentDir: string, maxAgeDays: number): number {
  let cleaned = 0;
  try {
    if (!existsSync(contentDir)) return 0;
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    const files = readdirSync(contentDir).filter(f => f.endsWith(".db"));
    for (const file of files) {
      try {
        const filePath = join(contentDir, file);
        const mtime = statSync(filePath).mtimeMs;
        let shouldClean = mtime < cutoff;

        // Detect zombie processes holding WAL locks:
        // If a WAL file exists, try to read the WAL header to extract the PID.
        // WAL files from dead processes can block new connections.
        if (!shouldClean) {
          const walPath = filePath + "-wal";
          if (existsSync(walPath)) {
            try {
              const walStat = statSync(walPath);
              // If WAL file is non-empty and DB hasn't been modified in >1 hour,
              // the owning process may be dead — check via mtime staleness
              if (walStat.size > 0 && (Date.now() - walStat.mtimeMs) > 3600_000) {
                shouldClean = true;
              }
            } catch { /* ignore WAL check errors */ }
          }
        }

        if (shouldClean) {
          for (const suffix of ["", "-wal", "-shm"]) {
            try { unlinkSync(filePath + suffix); } catch { /* ignore */ }
          }
          cleaned++;
        }
      } catch { /* ignore per-file errors */ }
    }
  } catch { /* ignore readdir errors */ }
  return cleaned;
}

export class ContentStore {
  #db: DatabaseInstance;
  #dbPath: string;
  // Optional deny-policy callback. When set (by server.ts at startup),
  // #refreshStaleSources consults it before re-reading file_path during
  // auto-refresh. This catches policy edits between initial indexing and
  // a later search: a file that was allowed at index time may have been
  // added to the Read deny list afterwards. Without this hook, refresh
  // would re-read and re-expose the file. See #442 round-3.
  #denyChecker?: (filePath: string) => boolean;

  // ── Cached Prepared Statements ──
  // Prepared once at construction, reused on every call to avoid
  // re-compiling SQL on each invocation.

  // Write path
  #stmtInsertSourceEmpty!: PreparedStatement;
  #stmtInsertSource!: PreparedStatement;
  #stmtInsertChunk!: PreparedStatement;
  #stmtInsertChunkTrigram!: PreparedStatement;
  #stmtInsertVocab!: PreparedStatement;

  // Dedup path (delete previous source with same label before re-indexing)
  #stmtDeleteChunksByLabel!: PreparedStatement;
  #stmtDeleteChunksTrigramByLabel!: PreparedStatement;
  #stmtDeleteSourcesByLabel!: PreparedStatement;

  // Search path (hot)
  #stmtSearchPorter!: PreparedStatement;
  #stmtSearchPorterFiltered!: PreparedStatement;
  #stmtSearchPorterExact!: PreparedStatement;
  #stmtSearchTrigram!: PreparedStatement;
  #stmtSearchTrigramFiltered!: PreparedStatement;
  #stmtSearchTrigramExact!: PreparedStatement;
  #stmtFuzzyVocab!: PreparedStatement;
  #stmtSearchPorterContentType!: PreparedStatement;
  #stmtSearchPorterFilteredContentType!: PreparedStatement;
  #stmtSearchPorterExactContentType!: PreparedStatement;
  #stmtSearchTrigramContentType!: PreparedStatement;
  #stmtSearchTrigramFilteredContentType!: PreparedStatement;
  #stmtSearchTrigramExactContentType!: PreparedStatement;

  // Read path
  #stmtListSources!: PreparedStatement;
  #stmtChunksBySource!: PreparedStatement;
  #stmtSourceChunkCount!: PreparedStatement;
  #stmtChunkContent!: PreparedStatement;
  #stmtStats!: PreparedStatement;
  #stmtSourceMeta!: PreparedStatement;

  // Cleanup path
  #stmtCleanupChunks!: PreparedStatement;
  #stmtCleanupChunksTrigram!: PreparedStatement;
  #stmtCleanupSources!: PreparedStatement;

  // FTS5 optimization: track inserts and optimize periodically to defragment
  // the index. FTS5 b-trees fragment over many insert/delete cycles, degrading
  // search performance. SQLite's built-in 'optimize' merges b-tree segments.
  #insertCount = 0;
  static readonly OPTIMIZE_EVERY = 50;

  // Fuzzy correction cache (process-local LRU). fuzzyCorrect() hits the vocab
  // DB and runs levenshtein against every candidate within length tolerance,
  // which is CPU-linear in |candidates|. Repeated queries ("erro", "erro" …)
  // recompute the same answer. The vocabulary table is insert-only, so cache
  // entries only become stale when new words enter — we clear on actual insert.
  #fuzzyCache = new Map<string, string | null>();
  static readonly FUZZY_CACHE_SIZE = 256;

  constructor(dbPath?: string) {
    const Database = loadDatabase();
    this.#dbPath =
      dbPath ?? join(tmpdir(), `context-mode-${process.pid}.db`);
    cleanOrphanedWALFiles(this.#dbPath);
    let db: DatabaseInstance;
    try {
      db = new Database(this.#dbPath, { timeout: 30000 });
      applyWALPragmas(db);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isSQLiteCorruptionError(msg)) {
        deleteDBFiles(this.#dbPath);
        cleanOrphanedWALFiles(this.#dbPath);
        try {
          db = new Database(this.#dbPath, { timeout: 30000 });
          applyWALPragmas(db);
        } catch (retryErr) {
          throw new Error(
            `Failed to create fresh DB after deleting corrupt file: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`
          );
        }
      } else {
        throw err;
      }
    }
    this.#db = db;
    this.#initSchema();
    this.#prepareStatements();
  }

  /** Delete this session's DB files. Call on process exit. */
  cleanup(): void {
    try {
      this.#db.close();
    } catch { /* ignore */ }
    for (const suffix of ["", "-wal", "-shm"]) {
      try { unlinkSync(this.#dbPath + suffix); } catch { /* ignore */ }
    }
  }

  // ── Schema ──

  #initSchema(): void {
    this.#db.exec(`
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
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_trigram USING fts5(
        title,
        content,
        source_id UNINDEXED,
        content_type UNINDEXED,
        source_category UNINDEXED,
        session_id UNINDEXED,
        event_id UNINDEXED,
        timestamp UNINDEXED,
        tokenize='trigram'
      );

      CREATE TABLE IF NOT EXISTS vocabulary (
        word TEXT PRIMARY KEY
      );

      CREATE INDEX IF NOT EXISTS idx_sources_label ON sources(label);
    `);

    // FTS5 schema migration: old schema (4 cols) → new schema (8 cols).
    // FTS5 virtual tables do not support ALTER TABLE ADD COLUMN, so we must
    // DROP + re-CREATE. Detection: check for sentinel column `source_category`
    // via pragma_table_xinfo. Three states:
    //   1. No table          → CREATE above handled it (fresh DB)
    //   2. Old schema (4 cols) → DROP + CREATE new
    //   3. New schema (8 cols) → do nothing
    try {
      const cols = this.#db.prepare(
        "SELECT name FROM pragma_table_xinfo('chunks')"
      ).all() as Array<{ name: string }>;
      const colNames = new Set(cols.map(c => c.name));
      if (cols.length > 0 && !colNames.has("source_category")) {
        // Old schema detected — drop both FTS5 tables and re-create with new columns
        this.#db.exec("DROP TABLE IF EXISTS chunks");
        this.#db.exec("DROP TABLE IF EXISTS chunks_trigram");
        this.#db.exec(`
          CREATE VIRTUAL TABLE chunks USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='porter unicode61'
          );
          CREATE VIRTUAL TABLE chunks_trigram USING fts5(
            title,
            content,
            source_id UNINDEXED,
            content_type UNINDEXED,
            source_category UNINDEXED,
            session_id UNINDEXED,
            event_id UNINDEXED,
            timestamp UNINDEXED,
            tokenize='trigram'
          );
        `);
      }
    } catch { /* pragma_table_xinfo may fail if table doesn't exist yet — safe to ignore */ }

    // Stale detection columns — safe for existing DBs (ALTER is O(1) in SQLite)
    try { this.#db.exec("ALTER TABLE sources ADD COLUMN file_path TEXT"); } catch { /* already exists */ }
    try { this.#db.exec("ALTER TABLE sources ADD COLUMN content_hash TEXT"); } catch { /* already exists */ }
  }

  #prepareStatements(): void {
    // Write path
    this.#stmtInsertSourceEmpty = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, 0, 0, ?, ?)",
    );
    this.#stmtInsertSource = this.#db.prepare(
      "INSERT INTO sources (label, chunk_count, code_chunk_count, file_path, content_hash) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stmtInsertChunk = this.#db.prepare(
      "INSERT INTO chunks (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stmtInsertChunkTrigram = this.#db.prepare(
      "INSERT INTO chunks_trigram (title, content, source_id, content_type, source_category, session_id, event_id, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stmtInsertVocab = this.#db.prepare(
      "INSERT OR IGNORE INTO vocabulary (word) VALUES (?)",
    );

    // Dedup path: delete previous source with same label before re-indexing
    // Prevents stale outputs from accumulating in iterative workflows (build-fix-build)
    this.#stmtDeleteChunksByLabel = this.#db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    this.#stmtDeleteChunksTrigramByLabel = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE label = ?)",
    );
    this.#stmtDeleteSourcesByLabel = this.#db.prepare(
      "DELETE FROM sources WHERE label = ?",
    );

    // Search path (hot)
    this.#stmtSearchPorter = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFiltered = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExact = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigram = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFiltered = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\'
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExact = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Content-type filtered variants
    this.#stmtSearchPorterContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterFilteredContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchPorterExactContentType = this.#db.prepare(`
      SELECT
        chunks.title,
        chunks.content,
        chunks.content_type,
        chunks.timestamp,
        sources.label,
        bm25(chunks, 5.0, 1.0) AS rank,
        highlight(chunks, 1, char(2), char(3)) AS highlighted,
        chunks.session_id
      FROM chunks
      JOIN sources ON sources.id = chunks.source_id
      WHERE chunks MATCH ? AND sources.label = ? AND chunks.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramFilteredContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label LIKE ? ESCAPE '\\' AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);
    this.#stmtSearchTrigramExactContentType = this.#db.prepare(`
      SELECT
        chunks_trigram.title,
        chunks_trigram.content,
        chunks_trigram.content_type,
        chunks_trigram.timestamp,
        sources.label,
        bm25(chunks_trigram, 5.0, 1.0) AS rank,
        highlight(chunks_trigram, 1, char(2), char(3)) AS highlighted,
        chunks_trigram.session_id
      FROM chunks_trigram
      JOIN sources ON sources.id = chunks_trigram.source_id
      WHERE chunks_trigram MATCH ? AND sources.label = ? AND chunks_trigram.content_type = ?
      ORDER BY rank
      LIMIT ?
    `);

    // Fuzzy path
    this.#stmtFuzzyVocab = this.#db.prepare(
      "SELECT word FROM vocabulary WHERE length(word) BETWEEN ? AND ?",
    );

    // Read path
    this.#stmtListSources = this.#db.prepare(
      "SELECT label, chunk_count as chunkCount FROM sources ORDER BY id DESC",
    );
    this.#stmtChunksBySource = this.#db.prepare(
      `SELECT c.title, c.content, c.content_type, s.label
       FROM chunks c
       JOIN sources s ON s.id = c.source_id
       WHERE c.source_id = ?
       ORDER BY c.rowid`,
    );
    this.#stmtSourceChunkCount = this.#db.prepare(
      "SELECT chunk_count FROM sources WHERE id = ?",
    );
    this.#stmtChunkContent = this.#db.prepare(
      "SELECT content FROM chunks WHERE source_id = ?",
    );
    this.#stmtSourceMeta = this.#db.prepare(
      "SELECT label, chunk_count, code_chunk_count, indexed_at, file_path, content_hash FROM sources WHERE label = ?",
    );
    this.#stmtStats = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM sources) AS sources,
        (SELECT COUNT(*) FROM chunks) AS chunks,
        (SELECT COUNT(*) FROM chunks WHERE content_type = 'code') AS codeChunks
    `);

    // Cleanup path — cached to avoid recompiling SQL on each periodic call
    this.#stmtCleanupChunks = this.#db.prepare(
      "DELETE FROM chunks WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    );
    this.#stmtCleanupChunksTrigram = this.#db.prepare(
      "DELETE FROM chunks_trigram WHERE source_id IN (SELECT id FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days'))",
    );
    this.#stmtCleanupSources = this.#db.prepare(
      "DELETE FROM sources WHERE datetime(indexed_at) < datetime('now', '-' || ? || ' days')",
    );
  }

  // ── Deny Policy Hook ──

  /**
   * Register a deny-policy checker. When set, #refreshStaleSources
   * calls it before re-reading any file_path during auto-refresh.
   * Returning `true` causes the source to be skipped (kept in cache,
   * not re-indexed). server.ts wires this to the Read deny patterns.
   */
  setDenyChecker(fn: ((filePath: string) => boolean) | undefined): void {
    this.#denyChecker = fn;
  }

  // ── Index ──

  index(options: {
    content?: string;
    path?: string;
    source?: string;
    /**
     * Optional FK metadata recorded on each indexed chunk so per-session
     * honest-savings stats can join chunks → session_events. When omitted,
     * chunks fall back to empty-string columns (legacy behaviour).
     */
    attribution?: { sessionId?: string; eventId?: string };
  }): IndexResult {
    const { content, path, source, attribution } = options;

    // Treat empty string as "no content" so an empty `content` paired with a
    // valid `path` falls back to reading the file. Some MCP clients
    // materialize optional string fields as `""` and the previous
    // `content ?? readFileSync(path)` kept the empty string, indexing 0
    // chunks. See issue #350.
    const hasContent = typeof content === "string" && content.length > 0;

    if (!hasContent && !path) {
      throw new Error("Either content or path must be provided");
    }

    // Read file via fd to close the TOCTOU window between the security
    // gate (security.ts evaluateFilePath calls realpathSync) and the read
    // here. Lexical re-read by path string allowed an attacker to swap a
    // symlink to a denied target (e.g. ~/.ssh/id_rsa) AFTER gate passed.
    // openSync + fstat + readFileSync(fd) binds the read to the inode
    // captured at gate-time. fstat also rejects non-regular files
    // (directories, character devices) which would otherwise read as ""
    // or throw inconsistently. See #442 round-3.
    let text: string;
    if (hasContent) {
      text = content!;
    } else {
      const fd = openSync(path!, "r");
      try {
        const st = fstatSync(fd);
        if (!st.isFile()) {
          throw new Error(`refusing to index ${path}: not a regular file`);
        }
        text = readFileSync(fd, "utf-8");
      } finally {
        closeSync(fd);
      }
    }
    const label = source ?? path ?? "untitled";
    const chunks = chunkMarkdown(text);

    // Stale detection: store file_path + SHA-256 for file-backed sources
    const filePath = path ?? undefined;
    const contentHash = filePath ? createHash("sha256").update(text).digest("hex") : undefined;

    return withRetry(() => this.#insertChunks(chunks, label, text, filePath, contentHash, attribution));
  }

  // ── Index Directory (#687) ──

  /**
   * Index every file under a directory by walking it with `walkDirectory` and
   * delegating each discovered file to `this.index({ path })`. The per-file
   * `openSync + fstatSync.isFile()` security gate at line ~845 stays active
   * for every file — directory support never bypasses the TOCTOU defense
   * from #442 round-3.
   *
   * Reported by @matiasduartee in #687.
   */
  indexDirectory(opts: {
    path: string;
    source?: string;
    attribution?: { sessionId?: string; eventId?: string };
    /** Optional per-file deny check — runs INSIDE the walk loop so a denied
     *  file does not even open a fd. Returns true to deny. */
    perFileDeny?: (absPath: string) => boolean;
  } & WalkOptions): {
    filesIndexed: number;
    totalChunks: number;
    capped: boolean;
    totalSeen: number;
    denied: number;
    failed: number;
    label: string;
  } {
    const { path: rootPath, source, attribution, perFileDeny, ...walkOpts } = opts;
    const walked = walkDirectoryDetailed(rootPath, walkOpts);

    let filesIndexed = 0;
    let totalChunks = 0;
    let denied = 0;
    let failed = 0;

    for (const file of walked.files) {
      if (perFileDeny && perFileDeny(file)) {
        denied++;
        continue;
      }
      try {
        // Per-file source label so ctx_search(source: "<file>") still works.
        const fileSource = source ? `${source}:${file}` : file;
        const r = this.index({ path: file, source: fileSource, attribution });
        filesIndexed++;
        totalChunks += r.totalChunks;
      } catch {
        // Per-file failure (e.g. fd-bound fstat rejection of a non-regular
        // file that races between walk and read) — count + continue.
        failed++;
      }
    }

    return {
      filesIndexed,
      totalChunks,
      capped: walked.capped,
      totalSeen: walked.totalSeen,
      denied,
      failed,
      label: source ?? rootPath,
    };
  }

  // ── Index Plain Text ──

  /**
   * Index plain-text output (logs, build output, test results) by splitting
   * into fixed-size line groups. Unlike markdown indexing, this does not
   * look for headings — it chunks by line count with overlap.
   */
  indexPlainText(
    content: string,
    source: string,
    linesPerChunk: number = 20,
    attribution?: { sessionId?: string; eventId?: string },
    maxChunkBytes: number = MAX_CHUNK_BYTES,
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.#insertChunks([], source, "", undefined, undefined, attribution);
    }

    const chunks = chunkPlainText(content, linesPerChunk, maxChunkBytes);

    return withRetry(() => this.#insertChunks(
      chunks.map((c) => ({ ...c, hasCode: false })),
      source,
      content,
      undefined,
      undefined,
      attribution,
    ));
  }

  // ── Index JSON ──

  /**
   * Index JSON content by walking the object tree and using key paths
   * as chunk titles (analogous to heading hierarchy in markdown). Objects
   * recurse by key; arrays batch items by size.
   *
   * Falls back to `indexPlainText` if the content is not valid JSON.
   */
  indexJSON(
    content: string,
    source: string,
    maxChunkBytes: number = MAX_CHUNK_BYTES,
    attribution?: { sessionId?: string; eventId?: string },
  ): IndexResult {
    if (!content || content.trim().length === 0) {
      return this.indexPlainText("", source, undefined, attribution, maxChunkBytes);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      return this.indexPlainText(content, source, undefined, attribution, maxChunkBytes);
    }

    const chunks: Chunk[] = [];
    walkJSON(parsed, [], chunks, maxChunkBytes);

    if (chunks.length === 0) {
      return this.indexPlainText(content, source, undefined, attribution, maxChunkBytes);
    }

    return withRetry(() => this.#insertChunks(chunks, source, content, undefined, undefined, attribution));
  }

  // ── Shared DB Insertion ──

  /**
   * Shared DB insertion logic for all index methods. Inserts chunks
   * into both FTS5 tables within a transaction and extracts vocabulary.
   * Uses cached prepared statements from #prepareStatements().
   */
  #insertChunks(
    chunks: Chunk[],
    label: string,
    text: string,
    filePath?: string,
    contentHash?: string,
    attribution?: { sessionId?: string; eventId?: string },
  ): IndexResult {
    const codeChunks = chunks.filter((c) => c.hasCode).length;
    // FK columns on chunks. Empty-string fallback preserves the FTS5-friendly
    // "not-null but unattributed" sentinel used by legacy rows.
    const sessionIdCol = attribution?.sessionId ?? "";
    const eventIdCol = attribution?.eventId ?? "";

    // Atomic dedup + insert: delete previous source with same label,
    // then insert new content — all within a single transaction.
    // Prevents stale results in iterative workflows. (See: GitHub issue #67)
    const transaction = this.#db.transaction(() => {
      this.#stmtDeleteChunksByLabel.run(label);
      this.#stmtDeleteChunksTrigramByLabel.run(label);
      this.#stmtDeleteSourcesByLabel.run(label);

      if (chunks.length === 0) {
        const info = this.#stmtInsertSourceEmpty.run(label, filePath ?? null, contentHash ?? null);
        return Number(info.lastInsertRowid);
      }

      const info = this.#stmtInsertSource.run(label, chunks.length, codeChunks, filePath ?? null, contentHash ?? null);
      const sourceId = Number(info.lastInsertRowid);

      const now = new Date().toISOString();
      for (const chunk of chunks) {
        const ct = chunk.hasCode ? "code" : "prose";
        this.#stmtInsertChunk.run(chunk.title, chunk.content, sourceId, ct, null, sessionIdCol, eventIdCol, now);
        this.#stmtInsertChunkTrigram.run(chunk.title, chunk.content, sourceId, ct, null, sessionIdCol, eventIdCol, now);
      }

      return sourceId;
    });

    const sourceId = transaction();
    if (text) this.#extractAndStoreVocabulary(text);

    // Periodically optimize FTS5 indexes to merge b-tree segments.
    // Fragmentation accumulates over insert/delete cycles (dedup re-indexes
    // every source on update). The 'optimize' command merges segments into
    // a single b-tree, improving search latency for long-running sessions.
    this.#insertCount++;
    if (this.#insertCount % ContentStore.OPTIMIZE_EVERY === 0) {
      this.#optimizeFTS();
    }

    return {
      sourceId,
      label,
      totalChunks: chunks.length,
      codeChunks,
    };
  }

  // ── Search ──

  #mapSearchRows(rows: SearchRow[]): SearchResult[] {
    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: r.rank,
      contentType: r.content_type as "code" | "prose",
      highlighted: r.highlighted,
      timestamp: r.timestamp ?? undefined,
      sessionId: r.session_id ?? "",
    }));
  }

  #sourceFilterParam(source: string, sourceMatchMode: SourceMatchMode): string {
    if (sourceMatchMode === "exact") return source;
    // Escape SQLite LIKE metacharacters so user-supplied source labels
    // containing `_`, `%`, or `\` are matched literally rather than as
    // wildcards. Backslash must be replaced first (otherwise subsequent
    // escapes would themselves be re-escaped). Paired with `ESCAPE '\'`
    // in the four prepared LIKE statements (#stmtSearchPorter*,
    // #stmtSearchTrigram*). Regression: #646.
    const escaped = source
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    return `%${escaped}%`;
  }

  search(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeQuery(query, mode);

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExactContentType
        : this.#stmtSearchPorterFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchPorterExact
        : this.#stmtSearchPorterFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchPorterContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchPorter;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Trigram Search (Layer 2) ──

  searchTrigram(
    query: string,
    limit: number = 3,
    source?: string,
    mode: "AND" | "OR" = "AND",
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const sanitized = sanitizeTrigramQuery(query, mode);
    if (!sanitized) return [];

    let stmt: PreparedStatement;
    let params: unknown[];

    if (source && contentType) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExactContentType
        : this.#stmtSearchTrigramFilteredContentType;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), contentType, limit];
    } else if (source) {
      stmt = sourceMatchMode === "exact"
        ? this.#stmtSearchTrigramExact
        : this.#stmtSearchTrigramFiltered;
      params = [sanitized, this.#sourceFilterParam(source, sourceMatchMode), limit];
    } else if (contentType) {
      stmt = this.#stmtSearchTrigramContentType;
      params = [sanitized, contentType, limit];
    } else {
      stmt = this.#stmtSearchTrigram;
      params = [sanitized, limit];
    }

    return withRetry(() => this.#mapSearchRows(stmt.all(...params) as SearchRow[]));
  }

  // ── Fuzzy Correction (Layer 3) ──

  fuzzyCorrect(query: string): string | null {
    const word = query.toLowerCase().trim();
    if (word.length < 3) return null;

    // Cache hit: promote to tail (Map preserves insertion order → LRU).
    if (this.#fuzzyCache.has(word)) {
      const cached = this.#fuzzyCache.get(word) ?? null;
      this.#fuzzyCache.delete(word);
      this.#fuzzyCache.set(word, cached);
      return cached;
    }

    const maxDist = maxEditDistance(word.length);

    const candidates = this.#stmtFuzzyVocab.all(
      word.length - maxDist,
      word.length + maxDist,
    ) as Array<{ word: string }>;

    let bestWord: string | null = null;
    let bestDist = maxDist + 1;
    let exactMatch = false;

    for (const { word: candidate } of candidates) {
      if (candidate === word) {
        exactMatch = true;
        break;
      }
      const dist = levenshtein(word, candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    const result = exactMatch ? null : bestDist <= maxDist ? bestWord : null;

    // Evict the oldest entry before insert if we hit the size cap.
    if (this.#fuzzyCache.size >= ContentStore.FUZZY_CACHE_SIZE) {
      const oldestKey = this.#fuzzyCache.keys().next().value;
      if (oldestKey !== undefined) this.#fuzzyCache.delete(oldestKey);
    }
    this.#fuzzyCache.set(word, result);

    return result;
  }

  // ── Reciprocal Rank Fusion (Cormack et al. 2009) ──

  #rrfSearch(
    query: string,
    limit: number,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
  ): SearchResult[] {
    const fetchLimit = Math.max(limit * 2, 10);

    const porterResults = this.search(query, fetchLimit, source, "OR", contentType, sourceMatchMode);
    const trigramResults = this.searchTrigram(query, fetchLimit, source, "OR", contentType, sourceMatchMode);

    return reciprocalRankFusion(porterResults, trigramResults, limit);
  }

  // ── Unified Fallback Search ──

  /**
   * Share one file refresh across a synchronous request's searches. The callback
   * receives the normal search contract, not a persistent skip-refresh flag.
   * Calls made after it returns (or throws) resume normal freshness checks.
   */
  withSearchBatch<T>(run: (search: ContentStore["searchWithFallback"]) => T): T {
    let active = true;
    let refreshed = false;
    const search: ContentStore["searchWithFallback"] = (...args) => {
      if (!active) return this.searchWithFallback(...args);
      if (!refreshed) {
        this.#refreshStaleSources();
        refreshed = true;
      }
      return this.#searchRefreshed(...args);
    };
    try {
      return run(search);
    } finally {
      active = false;
    }
  }

  searchWithFallback(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
    sessionIdAllowSet?: Set<string>,
  ): SearchResult[] {
    this.#refreshStaleSources();
    return this.#searchRefreshed(query, limit, source, contentType, sourceMatchMode, sessionIdAllowSet);
  }

  #searchRefreshed(
    query: string,
    limit: number = 3,
    source?: string,
    contentType?: "code" | "prose",
    sourceMatchMode: SourceMatchMode = "like",
    sessionIdAllowSet?: Set<string>,
  ): SearchResult[] {
    // When a session-id allow-set is in play (issue #737 project filter),
    // fetch a larger candidate pool from the FTS5 layers so the post-filter
    // can still deliver `limit` matches even if many candidates are excluded.
    // The cap is bounded — even at the largest installs the chunk count
    // dwarfs `limit * 8`, and the surplus is dropped on the post-filter.
    // Recall beyond the output budget so title/proximity reranking can rescue
    // candidates below the initial RRF cutoff. Bound the extra work, without
    // reducing an explicitly larger output limit or the project-filter pool.
    const candidateLimit = Math.max(limit, Math.min(100, Math.max(20, limit * 4)));
    const fetchLimit = sessionIdAllowSet ? Math.max(candidateLimit, limit * 8, 40) : candidateLimit;
    const sessionFilter = this.#makeSessionFilter(sessionIdAllowSet);

    // Step 1: RRF fusion (porter OR + trigram OR → merge)
    const rrfResults = this.#rrfSearch(query, fetchLimit, source, contentType, sourceMatchMode);
    const rrfFiltered = sessionFilter ? rrfResults.filter(sessionFilter) : rrfResults;
    if (rrfFiltered.length > 0) {
      const reranked = applyProximityReranking(rrfFiltered, query).slice(0, limit);
      return reranked.map((r) => ({ ...r, matchLayer: "rrf" as const }));
    }

    // Step 2: Fuzzy correction → RRF re-run
    // Skip stopwords — they'll be filtered by sanitizeQuery anyway, and each
    // fuzzyCorrect call hits the vocab DB + runs levenshtein comparisons.
    const words = query
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const original = words.join(" ");
    const correctedWords = words.map((w) => this.fuzzyCorrect(w) ?? w);
    const correctedQuery = correctedWords.join(" ");

    if (correctedQuery !== original) {
      const fuzzyResults = this.#rrfSearch(correctedQuery, fetchLimit, source, contentType, sourceMatchMode);
      const fuzzyFiltered = sessionFilter ? fuzzyResults.filter(sessionFilter) : fuzzyResults;
      if (fuzzyFiltered.length > 0) {
        const reranked = applyProximityReranking(fuzzyFiltered, correctedQuery).slice(0, limit);
        return reranked.map((r) => ({ ...r, matchLayer: "rrf-fuzzy" as const }));
      }
    }

    return [];
  }

  /**
   * Build the session-id post-filter for the FTS5 candidate pool. Legacy
   * chunks indexed before per-session attribution carry `session_id=''` and
   * stay visible across projects so user-indexed content remains reachable
   * after opting into the shared-DB mode (#737).
   */
  #makeSessionFilter(
    allowSet: Set<string> | undefined,
  ): ((r: SearchResult) => boolean) | null {
    if (!allowSet) return null;
    return (r: SearchResult) => {
      const sid = r.sessionId ?? "";
      return sid === "" || allowSet.has(sid);
    };
  }

  /** Number of sources auto-refreshed in the last searchWithFallback call. */
  lastRefreshCount = 0;

  /**
   * Check all file-backed sources for staleness and auto re-index changed files.
   * Uses mtime as a fast gate — only computes SHA-256 when mtime has advanced
   * past indexed_at. Gracefully skips deleted files and non-file sources.
   */
  #refreshStaleSources(): void {
    this.lastRefreshCount = 0;
    const sources = this.#db.prepare(
      "SELECT label, file_path, content_hash, indexed_at FROM sources WHERE file_path IS NOT NULL",
    ).all() as Array<{ label: string; file_path: string; content_hash: string; indexed_at: string }>;

    for (const src of sources) {
      try {
        if (!existsSync(src.file_path)) continue; // file deleted — keep cached results
        // Re-check deny policy before re-reading. The Read deny list may
        // have been edited after this source was originally indexed; a
        // file that was allowed then may now be denied. Without this
        // gate, refresh would happily re-read and re-expose it. #442 r3.
        if (this.#denyChecker && this.#denyChecker(src.file_path)) continue;
        const mtime = statSync(src.file_path).mtime;
        const indexedAt = new Date(src.indexed_at + "Z");
        if (mtime <= indexedAt) continue; // file unchanged — fast path

        // mtime advanced — fd-bound read for hash + indexing in one go.
        // Open once, fstat, read from fd. Closes the swap-mid-flight
        // window between hash read and re-index. #442 round-3.
        const fd = openSync(src.file_path, "r");
        let newContent: string;
        try {
          const st = fstatSync(fd);
          if (!st.isFile()) continue; // skip non-regular targets
          newContent = readFileSync(fd, "utf-8");
        } finally {
          closeSync(fd);
        }
        const newHash = createHash("sha256").update(newContent).digest("hex");
        if (newHash === src.content_hash) continue; // content identical — skip

        // File genuinely changed — re-index using already-read content
        // (avoids a second open/read race) but preserve file_path/hash
        // by going through index() which stores them. Since we pass
        // content, index() does NOT re-read; the bytes hashed above
        // are exactly the bytes indexed.
        this.index({ content: newContent, path: src.file_path, source: src.label });
        this.lastRefreshCount++;
      } catch {
        // Graceful degradation — never break search for stale detection
      }
    }
  }

  // ── Sources ──

  getSourceMeta(label: string): { label: string; chunkCount: number; codeChunkCount: number; indexedAt: string; filePath: string | null; contentHash: string | null } | null {
    const row = this.#stmtSourceMeta.get(label) as { label: string; chunk_count: number; code_chunk_count: number; indexed_at: string; file_path: string | null; content_hash: string | null } | undefined;
    if (!row) return null;
    return { label: row.label, chunkCount: row.chunk_count, codeChunkCount: row.code_chunk_count, indexedAt: row.indexed_at, filePath: row.file_path ?? null, contentHash: row.content_hash ?? null };
  }

  listSources(): Array<{ label: string; chunkCount: number }> {
    return this.#stmtListSources.all() as Array<{
      label: string;
      chunkCount: number;
    }>;
  }

  /**
   * Aggregate snapshot of the persistent content store. Returns total
   * chunk count, source count, and the most recent indexed_at timestamp.
   * Used by ctx_stats so callers can see observability state in the same
   * round trip instead of inferring it from snapshot diffs.
   */
  getIndexState(): { totalChunks: number; totalSources: number; lastIndexedAt?: string } {
    const row = (this.#db
      .prepare("SELECT COALESCE(SUM(chunk_count), 0) AS total_chunks, COUNT(*) AS total_sources, MAX(indexed_at) AS last_indexed_at FROM sources")
      .get() as {
        total_chunks: number;
        total_sources: number;
        last_indexed_at: string | null;
      });
    return {
      totalChunks: row.total_chunks ?? 0,
      totalSources: row.total_sources ?? 0,
      lastIndexedAt: row.last_indexed_at ?? undefined,
    };
  }

  /**
   * Get all chunks for a given source by ID — bypasses FTS5 MATCH entirely.
   * Use this for inventory/listing where you need all sections, not search.
   */
  getChunksBySource(sourceId: number): SearchResult[] {
    const rows = this.#stmtChunksBySource.all(sourceId) as Array<{
      title: string;
      content: string;
      content_type: string;
      label: string;
    }>;

    return rows.map((r) => ({
      title: r.title,
      content: r.content,
      source: r.label,
      rank: 0,
      contentType: r.content_type as "code" | "prose",
    }));
  }

  // ── Vocabulary ──

  getDistinctiveTerms(sourceId: number, maxTerms: number = 40): string[] {
    const stats = this.#stmtSourceChunkCount.get(sourceId) as
      | { chunk_count: number }
      | undefined;

    if (!stats || stats.chunk_count < 3) return [];

    const totalChunks = stats.chunk_count;
    // Stream chunks one at a time to avoid loading all content into memory
    // Count document frequency (how many sections contain each word)
    const docFreq = new Map<string, number>();

    for (const row of this.#stmtChunkContent.iterate(sourceId) as Iterable<{ content: string }>) {
      const words = new Set(
        row.content
          .toLowerCase()
          .split(/[^\p{L}\p{N}_-]+/u)
          .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
      );
      for (const word of words) {
        docFreq.set(word, (docFreq.get(word) ?? 0) + 1);
      }
    }

    return rankDistinctiveTerms(docFreq, totalChunks, maxTerms);
  }

  // ── Stats ──

  getStats(): StoreStats {
    const row = this.#stmtStats.get() as {
      sources: number;
      chunks: number;
      codeChunks: number;
    } | undefined;

    return {
      sources: row?.sources ?? 0,
      chunks: row?.chunks ?? 0,
      codeChunks: row?.codeChunks ?? 0,
    };
  }

  // ── Cleanup ──

  /**
   * Delete sources (and their chunks) older than maxAgeDays.
   * Returns count of deleted sources.
   */
  cleanupStaleSources(maxAgeDays: number): number {
    const cleanup = this.#db.transaction((days: number) => {
      this.#stmtCleanupChunks.run(days);
      this.#stmtCleanupChunksTrigram.run(days);
      return this.#stmtCleanupSources.run(days);
    });
    const info = cleanup(maxAgeDays);
    return info.changes;
  }

  /** Get DB file size in bytes. */
  getDBSizeBytes(): number {
    try {
      return statSync(this.#dbPath).size;
    } catch {
      return 0;
    }
  }

  /** Merge FTS5 b-tree segments for both porter and trigram indexes. */
  #optimizeFTS(): void {
    try {
      this.#db.exec("INSERT INTO chunks(chunks) VALUES('optimize')");
      this.#db.exec("INSERT INTO chunks_trigram(chunks_trigram) VALUES('optimize')");
    } catch { /* best effort — don't block indexing */ }
  }

  close(): void {
    this.#optimizeFTS(); // defragment before close
    closeDB(this.#db); // WAL checkpoint before close — important for persistent DBs
  }

  // ── Vocabulary Extraction ──

  #extractAndStoreVocabulary(content: string): void {
    const words = content
      .toLowerCase()
      .split(/[^\p{L}\p{N}_-]+/u)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

    const unique = [...new Set(words)];

    let inserted = 0;
    this.#db.transaction(() => {
      for (const word of unique) {
        const info = this.#stmtInsertVocab.run(word);
        inserted += info.changes;
      }
    })();

    // Invalidate fuzzy cache when new vocab words actually land. INSERT OR
    // IGNORE reports changes=0 for duplicates, so re-indexing identical
    // content does not thrash the cache during iterative workflows.
    if (inserted > 0) this.#fuzzyCache.clear();
  }
}
