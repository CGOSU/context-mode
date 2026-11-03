/** Server regressions: platform. */


import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ─── Platform-aware session DB paths ─────────────────────────────────────────

describe("Platform-aware session paths via adapter", () => {
  const serverSrc = readServerSource();

  // ── Adapter is stored at startup ──
  test("server stores detected adapter at startup", () => {
    expect(serverSrc).toContain("let _detectedAdapter");
    // main() must assign the adapter after detection
    expect(serverSrc).toMatch(/_detectedAdapter\s*=\s*await\s+getAdapter/);
  });

  // ── No hardcoded .claude in tool handlers ──
  test("ctx_purge has no hardcoded .claude path", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    expect(purgeMatch![0]).not.toMatch(/["']\.claude["']/);
  });

  test("ctx_stats has no hardcoded .claude path", () => {
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    expect(statsMatch![0]).not.toMatch(/["']\.claude["']/);
  });

  // ── Adapter methods used for session paths (post-C2 narrowing) ──
  test("session paths derived from adapter.getSessionDir + resolveSessionDbPath", () => {
    // C2 narrowing (2026-05): adapter no longer exposes getSessionDBPath /
    // getSessionEventsPath. server.ts must derive per-project DB paths via
    // resolveSessionDbPath while reading the adapter ONLY for the platform
    // sessionDir. Pin both calls so an accidental regression to a missing
    // helper or a deleted adapter method is caught at the test boundary.
    expect(serverSrc).toMatch(/getSessionDir\(/);
    expect(serverSrc).toMatch(/resolveSessionDbPath\(/);
  });

  // ── Comprehensive projectDir detection ──
  test("getProjectDir delegates to resolveProjectDir; chain lives in util/project-dir.ts", () => {
    const fn = serverSrc.match(/function getProjectDir[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // Server.ts MUST delegate so the env-var chain + plugin-path rejection
    // is unified with start.mjs (see v1.0.113 hotfix).
    expect(body).toContain("resolveProjectDir");
    expect(body).toContain("process.env.PWD");
    // Env-var chain itself moved to the shared resolver — pin its contract there.
    const utilSrc = readFileSync(
      resolve(__dirname, "../../src/util/project-dir.ts"),
      "utf-8",
    );
    for (const v of [
      "CLAUDE_PROJECT_DIR",
      "GEMINI_PROJECT_DIR",
      "VSCODE_CWD",
      "OPENCODE_PROJECT_DIR",
      "PI_PROJECT_DIR",
      "IDEA_INITIAL_DIRECTORY",
      "CURSOR_CWD",
      "CONTEXT_MODE_PROJECT_DIR",
    ]) {
      expect(utilSrc).toContain(v);
    }
    expect(utilSrc).toContain("isPluginInstallPath");
    // Must NOT contain semantically wrong env vars
    expect(utilSrc).not.toContain("OPENCLAW_HOME");
  });

  // Issue #521 Slice 2: transcriptsRoot is the Claude Code transcript dir
  // (`~/.claude/projects`). Passing it on non-Claude-Code platforms (Cursor,
  // OpenCode, Codex, ...) is wrong — the most-recently-modified jsonl could
  // belong to an unrelated Claude Code window, returning that project's cwd
  // to a Cursor MCP. getProjectDir() MUST gate transcriptsRoot on the active
  // platform via detectPlatform(); only "claude-code" gets the path.
  test("getProjectDir gates transcriptsRoot on detected platform (Claude Code only)", () => {
    const fn = serverSrc.match(/function getProjectDir[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // Must reference detectPlatform so the gate is dynamic per-process.
    expect(body).toContain("detectPlatform");
    // Must check for the claude-code platform string (literal — pinning the
    // gate predicate so a typo or platform-id rename is caught here).
    expect(body).toContain("claude-code");
    // Still passes transcriptsRoot when the gate matches.
    expect(body).toContain("transcriptsRoot");
  });

  // ── Content DB is platform-isolated (not shared) ──
  test("getStorePath uses platform-specific dir, not shared ~/.context-mode/", () => {
    const fn = serverSrc.match(/function getStorePath[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // Must NOT use the shared platform-agnostic directory
    expect(body).not.toContain('".context-mode"');
    // Must derive content dir from adapter/session dir (platform-specific)
    expect(body).toContain("resolveContentStorageDir(getDefaultSessionDir)");
  });
});


// ─── Hash consistency ────────────────────────────────────────────────────────

describe("Project dir hash consistency", () => {
  const serverSrc = readServerSource();

  test("server.ts imports canonical hash + path resolvers from session/db.js", () => {
    // After the case-fold migration + content-store migration, all DB
    // path computation lives in src/session/db.ts. The server MUST import
    // resolveSessionDbPath + resolveContentStorePath rather than rolling
    // its own hash + join inline.
    expect(serverSrc).toMatch(
      /import\s*\{[^}]*resolveSessionDbPath[^}]*\}\s*from\s*"\.\/session\/db\.js"/,
    );
    expect(serverSrc).toMatch(
      /import\s*\{[^}]*resolveContentStorePath[^}]*\}\s*from\s*"\.\/session\/db\.js"/,
    );
    // The deleted local helpers MUST be gone — guards against accidental
    // re-introduction that would split the case-fold contract.
    expect(serverSrc).not.toMatch(/^function hashProjectDir\(/m);
    expect(serverSrc).not.toMatch(/^function normalizeProjectDirForHash\(/m);
  });

  test("getStorePath delegates to resolveContentStorePath (auto case-fold migration)", () => {
    const fn = serverSrc.match(/function getStorePath[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    expect(fn![0]).toContain("resolveContentStorePath");
    // Must NOT have its own inline createHash call.
    expect(fn![0]).not.toContain("createHash");
  });

  test("server storage paths are routed through runtime override resolver", () => {
    expect(serverSrc).toContain("resolveSessionStorageDir");
    expect(serverSrc).toContain("resolveContentStorageDir");
    expect(serverSrc).toContain("resolveStatsStorageDir");
    expect(serverSrc).toContain("ensureWritableStorageDir");
    expect(serverSrc).toContain("formatStorageDirectoryError");
  });

  test("ctx_stats uses hashProjectDir, not inline hashing", () => {
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    expect(statsMatch![0]).toContain("hashProjectDir");
    expect(statsMatch![0]).not.toContain("createHash");
  });

  test("ctx_purge uses hashProjectDir, not inline hashing", () => {
    const purgeMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_purge"[\s\S]*?^\);/m,
    );
    expect(purgeMatch).not.toBeNull();
    expect(purgeMatch![0]).toContain("hashProjectDir");
    expect(purgeMatch![0]).not.toContain("createHash");
  });

  // ── B3b Slice 3.1: ctx_stats must scope getLifetimeStats to the active
  //    adapter via getSessionDir(), not the hardcoded ~/.claude/ default.
  //    Bug evidence: src/server.ts:2602/2612/2620 currently call
  //    `getLifetimeStats()` with no args, so non-Claude platforms (Cursor,
  //    OpenCode, JetBrains, ...) silently aggregate from the wrong dir.
  //    Statusline at src/server.ts:540 already passes
  //    `{ sessionsDir: getSessionDir() }` — the three ctx_stats sites must
  //    mirror that contract exactly. Note: `getMultiAdapterLifetimeStats`
  //    is NOT covered by this test because it takes `{ home }` and
  //    intentionally defaults to homedir() to scan every adapter dir; the
  //    bare-call form is correct for that helper.
  test("ctx_stats scopes lifetime aggregation to the active adapter sessionsDir", () => {
    const statsMatch = serverSrc.match(
      /server\.registerTool\(\s*"ctx_stats"[\s\S]*?^\);/m,
    );
    expect(statsMatch).not.toBeNull();
    const body = statsMatch![0];
    // Every `getLifetimeStats(` invocation inside ctx_stats MUST be argumented
    // (sessionsDir-aware). A bare `()` call falls back to the hardcoded
    // ~/.claude/context-mode/sessions default and silently mis-attributes
    // lifetime counts on non-Claude platforms. Use a negative lookbehind to
    // exclude `getMultiAdapterLifetimeStats(` whose default is intentional.
    const bareCalls = body.match(
      /(?<!MultiAdapter)getLifetimeStats\(\s*\)/g,
    );
    expect(bareCalls, "ctx_stats must not call getLifetimeStats() with no args").toBeNull();
    // Should pass an object literal containing `sessionsDir` (mirrors the
    // statusline contract at src/server.ts:540).
    expect(body).toMatch(/getLifetimeStats\(\s*\{\s*sessionsDir:\s*getSessionDir\(\)/);
  });
});


describe("getSessionDirSegments — sync platform → segments map", () => {
  test("returns correct segments for every supported platform", async () => {
    const { getSessionDirSegments } = await import("../../src/adapters/detect.js");
    expect(getSessionDirSegments("claude-code")).toEqual([".claude"]);
    expect(getSessionDirSegments("codex")).toEqual([".codex"]);
    expect(getSessionDirSegments("qwen-code")).toEqual([".qwen"]);
    expect(getSessionDirSegments("gemini-cli")).toEqual([".gemini"]);
    expect(getSessionDirSegments("kiro")).toEqual([".kiro"]);
    expect(getSessionDirSegments("cursor")).toEqual([".cursor"]);
    expect(getSessionDirSegments("openclaw")).toEqual([".openclaw"]);
    expect(getSessionDirSegments("vscode-copilot")).toEqual([".vscode"]);
    expect(getSessionDirSegments("antigravity")).toEqual([".gemini"]);
    expect(getSessionDirSegments("pi")).toEqual([".pi"]);
    expect(getSessionDirSegments("kilo")).toEqual([".config", "kilo"]);
    expect(getSessionDirSegments("opencode")).toEqual([".config", "opencode"]);
    expect(getSessionDirSegments("zed")).toEqual([".config", "zed"]);
    expect(getSessionDirSegments("jetbrains-copilot")).toEqual([".config", "JetBrains"]);
  });

  test("returns null for unknown platform", async () => {
    const { getSessionDirSegments } = await import("../../src/adapters/detect.js");
    expect(getSessionDirSegments("unknown")).toBeNull();
    expect(getSessionDirSegments("not-a-platform")).toBeNull();
  });
});


describe("getDefaultSessionDir uses pre-detection when adapter not yet detected", () => {
  const serverSrc = readServerSource();

  test("getDefaultSessionDir invokes detectPlatform + getSessionDirSegments before fallback", () => {
    const fn = serverSrc.match(/function getDefaultSessionDir\(\)[\s\S]*?^}/m);
    expect(fn, "getDefaultSessionDir not found in server.ts").not.toBeNull();
    const body = fn![0];
    // Pre-detection path must consult detectPlatform() and the sync segments map
    expect(body).toContain("detectPlatform");
    expect(body).toContain("getSessionDirSegments");
  });

  test("getDefaultSessionDir falls back to .claude only as last resort", () => {
    const fn = serverSrc.match(/function getDefaultSessionDir\(\)[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    // The .claude literal must still appear (last-resort fallback) but only
    // after both pre-detection branches. Verify the ordering: detectPlatform
    // call comes before the literal.
    const detectIdx = body.indexOf("detectPlatform");
    const claudeIdx = body.indexOf('".claude"');
    expect(detectIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(detectIdx).toBeLessThan(claudeIdx);
  });

  test("getDefaultSessionDir honors CODEX_HOME in the Codex pre-detection branch", () => {
    const fn = serverSrc.match(/function getDefaultSessionDir\(\)[\s\S]*?^}/m);
    expect(fn).not.toBeNull();
    const body = fn![0];
    expect(body).toContain("getSessionDirSegments(signal.platform)");
    expect(body).toContain("configDirEnvForSessionSegments(segments)");
    expect(serverSrc).toContain(
      'if (segments.length === 1 && segments[0] === ".codex") return "CODEX_HOME";',
    );
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// v1.0.134 SLICE A — cross-adapter session attribution
// CLAUDE_SESSION_ID env var is NOT propagated to MCP servers (only hooks).
// `resolveSessionIdFromSessionDB` must read the most-recent session_id from
// THIS project's session DB so chunk attribution works on every adapter
// (cursor, codex, gemini, kiro, opencode, etc.) without relying on env.
// ═══════════════════════════════════════════════════════════════════════════
describe("v1.0.134 SLICE A — cross-adapter currentAttribution session DB fallback", () => {
  test("currentAttribution falls back to session DB when CLAUDE_SESSION_ID env not set (cross-adapter)", async () => {
    const { resolveSessionIdFromSessionDB, currentAttribution } = await import(
      "../../src/server.js"
    );
    const { SessionDB, resolveSessionDbPath } = await import(
      "../../src/session/db.js"
    );

    const sessionsDir = mkdtempSync(join(tmpdir(), "slice-a-sessions-"));
    const projectDir = mkdtempSync(join(tmpdir(), "slice-a-proj-"));
    try {
      const dbPath = resolveSessionDbPath({ projectDir, sessionsDir });
      const expectedSid = "11111111-2222-3333-4444-555566667777";

      const sdb = new SessionDB({ dbPath });
      try {
        sdb.ensureSession(expectedSid, projectDir);
        sdb.insertEvent(
          expectedSid,
          {
            type: "tool_use",
            category: "file",
            priority: 1,
            data: "src/x.ts",
            project_dir: projectDir,
            attribution_source: "test",
            attribution_confidence: 1,
          },
          "test",
        );
      } finally {
        sdb.close();
      }

      // Ensure env path is NOT taken — both env vars unset.
      const prevSid = process.env.CLAUDE_SESSION_ID;
      const prevProjDir = process.env.CLAUDE_PROJECT_DIR;
      const prevCmProjDir = process.env.CONTEXT_MODE_PROJECT_DIR;
      delete process.env.CLAUDE_SESSION_ID;
      delete process.env.CLAUDE_PROJECT_DIR;
      delete process.env.CONTEXT_MODE_PROJECT_DIR;
      try {
        // bypassCache: this test runs after others may have populated the cache.
        const sid = resolveSessionIdFromSessionDB({
          projectDir,
          sessionsDir,
          bypassCache: true,
        });
        expect(sid).toBe(expectedSid);

        // currentAttribution wraps it the same way for prod callers — when the
        // env var is unset it must surface the DB-resolved sid via the
        // wrapper too. We re-set CONTEXT_MODE_PROJECT_DIR so the wrapper's
        // own (cache-bypassed by 2s window starting fresh) call also resolves.
        process.env.CONTEXT_MODE_PROJECT_DIR = projectDir;
        // Wait long enough that the previous lookup's 2s cache won't shadow
        // the wrapper's own resolveSessionIdFromSessionDB call (env-driven path).
        // Easier: bypass via a direct call shape — the wrapper just composes.
        const attr = currentAttribution();
        // Either the env-resolved path returned the same sid, or — if cache
        // beat us — at least it's not the empty/undefined case. The hard
        // assertion is the DB lookup above; here we only confirm the
        // wrapper's contract (returns { sessionId } when sid resolves).
        expect(attr?.sessionId).toBeTruthy();
      } finally {
        if (prevSid !== undefined) process.env.CLAUDE_SESSION_ID = prevSid;
        if (prevProjDir !== undefined) process.env.CLAUDE_PROJECT_DIR = prevProjDir;
        if (prevCmProjDir !== undefined) process.env.CONTEXT_MODE_PROJECT_DIR = prevCmProjDir;
        else delete process.env.CONTEXT_MODE_PROJECT_DIR;
      }
    } finally {
      try { rmSync(sessionsDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { rmSync(projectDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});


test("withProjectDirOverride carries native plugin session id into currentAttribution (#574)", async () => {
  const { withProjectDirOverride, currentAttribution } = await import("../../src/server.js");
  const projectDir = mkdtempSync(join(tmpdir(), "native-plugin-attr-proj-"));
  try {
    const attr = await withProjectDirOverride(
      { projectDir, sessionId: "opencode-session-override" },
      async () => currentAttribution(),
    );
    expect(attr).toEqual({ sessionId: "opencode-session-override" });
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
