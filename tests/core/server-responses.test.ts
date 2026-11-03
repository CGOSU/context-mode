/** Server regressions: responses. */



import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ─── Version outdated warning ────────────────────────────────────────────────

describe("Version outdated warning in trackResponse", () => {
  const serverSrc = readServerSource();

  test("fetchLatestVersion function exists and uses npm registry", () => {
    expect(serverSrc).toContain("function fetchLatestVersion");
    expect(serverSrc).toContain("registry.npmjs.org/context-mode");
  });

  test("version check fires in main() after server.connect", () => {
    const mainFn = serverSrc.slice(serverSrc.indexOf("async function main"));
    expect(mainFn).toContain("fetchLatestVersion");
  });

  test("trackResponse prepends warning when outdated", () => {
    const trackFn = serverSrc.slice(
      serverSrc.indexOf("function trackResponse"),
      serverSrc.indexOf("function trackIndexed"),
    );
    expect(trackFn).toContain("_latestVersion");
    expect(trackFn).toContain("outdated");
  });

  test("warning uses burst cadence (3 calls then silent)", () => {
    expect(serverSrc).toContain("VERSION_BURST_SIZE");
    expect(serverSrc).toContain("VERSION_SILENT_MS");
    expect(serverSrc).toContain("_warningBurstCount");
  });

  test("getUpgradeHint returns platform-specific command", () => {
    expect(serverSrc).toContain("function getUpgradeHint");
    // Claude Code gets slash command
    expect(serverSrc).toMatch(/claude.code.*ctx.upgrade|ctx.upgrade.*claude.code/i);
    // npm platforms get npm update
    expect(serverSrc).toContain("npm update -g context-mode");
    // OpenClaw gets its own command
    expect(serverSrc).toContain("npm run install:openclaw");
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// FS read instrumentation (mirrors network interceptor pattern)
// ═══════════════════════════════════════════════════════════════════════════

describe("FS read instrumentation", () => {
  const serverSrc = readServerSource();

  test("wrapper contains __CM_FS__ marker for stderr reporting", () => {
    expect(serverSrc).toContain("__CM_FS__:");
  });

  test("wrapper instruments readFileSync to count bytes", () => {
    expect(serverSrc).toContain("readFileSync");
    expect(serverSrc).toContain("__cm_fs+=");
  });

  test("wrapper instruments readFile (async) to count bytes", () => {
    expect(serverSrc).toMatch(/readFile/);
    expect(serverSrc).toContain("__cm_fs+=d.length");
  });

  test("parses __CM_FS__ from stderr and adds to bytesSandboxed", () => {
    expect(serverSrc).toContain("__CM_FS__:(\\d+)");
    expect(serverSrc).toContain("sessionStats.bytesSandboxed += parseInt(fsMatch[1])");
  });

  test("cleans __CM_FS__ marker from stderr output", () => {
    expect(serverSrc).toContain('result.stderr.replace(/\\n?__CM_FS__:\\d+\\n?/g, "")');
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// batch_execute FS read tracking via NODE_OPTIONS preload
// ═══════════════════════════════════════════════════════════════════════════

describe("batch_execute FS read tracking", () => {
  const serverSrc = readServerSource();

  test("creates CM_FS_PRELOAD temp file with FS tracking script", () => {
    expect(serverSrc).toContain("CM_FS_PRELOAD");
    expect(serverSrc).toContain("cm-fs-preload-");
    // Preload script must write __CM_FS__ marker to stderr on exit
    expect(serverSrc).toMatch(/writeFileSync\(\s*CM_FS_PRELOAD/);
  });

  test("sets NODE_OPTIONS with --require for batch commands", () => {
    expect(serverSrc).toContain("buildBatchNodeOptionsPrefix");
    expect(serverSrc).toContain("nodeOptsPrefix");
  });

  test("parses __CM_FS__ from batch output and updates bytesSandboxed", () => {
    expect(serverSrc).toContain("/__CM_FS__:(\\d+)/g");
    // Handler wires the FS-bytes callback to sessionStats; the runner strips/parses.
    expect(serverSrc).toContain("sessionStats.bytesSandboxed += bytes");
    expect(serverSrc).toContain("onFsBytes?.(cmdFsBytes)");
  });

  test("strips __CM_FS__ markers from batch command output", () => {
    expect(serverSrc).toContain('output.replace(/__CM_FS__:\\d+\\n?/g, "")');
  });

  test("cleans up preload file on shutdown", () => {
    expect(serverSrc).toContain("unlinkSync(CM_FS_PRELOAD)");
  });

  test("handler accepts concurrency input field with min/max bounds", () => {
    expect(serverSrc).toContain("concurrency: z");
    expect(serverSrc).toMatch(/\.min\(1\)\s*\n?\s*\.max\(8\)/);
    expect(serverSrc).toContain(".default(1)");
  });

  test("tool description documents the concurrency field with positive guidance", () => {
    // PR #683 / ADR-0002: emoji bullets replaced with prose. The standalone
    // CONCURRENCY: section was folded into WHEN: / WHEN NOT: prose by the
    // PR #683 WS3 canonical-structure pass so descriptions only carry the
    // four canonical sections (WHEN / WHEN NOT / RETURNS / EXAMPLE) plus
    // approved per-tool carve-outs (e.g. ctx_purge SCOPES / CONTRACT).
    // The I/O-bound vs CPU-bound split and the 4-8 speedup window are still
    // named — the PR #683 second amendment then deepened the concurrency
    // guidance (CPU-bound stays at 1, GitHub API caps at 4 to respect rate
    // limits, I/O-bound uses 4-8). This test pins the load-bearing concepts
    // (I/O-bound parallelism, the 4-8 window, the keep-at-1 rule) not the
    // exact prose so future copy-edits don't break it.
    expect(serverSrc).toMatch(/parallelize I\/O-bound (work|calls|batches)/);
    expect(serverSrc).toMatch(/4-8\s+(for I\/O-bound|I\/O-bound batches)/);
    expect(serverSrc).toContain("CPU-bound or stateful");
    expect(serverSrc).toContain("keep concurrency at 1");
  });
});


describe("getStatsFilePath: sanitize CLAUDE_SESSION_ID before path.join", () => {
  // CLAUDE_SESSION_ID flows from the hosting process straight into a
  // path.join, and path.join collapses ".." segments. CLAUDE_SESSION_ID=
  // "../../evil" would write "stats-evil.json" two levels above statsDir.
  // The env var is not under direct MCP-tool-caller control, but in CI /
  // multi-tenant contexts where the host env is partly influenceable this
  // is an arbitrary-write primitive. Reject any session id whose
  // characters aren't [A-Za-z0-9._-] and fall back to pid-based id.

  const SERVER_SOURCE = readServerSource();

  test("sanitizeSessionId exists and is called from getStatsFilePath", () => {
    expect(SERVER_SOURCE).toMatch(/const SESSION_ID_RE = \/\^\[A-Za-z0-9\._-\]\+\$\//);
    expect(SERVER_SOURCE).toContain("function sanitizeSessionId(raw: string): string {");
    const getStatsSlice = SERVER_SOURCE.slice(
      SERVER_SOURCE.indexOf("function getStatsFilePath"),
      SERVER_SOURCE.indexOf("function getStatsFilePath") + 600,
    );
    expect(getStatsSlice).toMatch(/sanitizeSessionId\(raw\)/);
    // The pre-fix direct splice of the env var into the join is gone.
    expect(getStatsSlice).not.toMatch(
      /join\(statsDir, `stats-\$\{process\.env\.CLAUDE_SESSION_ID/,
    );
  });

  test("algorithm: sanitizer rejects traversal characters and falls back to pid", () => {
    // Mirror the production sanitizer in isolation. The malicious shapes
    // must all fall through to the pid-based id; the legitimate UUID-ish
    // shape passes through unchanged.
    const SESSION_ID_RE = /^[A-Za-z0-9._-]+$/;
    const sanitize = (raw: string): string =>
      SESSION_ID_RE.test(raw) ? raw : `pid-${process.ppid}`;

    expect(sanitize("../../evil")).toMatch(/^pid-\d+$/);
    expect(sanitize("/etc/passwd")).toMatch(/^pid-\d+$/);
    expect(sanitize("a/b")).toMatch(/^pid-\d+$/);
    expect(sanitize("a\\b")).toMatch(/^pid-\d+$/);
    expect(sanitize("..\\..")).toMatch(/^pid-\d+$/);
    expect(sanitize("")).toMatch(/^pid-\d+$/);

    // Legitimate ids pass through.
    expect(sanitize("session-abc123")).toBe("session-abc123");
    expect(sanitize("pid-12345")).toBe("pid-12345");
    expect(sanitize("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(sanitize("MyHost_2024.01")).toBe("MyHost_2024.01");
  });
});
