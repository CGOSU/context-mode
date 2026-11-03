import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, describe, expect, test } from "vitest";
import {
  cleanOrphanedWALFiles,
  closeDB,
  loadDatabase,
  applyWALPragmas,
  nodeSqliteHasFts5,
  defaultDBPath,
  deleteDBFiles,
  isSQLiteCorruptionError,
  renameCorruptDB,
  withRetry,
} from "../../src/db-base.js";

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups) {
    try {
      fn();
    } catch {
      // ignore cleanup errors
    }
  }
});

// ════════════════════════════════════════════
// DB-BASE PRIMITIVES (framework-free utilities shared with SessionDB)
// ════════════════════════════════════════════

/** Create a temporary directory that auto-cleans via the shared cleanups array. */
function mkTmpDir(prefix = "db-base-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

describe("withRetry — SQLITE_BUSY retry loop", () => {
  test("returns result immediately when fn succeeds on first attempt", () => {
    let calls = 0;
    const result = withRetry(() => { calls++; return 42; });
    assert.equal(result, 42);
    assert.equal(calls, 1);
  });

  test("retries on SQLITE_BUSY error and eventually returns", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 3) throw new Error("SQLITE_BUSY: database is locked");
      return "ok";
    }, [1, 1, 1]);
    assert.equal(result, "ok");
    assert.equal(calls, 3);
  });

  test("retries on 'database is locked' string (bun:sqlite shape)", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("database is locked");
      return "ok";
    }, [1]);
    assert.equal(result, "ok");
    assert.equal(calls, 2);
  });

  test("rethrows non-busy errors immediately without retry", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw new Error("SQLITE_CORRUPT: disk image malformed"); }, [1, 1, 1]),
      /SQLITE_CORRUPT/,
    );
    assert.equal(calls, 1);
  });

  test("rethrows generic Error without retry", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw new Error("boom"); }, [1, 1]),
      /boom/,
    );
    assert.equal(calls, 1);
  });

  test("handles non-Error throws (string) — rethrows if not busy-shaped", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw "plain string"; }, [1]),
    );
    assert.equal(calls, 1);
  });

  test("retries when non-Error throw is busy-shaped string", () => {
    let calls = 0;
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw "SQLITE_BUSY";
      return 7;
    }, [1]);
    assert.equal(result, 7);
    assert.equal(calls, 2);
  });

  test("throws descriptive error after exhausting all retries", () => {
    let calls = 0;
    const err = (() => {
      try {
        withRetry(() => { calls++; throw new Error("SQLITE_BUSY"); }, [1, 1]);
      } catch (e) { return e as Error; }
      throw new Error("expected throw");
    })();
    assert.match(err.message, /after 2 retries/);
    assert.match(err.message, /Original error: SQLITE_BUSY/);
    assert.equal(calls, 3);
  });

  test("respects delays array length — attempts = delays.length + 1", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw new Error("SQLITE_BUSY"); }, [1, 1, 1, 1]),
      /after 4 retries/,
    );
    assert.equal(calls, 5);
  });

  test("empty delays array means single attempt and no retries", () => {
    let calls = 0;
    assert.throws(
      () => withRetry(() => { calls++; throw new Error("SQLITE_BUSY"); }, []),
      /after 0 retries/,
    );
    assert.equal(calls, 1);
  });

  test("waits between retries (busy-wait respects delay)", () => {
    let calls = 0;
    const start = Date.now();
    const result = withRetry(() => {
      calls++;
      if (calls < 2) throw new Error("SQLITE_BUSY");
      return "done";
    }, [50]);
    const elapsed = Date.now() - start;
    assert.equal(result, "done");
    assert.equal(calls, 2);
    assert.ok(elapsed >= 45, `expected ≥45ms, got ${elapsed}ms`);
  });
});

describe("isSQLiteCorruptionError — known corruption signatures", () => {
  test("matches SQLITE_CORRUPT", () => {
    expect(isSQLiteCorruptionError("SQLITE_CORRUPT: database disk image is malformed")).toBe(true);
  });

  test("matches SQLITE_NOTADB", () => {
    expect(isSQLiteCorruptionError("SQLITE_NOTADB: file is not a database")).toBe(true);
  });

  test("matches 'database disk image is malformed' without prefix", () => {
    expect(isSQLiteCorruptionError("database disk image is malformed")).toBe(true);
  });

  test("matches 'file is not a database' without prefix", () => {
    expect(isSQLiteCorruptionError("file is not a database")).toBe(true);
  });

  test("returns false for unrelated error messages", () => {
    expect(isSQLiteCorruptionError("SQLITE_BUSY: database is locked")).toBe(false);
    expect(isSQLiteCorruptionError("ENOENT: no such file or directory")).toBe(false);
    expect(isSQLiteCorruptionError("boom")).toBe(false);
    expect(isSQLiteCorruptionError("")).toBe(false);
  });

  test("matches corruption signatures embedded in longer messages", () => {
    expect(isSQLiteCorruptionError("Error: SqliteError: SQLITE_CORRUPT: stack\n  at ...")).toBe(true);
  });
});

describe("renameCorruptDB — quarantine on corruption", () => {
  test("renames main DB file with .corrupt-<ts> suffix", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "c.db");
    writeFileSync(dbPath, "garbage");
    renameCorruptDB(dbPath);
    const files = readdirSync(dir);
    const found = files.find(f => f.startsWith("c.db.corrupt-"));
    assert.ok(found, `expected quarantined file in ${files.join(", ")}`);
    assert.equal(existsSync(dbPath), false);
  });

  test("renames sidecar -wal and -shm files when present", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "c.db");
    writeFileSync(dbPath, "db");
    writeFileSync(dbPath + "-wal", "wal");
    writeFileSync(dbPath + "-shm", "shm");
    renameCorruptDB(dbPath);
    const files = readdirSync(dir);
    assert.ok(files.some(f => f.startsWith("c.db.corrupt-")));
    assert.ok(files.some(f => f.startsWith("c.db-wal.corrupt-")));
    assert.ok(files.some(f => f.startsWith("c.db-shm.corrupt-")));
  });

  test("does not throw when sidecar files are missing", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "c.db");
    writeFileSync(dbPath, "db");
    assert.doesNotThrow(() => renameCorruptDB(dbPath));
    assert.equal(existsSync(dbPath), false);
  });

  test("does not throw when the main DB file is also missing", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "missing.db");
    assert.doesNotThrow(() => renameCorruptDB(dbPath));
  });
});

describe("cleanOrphanedWALFiles — WAL cleanup when DB is gone", () => {
  test("removes -wal and -shm when main DB does not exist", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "orphan.db");
    writeFileSync(dbPath + "-wal", "wal");
    writeFileSync(dbPath + "-shm", "shm");
    cleanOrphanedWALFiles(dbPath);
    assert.equal(existsSync(dbPath + "-wal"), false);
    assert.equal(existsSync(dbPath + "-shm"), false);
  });

  test("does nothing when main DB still exists", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "live.db");
    writeFileSync(dbPath, "db");
    writeFileSync(dbPath + "-wal", "wal");
    writeFileSync(dbPath + "-shm", "shm");
    cleanOrphanedWALFiles(dbPath);
    assert.equal(existsSync(dbPath + "-wal"), true);
    assert.equal(existsSync(dbPath + "-shm"), true);
  });

  test("tolerates missing sidecars", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "nothing-here.db");
    assert.doesNotThrow(() => cleanOrphanedWALFiles(dbPath));
  });
});

describe("deleteDBFiles — unconditional cleanup of all three files", () => {
  test("removes main, -wal, and -shm when all present", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "delete-me.db");
    writeFileSync(dbPath, "db");
    writeFileSync(dbPath + "-wal", "wal");
    writeFileSync(dbPath + "-shm", "shm");
    deleteDBFiles(dbPath);
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(dbPath + "-wal"), false);
    assert.equal(existsSync(dbPath + "-shm"), false);
  });

  test("tolerates any subset of files being absent", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "partial.db");
    writeFileSync(dbPath, "db");
    assert.doesNotThrow(() => deleteDBFiles(dbPath));
    assert.equal(existsSync(dbPath), false);
  });

  test("tolerates completely missing paths", () => {
    const dir = mkTmpDir();
    const dbPath = join(dir, "never-existed.db");
    assert.doesNotThrow(() => deleteDBFiles(dbPath));
  });
});

describe("defaultDBPath — process-scoped temp path", () => {
  test("embeds the current process.pid in the filename", () => {
    const p = defaultDBPath();
    expect(p).toContain(`-${process.pid}.db`);
  });

  test("respects the prefix argument", () => {
    const p = defaultDBPath("my-prefix");
    const base = p.split(/[\\/]/).pop() ?? "";
    expect(base.startsWith("my-prefix-")).toBe(true);
    expect(base.endsWith(".db")).toBe(true);
  });

  test("defaults to the 'context-mode' prefix", () => {
    const p = defaultDBPath();
    const base = p.split(/[\\/]/).pop() ?? "";
    expect(base.startsWith("context-mode-")).toBe(true);
  });

  test("returns a path under the OS tmpdir", () => {
    const p = defaultDBPath();
    expect(p.startsWith(tmpdir())).toBe(true);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// SQLITE_BUSY Retry Logic (#218)
// ═══════════════════════════════════════════════════════════════════════════

describe("SQLITE_BUSY retry logic", () => {


  test("withRetry retries on SQLITE_BUSY and succeeds", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "success";
    }, [0, 0, 0]);
    expect(result).toBe("success");
    expect(attempts).toBe(3);
  });

  test("withRetry throws after max retries exhausted", () => {
    expect(() => {
      withRetry(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }, [0, 0, 0]);
    }).toThrow(/SQLITE_BUSY.*3 retries/);
  });

  test("withRetry retries on SQLITE_BUSY with zero delays", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  test("withRetry throws after all retries with zero delays", () => {
    expect(() => {
      withRetry(() => {
        throw new Error("database is locked");
      }, [0, 0, 0]);
    }).toThrow(/SQLITE_BUSY.*3 retries/);
  });

  test("withRetry rethrows non-BUSY errors immediately", () => {
    let attempts = 0;
    expect(() => {
      withRetry(() => {
        attempts++;
        throw new Error("UNIQUE constraint failed");
      }, [0, 0, 0]);
    }).toThrow("UNIQUE constraint failed");
    expect(attempts).toBe(1);
  });
});

// ── withRetry coverage for all write/read paths ──

describe("withRetry edge cases", () => {
  test("withRetry succeeds on first attempt", () => {
    const result = withRetry(() => "immediate", [0, 0, 0]);
    expect(result).toBe("immediate");
  });

  test("withRetry recovers on last retry", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts <= 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "recovered";
    }, [0, 0, 0]);
    expect(result).toBe("recovered");
    expect(attempts).toBe(4); // 1 initial + 3 retries
  });

  test("withRetry handles 'database is locked' without SQLITE_BUSY prefix", () => {
    let attempts = 0;
    const result = withRetry(() => {
      attempts++;
      if (attempts < 2) {
        throw new Error("database is locked");
      }
      return "ok";
    }, [0, 0, 0]);
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("withRetry with empty delays array throws immediately on BUSY", () => {
    expect(() => {
      withRetry(() => {
        throw new Error("SQLITE_BUSY: database is locked");
      }, []);
    }).toThrow(/SQLITE_BUSY.*0 retries/);
  });

  test("withRetry preserves return type", () => {
    const obj = withRetry(() => ({ key: "value", num: 42 }), [0]);
    expect(obj).toEqual({ key: "value", num: 42 });
  });
});

// ── WAL checkpoint on close (#244) ──

describe("closeDB — WAL checkpoint", () => {
  test("closeDB checkpoints WAL so no -wal file remains", () => {
    const dbPath = join(tmpdir(), `wal-test-${Date.now()}.db`);
    const Database = loadDatabase();
    const db = Database(dbPath, { timeout: 30000 });
    applyWALPragmas(db);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    db.exec("INSERT INTO t VALUES (1, 'hello')");

    // WAL file should exist after writes in WAL mode
    expect(existsSync(dbPath + "-wal")).toBe(true);

    closeDB(db);

    // After closeDB, WAL should be checkpointed (truncated to 0 or removed)
    // The file may still exist but should be empty, or may not exist
    const walExists = existsSync(dbPath + "-wal");
    if (walExists) {
      const walSize = readFileSync(dbPath + "-wal").length;
      expect(walSize).toBe(0);
    }

    // cleanup
    for (const s of ["", "-wal", "-shm"]) {
      try { unlinkSync(dbPath + s); } catch {}
    }
  });
});

// ─────────────────────────────────────────────────────────
// nodeSqliteHasFts5 — issue #461
// On Linux + Node >= 22.5, the picker used to commit to node:sqlite as
// soon as the import succeeded, even on Node builds whose bundled SQLite
// is compiled without FTS5. ctx_search/ctx_batch_execute then failed with
// "no such module: fts5". The picker now probes FTS5 support before
// adopting node:sqlite, falling through to better-sqlite3 otherwise.
// ─────────────────────────────────────────────────────────
describe("nodeSqliteHasFts5 — FTS5 capability probe (#461)", () => {
  test("returns true when CREATE VIRTUAL TABLE … USING fts5 succeeds", () => {
    let opened = 0;
    let closed = 0;
    class FakeDB {
      constructor(path: string) {
        assert.equal(path, ":memory:", "probe must use :memory:");
        opened++;
      }
      exec(sql: string): void {
        assert.match(sql, /CREATE VIRTUAL TABLE .* USING fts5/i);
      }
      close(): void { closed++; }
    }
    assert.equal(nodeSqliteHasFts5(FakeDB as any), true);
    assert.equal(opened, 1);
    assert.equal(closed, 1);
  });

  test("returns false when FTS5 module is missing on the bundled SQLite", () => {
    // Reproduces the exact symptom reported in #461 against Node v22.14.0:
    //   db.exec("CREATE VIRTUAL TABLE t USING fts5(x)") → "no such module: fts5"
    let closed = 0;
    class FakeDB {
      exec(_sql: string): void {
        throw new Error("no such module: fts5");
      }
      close(): void { closed++; }
    }
    assert.equal(nodeSqliteHasFts5(FakeDB as any), false);
    assert.equal(closed, 1, "probe DB must be closed even when FTS5 check throws");
  });

  test("returns false when DatabaseSync constructor itself throws", () => {
    class FakeDB {
      constructor() { throw new Error("DatabaseSync ctor failure"); }
      exec(_sql: string): void {}
      close(): void {}
    }
    // Probe must not crash the picker — it just reports "no FTS5".
    assert.equal(nodeSqliteHasFts5(FakeDB as any), false);
  });

  test("close() failure does not propagate out of the probe", () => {
    class FakeDB {
      exec(_sql: string): void {}
      close(): void { throw new Error("close failed"); }
    }
    // Probe should still report success — the FTS5 check passed before close().
    assert.equal(nodeSqliteHasFts5(FakeDB as any), true);
  });

  test("real node:sqlite probe matches FTS5 availability on this runtime", () => {
    // Sanity check: if node:sqlite is loadable, the probe answer must agree
    // with a direct FTS5 attempt on a fresh DatabaseSync. Skipped when
    // node:sqlite is unavailable (older Node, non-Linux without flag).
    let DatabaseSync: any;
    try {
      const requireFn = createRequire(import.meta.url);
      ({ DatabaseSync } = requireFn(["node", "sqlite"].join(":")));
    } catch {
      return;
    }
    let directOK = false;
    let direct: any = null;
    try {
      direct = new DatabaseSync(":memory:");
      direct.exec("CREATE VIRTUAL TABLE __direct_probe USING fts5(x)");
      directOK = true;
    } catch {
      directOK = false;
    } finally {
      try { direct?.close(); } catch { /* ignore */ }
    }
    assert.equal(nodeSqliteHasFts5(DatabaseSync), directOK);
  });
});
