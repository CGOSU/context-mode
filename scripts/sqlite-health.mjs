import { createRequire } from "node:module";
import { resolve } from "node:path";

/** Verify actual read/write and FTS5 support without touching persistent data. */
export function probeSqlite(Database, backend) {
  let db;
  let result;
  try {
    db = new Database(":memory:");
    db.exec("CREATE VIRTUAL TABLE health USING fts5(value, tokenize='porter unicode61')");
    db.prepare("INSERT INTO health(value) VALUES (?)").run("running");
    const row = db.prepare("SELECT value FROM health WHERE health MATCH ?").get("run");
    if (row?.value !== "running") throw new Error("FTS5 read/write verification failed");
    result = { ok: true, backend };
  } catch (error) {
    result = { ok: false, code: "sqlite-capability-failed", message: String(error) };
  } finally {
    try { db?.close(); } catch (error) {
      result = { ok: false, code: "sqlite-close-failed", message: String(error) };
    }
  }
  return result;
}

/** No installation, compilation, binary copying or script-policy overrides. */
export function checkBetterSqlite3(pkgRoot) {
  const require = createRequire(resolve(pkgRoot, "package.json"));
  try {
    require.resolve("better-sqlite3");
  } catch (error) {
    return { ok: false, code: "package-missing", message: `Cannot resolve better-sqlite3: ${error}` };
  }
  try {
    return probeSqlite(require("better-sqlite3"), "better-sqlite3");
  } catch (error) {
    return { ok: false, code: "module-load-failed", message: `Cannot load better-sqlite3: ${error}` };
  }
}

/** Match db-base: prefer built-in SQLite, falling back only when necessary. */
export function checkSqliteRuntime(pkgRoot) {
  const require = createRequire(resolve(pkgRoot, "package.json"));
  if (typeof globalThis.Bun !== "undefined") {
    try {
      return probeSqlite(require("bun:sqlite").Database, "bun:sqlite");
    } catch (error) {
      return { ok: false, code: "module-load-failed", message: `Cannot load bun:sqlite: ${error}` };
    }
  }
  try {
    const result = probeSqlite(require("node:sqlite").DatabaseSync, "node:sqlite");
    if (result.ok) return result;
  } catch { /* The declared native dependency is the supported fallback. */ }
  return checkBetterSqlite3(pkgRoot);
}

export function sqliteRemediation(result) {
  return `[context-mode] SQLite check failed (${result.code}): ${result.message}\n` +
    "Reinstall context-mode's declared dependencies with your package manager on a supported Node/platform. " +
    "No automatic install or compilation was attempted; changing script permissions is not required for the bundled binaries.";
}
