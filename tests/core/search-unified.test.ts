/** Search unified regressions. */

import { describe, test, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { ContentStore } from "../../src/store.js";
import { SessionDB, hashProjectDirCanonical } from "../../src/session/db.js";
import { searchAllSources } from "../../src/search/unified.js";
import { searchAutoMemory } from "../../src/search/auto-memory.js";


// ═══════════════════════════════════════════════════════════
// 8. Unified multi-source search (consolidated from tests/search/unified.test.ts)
// ═══════════════════════════════════════════════════════════

const unifiedCleanups: Array<() => void> = [];

function createUnifiedStore(): ContentStore {
  const path = join(
    tmpdir(),
    `ctx-unified-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const store = new ContentStore(path);
  unifiedCleanups.push(() => store.close());
  return store;
}

function createTestDB(): SessionDB {
  const dbPath = join(tmpdir(), `session-unified-test-${randomUUID()}.db`);
  const db = new SessionDB({ dbPath });
  unifiedCleanups.push(() => db.cleanup());
  return db;
}

function createTempDir(): string {
  const dir = join(tmpdir(), `ctx-unified-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  unifiedCleanups.push(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

afterEach(() => {
  for (const fn of unifiedCleanups) {
    try { fn(); } catch { /* ignore */ }
  }
  unifiedCleanups.length = 0;
});

describe("sort=relevance returns ContentStore only", () => {
  test("relevance mode only queries ContentStore, ignores SessionDB and auto-memory", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Authentication middleware validates JWT tokens on every request.",
      "execute:shell",
    );

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "JWT handler in session DB",
      priority: 2,
    }, "PostToolUse");

    const results = searchAllSources({
      query: "JWT",
      limit: 5,
      store,
      sort: "relevance",
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Should have results from ContentStore only
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });
});

describe("sort=timeline merges 3 sources chronologically", () => {
  test("timeline mode merges ContentStore, SessionDB, and auto-memory results", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Deploy pipeline configuration for production environment.",
      "execute:shell",
    );

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "tool",
      category: "tool",
      data: "Deploy script executed successfully in prior session",
      priority: 2,
    }, "PostToolUse");

    // Create auto-memory files
    const configDir = createTempDir();
    const memoryDir = join(configDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(configDir, "CLAUDE.md"),
      "# Deploy Rules\nAlways deploy to staging first.\n",
    );

    const results = searchAllSources({
      query: "deploy",
      limit: 10,
      store,
      sort: "timeline",
      sessionDB,
      projectDir: "/project",
      configDir,
    });

    // Should have results from multiple origins
    const origins = new Set(results.map(r => r.origin));
    expect(origins.has("current-session")).toBe(true);
    // SessionDB or auto-memory should also appear
    expect(origins.size).toBeGreaterThanOrEqual(2);
  });

  test("timeline results are sorted chronologically", () => {
    const store = createUnifiedStore();
    store.indexPlainText("Server config alpha", "execute:shell");

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "config",
      category: "config",
      data: "Server config beta from prior session",
      priority: 2,
    }, "PostToolUse");

    const results = searchAllSources({
      query: "server config",
      limit: 10,
      store,
      sort: "timeline",
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Verify chronological ordering: timestamps should be non-decreasing
    for (let i = 1; i < results.length; i++) {
      const prev = results[i - 1].timestamp || "";
      const curr = results[i].timestamp || "";
      // Allow empty timestamps (ContentStore results) — they sort first
      if (prev && curr) {
        expect(prev <= curr).toBe(true);
      }
    }
  });
});

describe("error in one source doesn't break others", () => {
  test("invalid sessionDB still returns ContentStore results", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Error handling test content with database queries.",
      "execute:shell",
    );

    // Pass null sessionDB to simulate unavailable session DB
    const results = searchAllSources({
      query: "database",
      limit: 5,
      store,
      sort: "timeline",
      sessionDB: null,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });

  test("nonexistent configDir still returns other source results", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Memory resilience test with important data.",
      "execute:shell",
    );

    const results = searchAllSources({
      query: "resilience",
      limit: 5,
      store,
      sort: "timeline",
      sessionDB: null,
      projectDir: "/project",
      configDir: "/tmp/definitely-does-not-exist-" + randomUUID(),
    });

    expect(results.length).toBeGreaterThan(0);
  });
});

describe("empty index guard skipped in timeline mode", () => {
  test("timeline mode proceeds even when ContentStore has zero chunks", () => {
    const store = createUnifiedStore(); // empty, no indexed content

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "Important file from prior session timeline check",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "env", confidence: 1 });

    // In timeline mode, empty ContentStore should NOT be an error
    const results = searchAllSources({
      query: "timeline check",
      limit: 5,
      store,
      sort: "timeline",
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Should get results from SessionDB even though ContentStore is empty
    const priorResults = results.filter(r => r.origin === "prior-session");
    expect(priorResults.length).toBeGreaterThan(0);
  });

  test("relevance mode with empty store returns no results", () => {
    const store = createUnifiedStore(); // empty

    const results = searchAllSources({
      query: "anything",
      limit: 5,
      store,
      sort: "relevance",
      sessionDB: null,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    expect(results.length).toBe(0);
  });
});

describe("default sort is relevance (backward compatible)", () => {
  test("omitting sort defaults to relevance behavior", () => {
    const store = createUnifiedStore();
    store.indexPlainText(
      "Backward compatibility test for default search mode.",
      "execute:shell",
    );

    const sessionDB = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    sessionDB.ensureSession(sessionId, "/project");
    sessionDB.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "Backward compatibility data in session DB",
      priority: 2,
    }, "PostToolUse");

    // No sort param — should default to "relevance"
    const results = searchAllSources({
      query: "backward compatibility",
      limit: 5,
      store,
      // sort intentionally omitted
      sessionDB,
      projectDir: "/project",
      configDir: "/nonexistent",
    });

    // Should only have ContentStore results (relevance mode)
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.origin === "current-session")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 9. Auto-memory search (consolidated from tests/search/auto-memory.test.ts)
// ═══════════════════════════════════════════════════════════

describe("searchAutoMemory", () => {
  const AUTO_MEM_ROOT = join(tmpdir(), `ctx-auto-memory-test-${Date.now()}`);
  const CLAUDE_CONFIG = join(AUTO_MEM_ROOT, ".claude");
  const QWEN_CONFIG = join(AUTO_MEM_ROOT, ".qwen");
  const PROJECT_DIR = join(AUTO_MEM_ROOT, "project");

  // Set up fixture files once
  (() => {
    // Create project-level CLAUDE.md
    mkdirSync(PROJECT_DIR, { recursive: true });
    writeFileSync(
      join(PROJECT_DIR, "CLAUDE.md"),
      "Project instructions: use TypeScript strict mode. Analytics pipeline config here.",
    );

    // Create user-level configDir for .claude
    // Issue #663: memory dir is now scoped by projectDir hash to prevent
    // cross-project contamination. Tests below cover both call shapes:
    //   - projectDir=PROJECT_DIR (scoped) → reads <CLAUDE_CONFIG>/memory/<hash>
    //   - projectDir=undefined  (legacy) → reads <CLAUDE_CONFIG>/memory
    // Write fixtures to BOTH so each call shape sees the same content.
    const projectHash = hashProjectDirCanonical(PROJECT_DIR);
    const claudeMemScoped = join(CLAUDE_CONFIG, "memory", projectHash);
    const claudeMemLegacy = join(CLAUDE_CONFIG, "memory");
    mkdirSync(claudeMemScoped, { recursive: true });
    mkdirSync(claudeMemLegacy, { recursive: true });

    writeFileSync(
      join(CLAUDE_CONFIG, "CLAUDE.md"),
      "Global user preferences: dark theme, vim keybindings.",
    );

    const memoryFiles: Array<[string, string]> = [
      ["analytics_separation.md", "Analytics must be separate project, not inside context-mode. Datadog model."],
      ["push_to_next.md", "Always push to next branch, never feature branches."],
      ["npm_token.md", "npm publish token location for context-mode releases."],
      ["user_identity.md", "User name is Alice. Speaks English and French."],
    ];
    for (const [name, body] of memoryFiles) {
      writeFileSync(join(claudeMemScoped, name), body);
      writeFileSync(join(claudeMemLegacy, name), body);
    }

    // Create user-level configDir for .qwen — Qwen tests below pass
    // projectDir=undefined, so the unscoped path is the right fixture target.
    const qwenMemDir = join(QWEN_CONFIG, "memory");
    mkdirSync(qwenMemDir, { recursive: true });
    writeFileSync(join(QWEN_CONFIG, "CLAUDE.md"), "Qwen user config.");
    writeFileSync(join(qwenMemDir, "note.md"), "Qwen analytics note content.");
  })();

  test("returns empty for non-existent project and config directories", () => {
    const results = searchAutoMemory(
      ["anything"],
      10,
      "/nonexistent/project",
      "/nonexistent/config",
    );
    expect(results).toEqual([]);
  });

  test("finds matching content in memory files", () => {
    const results = searchAutoMemory(
      ["analytics"],
      10,
      PROJECT_DIR,
      CLAUDE_CONFIG,
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
    const hasAnalytics = results.some((r) => r.content.toLowerCase().includes("analytics"));
    expect(hasAnalytics).toBe(true);
    for (const r of results) {
      expect(r.origin).toBe("auto-memory");
    }
  });

  test("case-insensitive search", () => {
    const lower = searchAutoMemory(["analytics"], 10, PROJECT_DIR, CLAUDE_CONFIG);
    const upper = searchAutoMemory(["ANALYTICS"], 10, PROJECT_DIR, CLAUDE_CONFIG);
    const mixed = searchAutoMemory(["AnAlYtIcS"], 10, PROJECT_DIR, CLAUDE_CONFIG);

    expect(lower.length).toBeGreaterThanOrEqual(1);
    expect(upper.length).toBe(lower.length);
    expect(mixed.length).toBe(lower.length);
  });

  test("respects limit parameter", () => {
    const bulkConfig = join(AUTO_MEM_ROOT, ".bulk-test");
    const bulkMemDir = join(bulkConfig, "memory");
    mkdirSync(bulkMemDir, { recursive: true });
    writeFileSync(join(bulkConfig, "CLAUDE.md"), "bulk keyword_match config.");
    for (let i = 0; i < 20; i++) {
      writeFileSync(
        join(bulkMemDir, `note_${i.toString().padStart(3, "0")}.md`),
        `keyword_match content ${i}`,
      );
    }

    const results = searchAutoMemory(
      ["keyword_match"],
      3,
      undefined,
      bulkConfig,
    );

    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("one match per file even with multiple query hits", () => {
    const results = searchAutoMemory(
      ["analytics", "project"],
      10,
      PROJECT_DIR,
      CLAUDE_CONFIG,
    );

    const sources = results.map((r) => r.source);
    const uniqueSources = new Set(sources);
    expect(uniqueSources.size).toBe(sources.length);
  });

  test("multiple queries match different files", () => {
    const results = searchAutoMemory(
      ["analytics", "npm"],
      10,
      PROJECT_DIR,
      CLAUDE_CONFIG,
    );

    expect(results.length).toBeGreaterThanOrEqual(2);
    const sources = results.map((r) => r.source);
    const uniqueSources = new Set(sources);
    expect(uniqueSources.size).toBeGreaterThanOrEqual(2);
  });

  test("returns empty array for empty queries", () => {
    const results = searchAutoMemory([], 10, PROJECT_DIR, CLAUDE_CONFIG);
    expect(results).toEqual([]);
  });

  test("adapter-aware: different configDir yields different results", () => {
    const claudeResults = searchAutoMemory(["analytics"], 10, undefined, CLAUDE_CONFIG);
    const qwenResults = searchAutoMemory(["analytics"], 10, undefined, QWEN_CONFIG);

    expect(claudeResults.length).toBeGreaterThanOrEqual(1);
    expect(qwenResults.length).toBeGreaterThanOrEqual(1);

    const claudeSources = claudeResults.map((r) => r.source);
    const qwenSources = qwenResults.map((r) => r.source);
    expect(claudeSources).not.toEqual(qwenSources);
  });

  test("result shape matches AutoMemoryResult interface", () => {
    const results = searchAutoMemory(["Alice"], 10, undefined, CLAUDE_CONFIG);
    expect(results.length).toBeGreaterThanOrEqual(1);

    const r = results[0];
    expect(r).toHaveProperty("title");
    expect(r).toHaveProperty("content");
    expect(r).toHaveProperty("source");
    expect(r).toHaveProperty("origin");
    expect(r.origin).toBe("auto-memory");
    expect(r.title).toContain("[auto-memory]");
  });

  test("finds content in CLAUDE.md files (unified)", () => {
    const configDir = createTempDir();
    writeFileSync(
      join(configDir, "CLAUDE.md"),
      "# Rules\nAlways use TypeScript strict mode.\nNever skip tests.\n",
    );

    const results = searchAutoMemory(["typescript strict"], 5, undefined, configDir);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].origin).toBe("auto-memory");
    expect(results[0].content).toContain("TypeScript strict");
  });

  test("finds content in memory directory (unified)", () => {
    const configDir = createTempDir();
    const memoryDir = join(configDir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(
      join(memoryDir, "preferences.md"),
      "User prefers dark theme and vim keybindings.\n",
    );

    const results = searchAutoMemory(["vim keybindings"], 5, undefined, configDir);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("vim keybindings");
  });

  test("returns empty for nonexistent dirs (unified)", () => {
    const results = searchAutoMemory(
      ["anything"],
      5,
      "/nonexistent-project",
      "/nonexistent-config",
    );
    expect(results.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 10. SessionDB.searchEvents via unified search (consolidated from tests/search/unified.test.ts)
// ═══════════════════════════════════════════════════════════

describe("SessionDB.searchEvents (unified)", () => {
  test("finds events matching query text", () => {
    const db = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    db.ensureSession(sessionId, "/project");

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "src/authentication/jwt-handler.ts",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "test", confidence: 1 });

    db.insertEvent(sessionId, {
      type: "tool",
      category: "tool",
      data: "npm test executed successfully",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "test", confidence: 1 });

    const results = db.searchEvents("authentication", 10, "/project");
    expect(results.length).toBe(1);
    expect(results[0].data).toContain("authentication");
  });

  test("scopes search by projectDir", () => {
    const db = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    db.ensureSession(sessionId, "/project-a");

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "deploy script content",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project-a", source: "env", confidence: 1 });

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "deploy config content",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project-b", source: "env", confidence: 1 });

    const results = db.searchEvents("deploy", 10, "/project-a");
    expect(results.length).toBe(1);
    expect(results[0].data).toBe("deploy script content");
  });

  test("returns empty for no matches", () => {
    const db = createTestDB();
    const sessionId = `test-${randomUUID()}`;
    db.ensureSession(sessionId, "/project");

    db.insertEvent(sessionId, {
      type: "file",
      category: "file",
      data: "some unrelated content",
      priority: 2,
    }, "PostToolUse", { projectDir: "/project", source: "test", confidence: 1 });

    const results = db.searchEvents("nonexistent-xyzzy", 10, "/project");
    expect(results.length).toBe(0);
  });
});
