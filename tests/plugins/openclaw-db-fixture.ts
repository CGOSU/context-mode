/** Per-suite explicit-path database fixtures; preserve cleanup of every created DB. */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll } from "vitest";
import { SessionDB } from "../../src/session/db.js";
import { OpenClawSessionDB } from "../../src/adapters/openclaw/session-db.js";

export function createSessionDBFixture() {
  const cleanups: Array<() => void> = [];

  afterAll(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
  });

  function createTestDB(): SessionDB {
    const dbPath = join(tmpdir(), `plugin-hooks-test-${randomUUID()}.db`);
    const db = new SessionDB({ dbPath });
    cleanups.push(() => db.cleanup());
    return db;
  }

  function createOpenClawTestDB(): OpenClawSessionDB {
    const dbPath = join(tmpdir(), `plugin-hooks-test-oc-${randomUUID()}.db`);
    const db = new OpenClawSessionDB({ dbPath });
    cleanups.push(() => db.cleanup());
    return db;
  }

  return { createTestDB, createOpenClawTestDB };
}
