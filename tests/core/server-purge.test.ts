/** Server regressions: purge. */


import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import { ContentStore } from "../../src/store.js";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ─── ctx_purge is the ONLY reset mechanism ──────────────────────────────────

describe("ctx_purge is the sole reset/wipe mechanism", () => {
  const serverSrc = readServerSource();
  const routingBlockSrc = readFileSync(
    resolve(__dirname, "../../hooks/routing-block.mjs"),
    "utf-8",
  );

  // ── ctx_stats has NO reset capability ──
  test("ctx_stats does NOT accept a reset parameter", () => {
    // Extract only the ctx_stats tool registration
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    const statsBody = statsMatch![0];
    expect(statsBody).not.toContain("reset");
    expect(statsBody).not.toContain("resetSessionStats");
  });

  // ── No .clear-stats flag mechanism ──
  test("server has no checkClearStatsFlag mechanism", () => {
    expect(serverSrc).not.toContain("checkClearStatsFlag");
    expect(serverSrc).not.toContain(".clear-stats");
  });

  // ── Routing block: no reset instructions for /clear or /compact ──
  test("routing block does not instruct any reset after /clear or /compact", () => {
    expect(routingBlockSrc).not.toContain("reset: true");
    expect(routingBlockSrc).not.toContain("ctx_stats(reset");
  });

  test("routing block informs user about ctx_purge availability", () => {
    expect(routingBlockSrc).toMatch(/ctx.purge/i);
  });

  // ── ctx_purge is the complete wipe tool ──
  test("ctx_purge gates on confirm parameter", () => {
    expect(serverSrc).toContain("Purge cancelled");
    expect(serverSrc).toMatch(/if \(!confirm\)/);
  });

  test("ctx_purge wipes KB, session DB, events, and stats", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    const purgeBody = purgeMatch![0];
    // 1. Closes the FTS5 knowledge base BEFORE wiping (releases Windows lock)
    expect(purgeBody).toContain("_store.cleanup()");
    expect(purgeBody).toContain("_store = null");
    // 2. Delegates the on-disk wipe to the purgeSession deep module so all
    //    file-kind sweeps (session DB, events.md, cleanup flag, FTS5 store,
    //    legacy content) flow through ONE code path with uniform dual-hash.
    expect(purgeBody).toContain("purgeSession({");
    expect(purgeBody).toContain("projectDir: getProjectDir()");
    expect(purgeBody).toContain("sessionsDir: getSessionDir()");
    expect(purgeBody).toContain("storePath: storePathForPurge");
    // 3. Resets in-memory stats
    expect(purgeBody).toContain("sessionStats.calls = {}");
    expect(purgeBody).toContain("sessionStats.sessionStart = Date.now()");
    // 4. Confirms with list of deleted items
    expect(purgeBody).toContain("Purged:");
  });
});


// ─── Purge deleted array honesty ─────────────────────────────────────────────

describe("ctx_purge deleted array is honest", () => {
  const serverSrc = readServerSource();

  test("every deleted.push in ctx_purge is guarded by a success check", () => {
    // After the purgeSession() deep-module extraction, the per-file-kind
    // success guards live in src/session/purge.ts. The handler itself only
    // ever pushes "session stats" — which is the always-truthful in-memory
    // reset and explicitly exempted from the guard rule. The deep module
    // is independently covered by tests/session/purge-session.test.ts which
    // proves each label appears only when at least one file was unlinked.
    const purgeBody = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    )![0];
    const pushes = [...purgeBody.matchAll(/deleted\.push\("([^"]+)"\)/g)];
    for (const push of pushes) {
      expect(push[1]).toBe("session stats");
    }

    // Issue #520: scoped per-session purge must NOT push "session stats"
    // (stats are project-scoped). The push remains the only string-literal
    // push, but it must be gated on scope === "project".
    expect(purgeBody).toMatch(/scope\s*===\s*["']project["']/);

    const moduleSrc = readFileSync(
      resolve(__dirname, "../../src/session/purge.ts"),
      "utf-8",
    );
    // Each user-facing label inside purgeSession() must be conditionally
    // pushed (success check).  We grep every push and verify the 120 chars
    // before it contain a guard.
    const modulePushes = [...moduleSrc.matchAll(/deleted\.push\("([^"]+)"\)/g)];
    expect(modulePushes.length).toBeGreaterThanOrEqual(2);
    for (const push of modulePushes) {
      const idx = push.index!;
      const context = moduleSrc.slice(Math.max(0, idx - 160), idx);
      const isGuarded = /if\s*\(\s*\w*[Ff]ound/.test(context)
        || /if\s*\(\s*removed\s*\)/.test(context)
        || /if\s*\(\s*_store\s*\)/.test(context);
      expect(isGuarded, `"${push[1]}" in purge.ts must be guarded by a success check`).toBe(true);
    }
  });
});


// ─── Issue #520: scoped ctx_purge handler/schema contract ──────────────────
//
// The HANDLER (not the deep module) owns the schema, the stats reset, and
// the back-compat deprecation warning. The deep module stays pure and
// is covered by tests/session/purge-session.test.ts. These tests assert
// the additive contract WITHOUT booting the MCP server.

describe("ctx_purge scoped handler (issue #520)", () => {
  const serverSrc = readServerSource();
  const purgeBody = serverSrc.match(
    /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
  )![0];

  // Slice 4 — stats file & in-memory reset gated on scope === "project".
  // A scoped per-session purge must leave the persisted stats file alone
  // (other sessions in the project still own those bytes).
  test("slice 4: persisted stats file unlink is gated on scope === 'project'", () => {
    const statsBlockMatch = purgeBody.match(/getStatsFilePath\(\)[\s\S]{0,300}/);
    expect(statsBlockMatch, "stats unlink block must exist in handler").not.toBeNull();
    // The whole stats reset (in-memory + file unlink) must live under a
    // `if (... === "project")` branch — verified by ensuring the stats
    // unlink is NOT at the top level of the handler.
    const statsIdx = purgeBody.indexOf("getStatsFilePath()");
    const beforeStats = purgeBody.slice(0, statsIdx);
    expect(beforeStats).toMatch(/scope\s*===\s*["']project["']/);
  });

  // Slice 5 — back-compat: bare {confirm:true} keeps verbatim behavior.
  // The handler must map missing scope/sessionId → scope:"project" and
  // delegate to purgeSession exactly as before. The schema must accept
  // bare {confirm:true} as it always did.
  test("slice 5: bare {confirm:true} handler still calls purgeSession with project scope", () => {
    // Either explicit scope:"project" is passed, OR the deep module's
    // own default-resolution kicks in. The handler MUST NOT throw on
    // bare {confirm:true}.
    expect(purgeBody).toMatch(/purgeSession\(/);
    expect(purgeBody).not.toMatch(/throw new (?:Error|TypeError)\([^)]*sessionId/);
  });

  // Slice 6 — schema rejects {confirm, sessionId, scope:"project"} (ambiguous).
  // The MCP SDK's normalizeObjectSchema() requires a plain ZodObject so it
  // can read `.shape` when serializing inputSchema → JSON Schema for
  // tools/list. A `.refine()` wrapper produces a ZodEffects which has no
  // `.shape`, so the SDK falls back to `properties: {}` — and Claude Code's
  // strict-input-validation gate then rejects the tool call before the
  // handler ever runs. Issue #563.
  //
  // Therefore the cross-field check MUST live in the handler body, not on
  // the schema. Verify (a) the inputSchema is NOT wrapped in refine() and
  // (b) the handler still rejects the ambiguous combo at runtime.
  test("slice 6: inputSchema is plain z.object — no .refine/.transform/.superRefine wrapper (#563)", () => {
    // Locate the inputSchema literal (between `inputSchema:` and the next
    // top-level handler comma `},`). Anchor narrowly so we only inspect
    // the schema, not the handler body that legitimately contains checks.
    const schemaStart = purgeBody.indexOf("inputSchema:");
    expect(schemaStart).toBeGreaterThan(-1);
    // The schema literal ends at the matching close of registerTool's
    // options object — i.e. just before `},\n  async (`.
    const handlerStart = purgeBody.indexOf("async ({");
    expect(handlerStart).toBeGreaterThan(schemaStart);
    const schemaSlice = purgeBody.slice(schemaStart, handlerStart);
    expect(schemaSlice).not.toMatch(/\.refine\(/);
    expect(schemaSlice).not.toMatch(/\.superRefine\(/);
    expect(schemaSlice).not.toMatch(/\.transform\(/);
  });

  test("slice 6b: handler rejects ambiguous {sessionId + scope:'project'} at runtime (#563)", () => {
    // The cross-field ambiguity check moved out of the schema into the
    // handler body. Verify a guard exists that fires when sessionId is
    // present AND scope === "project", and that it returns isError:true
    // rather than throwing.
    const handlerSlice = purgeBody.slice(purgeBody.indexOf("async ({"));
    expect(handlerSlice).toMatch(
      /sessionId\s*&&\s*scope\s*===\s*["']project["']|scope\s*===\s*["']project["']\s*&&\s*sessionId/,
    );
    expect(handlerSlice).toMatch(/isError:\s*true/);
    // Human-readable message preserved (matches the original refine() text
    // so consumers see the same guidance).
    expect(handlerSlice).toMatch(/[Aa]mbiguous/);
  });

  // Slice 7 — schema accepts {confirm:true, sessionId:"<uuid>"}.
  test("slice 7: schema declares optional sessionId and scope", () => {
    expect(purgeBody).toMatch(/sessionId:\s*z\.string\(\)\.optional\(\)/);
    expect(purgeBody).toMatch(/scope:\s*z\.enum\(\[["']session["'],\s*["']project["']\]\)\.optional\(\)/);
  });

  // Slice 8 — bare {confirm:true} (no sessionId, no scope) emits a
  // deprecation warning to stderr exactly once. The warn lives in the
  // handler — not the deep module — to keep purge.ts pure.
  test("slice 8: handler emits deprecation warning when scope+sessionId both omitted", () => {
    expect(purgeBody).toMatch(/console\.warn\([^)]*deprecat/i);
  });

  // Slice 9 (#563 regression — class-wide guard) — NO registered MCP tool
  // may wrap its inputSchema in .refine(), .superRefine(), or .transform().
  // All three produce a ZodEffects, which the MCP SDK's
  // normalizeObjectSchema() does not recognize (it reads `.shape`), so the
  // serialized JSON Schema collapses to `properties: {}` — and Claude Code
  // (and any strict-input client) then refuses every call to that tool
  // with "input_schema does not support fields". Move cross-field checks
  // into the handler body. This test catches the entire class for ALL
  // registered tools, not just ctx_purge.
  test("slice 9: all registered MCP tools must have non-empty input schema (regression for #563)", () => {
    // Match every registerTool(...) block — same anchor pattern used by
    // the per-tool slices above. Greedy [\s\S]*? + line-anchored ^);
    // terminator = the body of one registerTool call.
    const blocks = [
      ...serverSrc.matchAll(
        /server\.registerTool\(\s*"([^"]+)"[\s\S]*?^\);/gm,
      ),
    ];
    expect(blocks.length).toBeGreaterThan(5);

    const violations: string[] = [];
    for (const m of blocks) {
      const name = m[1];
      const body = m[0];
      // Isolate just the inputSchema literal (between `inputSchema:` and
      // the start of the handler arrow `async (`). Tools without an
      // inputSchema (none currently) are skipped silently.
      const sIdx = body.indexOf("inputSchema:");
      if (sIdx < 0) continue;
      const hIdx = body.indexOf("async (", sIdx);
      const schemaSlice = hIdx > sIdx ? body.slice(sIdx, hIdx) : body.slice(sIdx);
      if (/\.refine\(/.test(schemaSlice)) violations.push(`${name}: .refine()`);
      if (/\.superRefine\(/.test(schemaSlice)) violations.push(`${name}: .superRefine()`);
      if (/\.transform\(/.test(schemaSlice)) violations.push(`${name}: .transform()`);
    }
    expect(
      violations,
      "ZodEffects on inputSchema breaks MCP SDK normalizeObjectSchema → JSON " +
        "Schema collapses to properties:{} → Claude Code rejects with " +
        "'input_schema does not support fields'. Move cross-field checks into " +
        "the handler body. See issue #563.",
    ).toEqual([]);
  });
});


// ─── KB purge behavioral (ContentStore) ─────────────────────────────────────

describe("ContentStore purge behavior", () => {
  test("cleanup() deletes DB files (including WAL and SHM)", () => {
    const tmpPath = join(tmpdir(), `ctx-purge-test-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);

    store.index({ content: "test content for purge verification", source: "purge-test" });
    expect(store.getStats().chunks).toBeGreaterThan(0);

    store.cleanup();

    // All DB files should be gone
    expect(existsSync(tmpPath)).toBe(false);
    expect(existsSync(tmpPath + "-wal")).toBe(false);
    expect(existsSync(tmpPath + "-shm")).toBe(false);
  });

  test("index survives when cleanup is NOT called (--continue scenario)", () => {
    const tmpPath = join(tmpdir(), `ctx-preserve-test-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);

    store.index({ content: "preserved content across sessions", source: "preserve-test" });
    store.close();

    // Simulate --continue: reopen same DB
    const store2 = new ContentStore(tmpPath);
    const stats = store2.getStats();
    expect(stats.chunks).toBeGreaterThan(0);

    const results = store2.search("preserved content", 5);
    expect(results.length).toBeGreaterThan(0);

    store2.cleanup();
  });

  test("store recovers after purge — new index works", () => {
    const tmpPath = join(tmpdir(), `ctx-recovery-test-${Date.now()}.db`);

    // Phase 1: index and purge
    const store1 = new ContentStore(tmpPath);
    store1.index({ content: "old content to be purged", source: "old" });
    store1.cleanup();
    expect(existsSync(tmpPath)).toBe(false);

    // Phase 2: create fresh store at same path, index new content
    const store2 = new ContentStore(tmpPath);
    store2.index({ content: "fresh content after purge", source: "new" });

    const results = store2.search("fresh content", 5);
    expect(results.length).toBeGreaterThan(0);

    // Old content should NOT be found
    const oldResults = store2.search("old content to be purged", 5);
    expect(oldResults.length).toBe(0);

    store2.cleanup();
  });

  test("double cleanup does not crash", () => {
    const tmpPath = join(tmpdir(), `ctx-double-purge-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);
    store.index({ content: "some content", source: "test" });

    // First cleanup
    store.cleanup();
    expect(existsSync(tmpPath)).toBe(false);

    // Second cleanup — DB already gone, should not throw
    expect(() => store.cleanup()).not.toThrow();
  });

  test("cleanup on never-indexed store does not crash", () => {
    const tmpPath = join(tmpdir(), `ctx-empty-purge-${Date.now()}.db`);
    const store = new ContentStore(tmpPath);

    // No indexing done — purge should still work
    expect(() => store.cleanup()).not.toThrow();
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("ctx_purge handler deletes DB file even when _store is null (--continue scenario)", () => {
    // After the purgeSession() extraction (src/session/purge.ts) the
    // _store-is-null branch lives there: the handler ALWAYS resolves
    // getStorePath() and passes it as `storePath`, regardless of whether
    // _store was open.  purgeSession unlinks the file unconditionally,
    // which is exactly the --continue scenario this test was created for.
    // Behavioral coverage: tests/session/purge-session.test.ts slice 5.
    const serverSrc = readServerSource();
    const purgeBody = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    )![0];

    // Handler resolves storePath BEFORE the optional _store.cleanup() so
    // the disk wipe runs whether _store was open or not.
    const storePathIdx = purgeBody.indexOf("getStorePath()");
    const storeCleanupIdx = purgeBody.indexOf("_store.cleanup()");
    expect(storePathIdx).toBeGreaterThan(-1);
    expect(storePathIdx).toBeLessThan(storeCleanupIdx === -1 ? Infinity : storeCleanupIdx);
    // Handler always passes storePath into the deep module — that is what
    // makes the wipe unconditional.
    expect(purgeBody).toContain("storePath: storePathForPurge");

    // Deep module is the one calling unlinkSync on the FTS5 store path.
    const moduleSrc = readFileSync(
      resolve(__dirname, "../../src/session/purge.ts"),
      "utf-8",
    );
    expect(moduleSrc).toContain("unlinkSync");
  });
});
