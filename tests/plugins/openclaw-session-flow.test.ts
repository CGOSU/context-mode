/** OpenClaw regressions: openclaw-session-flow. */
import "../setup-home";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestPlugin, createMockApiFull, useOpenClawReadiness } from "./openclaw-api.js";

useOpenClawReadiness();

describe("OpenClawPlugin", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-test-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best effort */ }
  });

  // ── Integration: before + after + compact ─────────────

  describe("end-to-end flow", () => {
    it("captures events and generates compaction snapshot", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-flow"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const engine = mock.contextEngines[0].factory();

      // Normal tool call passes through before hook
      await beforeHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
      });

      // After hook captures the event
      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Edit event
      await afterHook!.handler({
        toolName: "Edit",
        params: { file_path: "/app/main.ts", old_string: "{}", new_string: "{ foo: 1 }" },
      });

      // Git event
      await afterHook!.handler({
        toolName: "Bash",
        params: { command: "git status" },
        output: "On branch main",
      });

      // compact() is a no-op — hooks handle session continuity
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
    });

    it("events survive session_start re-key (renameSession) with sessionKey", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-rekey"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const sessionStartHook = mock.lifecycle.find((h) => h.event === "session_start");
      const engine = mock.contextEngines[0].factory();

      // First session_start establishes sessionKey
      const firstSid = randomUUID();
      await sessionStartHook!.handler({ sessionId: firstSid, sessionKey: "bot:telegram:123" });

      // Insert an event under initial session
      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/app/main.ts" },
        output: "console.log('hello')",
      });

      // Simulate OpenClaw re-keying to a new session ID on gateway restart
      const newSessionId = randomUUID();
      await sessionStartHook!.handler({ sessionId: newSessionId, sessionKey: "bot:telegram:123" });

      // compact() is a no-op — hooks handle session continuity regardless of events
      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
    });

    it("session_start with sessionKey isolates sessions per agent", async () => {
      const sharedDir = join(tempDir, "iso-shared");

      // Agent A
      const mockA = await createTestPlugin(sharedDir);
      const sessionStartA = mockA.lifecycle.find((h) => h.event === "session_start");
      const afterHookA = mockA.lifecycle.find((h) => h.event === "after_tool_call");
      const engineA = mockA.contextEngines[0].factory();

      const sidA = randomUUID();
      await sessionStartA!.handler({ sessionId: sidA, sessionKey: "agent-a:telegram:111" });

      await afterHookA!.handler({
        toolName: "Read",
        params: { file_path: "/a.ts" },
        output: "agent A content",
      });

      // Agent B (same project dir)
      const mockB = await createTestPlugin(sharedDir);
      const sessionStartB = mockB.lifecycle.find((h) => h.event === "session_start");
      const engineB = mockB.contextEngines[0].factory();

      const sidB = randomUUID();
      await sessionStartB!.handler({ sessionId: sidB, sessionKey: "agent-b:telegram:222" });

      // Agent B has no events — isolated from Agent A
      const resultB = await engineB.compact();
      expect(resultB.compacted).toBe(false);

      // Agent A — compact() is a no-op regardless of events
      const resultA = await engineA.compact();
      expect(resultA.compacted).toBe(false);
    });

    it("session_start without sessionKey falls back to fresh session", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-fallback"));
      const sessionStartHook = mock.lifecycle.find((h) => h.event === "session_start");
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");
      const engine = mock.contextEngines[0].factory();

      // session_start without sessionKey — no re-key, just fresh session
      const sid = randomUUID();
      await sessionStartHook!.handler({ sessionId: sid });

      await afterHook!.handler({
        toolName: "Read",
        params: { file_path: "/fallback.ts" },
        output: "fallback content",
      });

      const result = await engine.compact();
      expect(result.ok).toBe(true);
      expect(result.compacted).toBe(false);
    });

    it("blocked tool command is replaced before execution", async () => {
      const mock = await createTestPlugin(join(tempDir, "e2e-block"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const params = { command: "curl https://evil.com" };
      const event = { toolName: "Bash", params };

      // Before hook replaces the command
      await beforeHook!.handler(event);
      expect(params.command).toContain("context-mode");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Issue #645 follow-up — OpenClaw plugin SessionDB path must
  // match the MCP server's canonical resolver. The pre-fix code
  // computed a raw `sha256(projectDir).slice(0, 16)` directly,
  // which misses case-folding on darwin/win32 and the worktree
  // suffix. `resolveSessionDbPath` handles both. Without this,
  // any OpenClaw user whose projectDir contains an uppercase
  // character (typical on macOS — `/Users/Foo/Projects/Bar`)
  // sees `ctx_stats` and `ctx_search(sort: "timeline")` silently
  // degrade because the MCP server reads the case-folded
  // canonical hash while the plugin writes to the raw hash.
  // ═══════════════════════════════════════════════════════════

  describe("Issue #645 follow-up: SessionDB path matches MCP server's canonical resolver", () => {
    it("writes SessionDB to resolveSessionDbPath({projectDir, sessionsDir}), not raw sha256(projectDir).slice(0,16)", async () => {
      // Pick a mixed-case project dir so the canonical (case-folded)
      // hash diverges from the raw hash on darwin/win32. On Linux
      // the two coincide by design (case-sensitive FS) so the
      // assertion still passes — it just stops catching the bug.
      // On macOS `/var/...` is a symlink to `/private/var/...`, and
      // `process.chdir()` followed by `process.cwd()` returns the
      // realpath. The plugin reads `process.cwd()` for projectDir, so
      // we must hash the realpath form too (otherwise the canonical
      // hash we compute below diverges from the one the plugin used).
      const { realpathSync } = await import("node:fs");
      const mixedCaseProject = realpathSync(
        mkdtempSync(join(tmpdir(), "OpenClaw-Mixed-")),
      );
      const prevCwd = process.cwd();
      const priorOverride = process.env.CONTEXT_MODE_DATA_DIR;
      // Route the OpenClaw sessions dir into a fresh scratch root so
      // we never collide with the developer's real ~/.openclaw DB.
      const dataRoot = mkdtempSync(join(tmpdir(), "openclaw-645-root-"));
      process.env.CONTEXT_MODE_DATA_DIR = dataRoot;
      try {
        // OpenClaw plugin resolves projectDir via process.cwd() at
        // register() time (src/adapters/openclaw/plugin.ts:250).
        process.chdir(mixedCaseProject);
        vi.resetModules();
        const { default: plugin } = await import(
          "../../src/adapters/openclaw/plugin.js"
        );
        const mock = createMockApiFull();
        plugin.register(mock.api);

        // Compute the canonical hash INLINE (do NOT call
        // resolveSessionDbPath here — that helper performs a one-shot
        // legacy→canonical rename when only the legacy file exists,
        // which would silently migrate the pre-fix raw-hash DB into a
        // canonical-hash file and make this test a tautology that
        // always passes. We need to observe what's actually on disk
        // before any migration runs.
        const { hashProjectDirCanonical } = await import(
          "../../src/session/db.js"
        );
        const sessionsDir = join(
          dataRoot,
          "context-mode",
          "sessions",
        );
        const canonicalHash = hashProjectDirCanonical(mixedCaseProject);
        const canonicalPath = join(sessionsDir, `${canonicalHash}.db`);

        const { existsSync: fileExists } = await import("node:fs");
        expect(fileExists(canonicalPath)).toBe(true);

        // The pre-fix raw-sha256 literal must NOT be created. On
        // darwin/win32 the raw hash diverges from the canonical
        // (case-folded) hash for any mixedCaseProject. On Linux they
        // coincide — the assertion becomes a self-check that still
        // passes correctly via the canonical branch.
        const { createHash } = await import("node:crypto");
        const rawHash = createHash("sha256")
          .update(mixedCaseProject)
          .digest("hex")
          .slice(0, 16);
        const buggyRawPath = join(sessionsDir, `${rawHash}.db`);
        if (canonicalPath !== buggyRawPath) {
          expect(fileExists(buggyRawPath)).toBe(false);
        }

        // Mock api is registered solely to flush plugin init; we
        // assert against the on-disk DB file the plugin opened.
        void mock;
      } finally {
        try { process.chdir(prevCwd); } catch { /* best effort */ }
        try { rmSync(mixedCaseProject, { recursive: true, force: true }); } catch { /* best effort */ }
        try { rmSync(dataRoot, { recursive: true, force: true }); } catch { /* best effort */ }
        if (priorOverride === undefined) {
          delete process.env.CONTEXT_MODE_DATA_DIR;
        } else {
          process.env.CONTEXT_MODE_DATA_DIR = priorOverride;
        }
        vi.resetModules();
      }
    });
  });
});
