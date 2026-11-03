/** OpenClaw regressions: openclaw-session-db. */
import { strict as assert } from "node:assert";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, test } from "vitest";
import { createSessionDBFixture } from "./openclaw-db-fixture.js";

const { createOpenClawTestDB } = createSessionDBFixture();


// ════════════════════════════════════════════
// OpenClawSessionDB.getMostRecentSession
// ════════════════════════════════════════════

describe("OpenClawSessionDB.getMostRecentSession", () => {
  test("returns null when no sessions exist for sessionKey", () => {
    const db = createOpenClawTestDB();
    const result = db.getMostRecentSession("no-such-key");
    assert.equal(result, null);
  });

  test("returns session_id scoped by sessionKey", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const keyA = "agent-a:telegram:111";
    const keyB = "agent-b:telegram:222";
    const sidA = randomUUID();
    const sidB = randomUUID();

    db.ensureSessionWithKey(sidA, projectDir, keyA);
    db.ensureSessionWithKey(sidB, projectDir, keyB);

    assert.equal(db.getMostRecentSession(keyA), sidA);
    assert.equal(db.getMostRecentSession(keyB), sidB);
  });

  test("returns most recent session when multiple exist for same sessionKey (upsert overwrites)", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const key = "agent-a:telegram:111";
    const sid1 = randomUUID();
    const sid2 = randomUUID();

    db.ensureSessionWithKey(sid1, projectDir, key);
    db.ensureSessionWithKey(sid2, projectDir, key);

    const result = db.getMostRecentSession(key);
    // openclaw_session_map uses UPSERT — second call overwrites the mapping
    assert.equal(result, sid2, "must return the most recently mapped session");
  });

  test("ignores sessions with different sessionKey", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const sidA = randomUUID();
    const sidB = randomUUID();

    db.ensureSessionWithKey(sidA, projectDir, "agent-a:telegram:111");
    db.ensureSessionWithKey(sidB, projectDir, "agent-b:telegram:222");

    assert.equal(db.getMostRecentSession("agent-a:telegram:111"), sidA);
  });
});

// ════════════════════════════════════════════
// OpenClawSessionDB.session_key support
// ════════════════════════════════════════════

describe("OpenClawSessionDB.session_key support", () => {
  test("ensureSessionWithKey stores session_key in openclaw_session_map", () => {
    const db = createOpenClawTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const sessionKey = "agent-a:telegram:12345";

    db.ensureSessionWithKey(sid, projectDir, sessionKey);

    const stats = db.getSessionStats(sid);
    assert.ok(stats, "session must exist");
    assert.equal(db.getMostRecentSession(sessionKey), sid, "session_key must be mapped");
  });

  test("ensureSession works without sessionKey (backward compat via base class)", () => {
    const db = createOpenClawTestDB();
    const sid = randomUUID();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);

    db.ensureSession(sid, projectDir);

    const stats = db.getSessionStats(sid);
    assert.ok(stats, "session must exist");
  });
});

// ════════════════════════════════════════════
// OpenClawSessionDB.renameSession
// ════════════════════════════════════════════

describe("OpenClawSessionDB.renameSession", () => {
  test("migrates events to new session ID", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const oldId = randomUUID();
    const newId = randomUUID();

    db.ensureSession(oldId, projectDir);
    db.insertEvent(oldId, {
      type: "file", category: "file", data: "/src/test.ts", priority: 2, data_hash: "",
    } as unknown as import("../../src/types.js").SessionEvent, "PostToolUse");

    db.renameSession(oldId, newId);

    assert.equal(db.getEventCount(newId), 1, "events must be under new session ID");
    assert.equal(db.getEventCount(oldId), 0, "old session must have no events");
  });

  test("migrates session meta to new session ID", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const oldId = randomUUID();
    const newId = randomUUID();

    db.ensureSession(oldId, projectDir);
    db.renameSession(oldId, newId);

    assert.equal(db.getSessionStats(oldId), null, "old meta must be gone");
    assert.ok(db.getSessionStats(newId), "new meta must exist");
  });

  test("migrates resume snapshot to new session ID", () => {
    const db = createOpenClawTestDB();
    const projectDir = join(tmpdir(), `proj-${randomUUID()}`);
    const oldId = randomUUID();
    const newId = randomUUID();

    db.ensureSession(oldId, projectDir);
    db.upsertResume(oldId, "## Resume", 1);
    db.renameSession(oldId, newId);

    assert.equal(db.getResume(oldId), null, "old resume must be gone");
    assert.ok(db.getResume(newId), "new resume must exist");
  });

  test("is a no-op if oldId does not exist", () => {
    const db = createOpenClawTestDB();
    assert.doesNotThrow(() => db.renameSession(randomUUID(), randomUUID()));
  });
});
