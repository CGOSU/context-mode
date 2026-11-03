/** Hook regressions: mcp-ready. */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sentinelDir, sentinelPathForPid, isMCPReady } from "../../hooks/core/mcp-ready.mjs";
import { useMcpReadyFixture } from "./mcp-ready-fixture.js";
const { mcpSentinel } = useMcpReadyFixture();



// ─── mcp-ready.mjs regression matrix (#347 guard) ──────────────────────────
//
// PR #347 replaced the PPID-keyed sentinel lookup with a directory-scan over
// `<sentinelDir()>/context-mode-mcp-ready-*` files. These tests lock in the
// directory-scan contract so a future refactor cannot silently regress to a
// PPID-coupled lookup. The test runner's own sentinel (written by the
// file-level beforeEach above) is removed inside cleanup tests where its
// presence would mask dead-PID cleanup.

const SENTINEL_PREFIX = "context-mode-mcp-ready-";

const DEAD_PID = 2_147_483_647;
 // INT32_MAX — never a live PID on any platform

const fixtures = new Set<string>();

function createSentinel(pidOrLabel: number | string, content?: string): string {
  const path = join(sentinelDir(), `${SENTINEL_PREFIX}${pidOrLabel}`);
  writeFileSync(path, content ?? String(pidOrLabel));
  fixtures.add(path);
  return path;
}


// #844: isMCPReady() only cleans up a dead-PID sentinel once it is OLDER than
// the freshness window (a recently-refreshed sentinel may belong to a live
// server in another PID namespace). Age a sentinel past that window so the
// stale-cleanup path is exercised deterministically.
function ageSentinel(path: string): void {
  const tenMinAgoSec = Date.now() / 1000 - 600;
  utimesSync(path, tenMinAgoSec, tenMinAgoSec);
}


function hasUnrelatedLiveSentinel(): boolean {
  try {
    const dir = sentinelDir();
    for (const f of readdirSync(dir).filter((f) => f.startsWith(SENTINEL_PREFIX))) {
      try {
        const pid = parseInt(readFileSync(join(dir, f), "utf8"), 10);
        if (!Number.isNaN(pid) && pid !== process.pid) {
          process.kill(pid, 0);
          return true;
        }
      } catch { /* dead — ignore */ }
    }
    return false;
  } catch {
    return false;
  }
}

const POLLUTED = hasUnrelatedLiveSentinel();


describe("mcp-ready: contract", () => {
  afterEach(() => {
    for (const p of fixtures) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    fixtures.clear();
  });

  it("sentinelPathForPid joins sentinelDir + prefix + pid", () => {
    expect(sentinelPathForPid(12345)).toBe(join(sentinelDir(), `${SENTINEL_PREFIX}12345`));
  });

  describe("sentinelDir platform branch", () => {
    let originalPlatform: NodeJS.Platform;
    let originalEnv: string | undefined;
    beforeEach(() => {
      originalPlatform = process.platform;
      originalEnv = process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
      delete process.env.CONTEXT_MODE_MCP_SENTINEL_DIR;
    });
    afterEach(() => {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
      if (originalEnv !== undefined) {
        process.env.CONTEXT_MODE_MCP_SENTINEL_DIR = originalEnv;
      }
    });

    it("returns os.tmpdir() on win32", () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      expect(sentinelDir()).toBe(tmpdir());
    });

    it("returns /tmp on non-win32", () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      expect(sentinelDir()).toBe("/tmp");
    });
  });

  it("isMCPReady returns true when a sentinel with a live PID exists", () => {
    createSentinel(process.pid);
    expect(isMCPReady()).toBe(true);
  });

  it.each([
    ["empty payload", "test-empty-9991", ""],
    ["non-numeric payload", "test-garbage-9992", "abc"],
  ])("isMCPReady does not throw on %s sentinels", (_label, pid, content) => {
    createSentinel(pid, content);
    expect(() => isMCPReady()).not.toThrow();
  });
});


describe.skipIf(POLLUTED)("mcp-ready: stale-cleanup self-healing", () => {
  // The file-level beforeEach above writes a live sentinel at process.pid,
  // which would mask the cleanup we want to verify. Remove it here.
  beforeEach(() => {
    try { unlinkSync(mcpSentinel); } catch {}
  });

  afterEach(() => {
    for (const p of fixtures) {
      try { unlinkSync(p); } catch { /* already gone */ }
    }
    fixtures.clear();
  });

  it("unlinks a STALE sentinel whose PID is dead", () => {
    const path = createSentinel(DEAD_PID);
    ageSentinel(path);
    isMCPReady();
    expect(existsSync(path)).toBe(false);
    fixtures.delete(path);
  });

  it("unlinks two STALE dead sentinels in a single scan", () => {
    const a = createSentinel(DEAD_PID);
    const b = createSentinel(DEAD_PID - 1);
    ageSentinel(a);
    ageSentinel(b);
    expect(isMCPReady()).toBe(false);
    expect(existsSync(a)).toBe(false);
    expect(existsSync(b)).toBe(false);
    fixtures.delete(a);
    fixtures.delete(b);
  });

  // #844: a recently-refreshed sentinel must NOT be cleaned up even when its
  // PID is invisible from this namespace (shared /tmp across PID namespaces).
  it("keeps a FRESH dead/invisible-PID sentinel (#844 cross-namespace guard)", () => {
    const path = createSentinel(DEAD_PID); // mtime = now → fresh
    expect(isMCPReady()).toBe(true);
    expect(existsSync(path)).toBe(true);
    fixtures.delete(path);
    try { unlinkSync(path); } catch { /* cleanup */ }
  });

  it("in one scan: keeps the FRESH sentinel and cleans the STALE one (#844)", () => {
    const fresh = createSentinel(DEAD_PID);
    const stale = createSentinel(DEAD_PID - 1);
    ageSentinel(stale);
    expect(isMCPReady()).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    fixtures.delete(fresh);
    try { unlinkSync(fresh); } catch { /* cleanup */ }
  });
});


describe("mcp-ready: PPID-independence (regression for #347)", () => {
  it("returns true when the only live sentinel is at a child PID outside the runner's process tree", async () => {
    // Pass the resolved sentinel directory in via env var so the child does not
    // re-derive it — keeps mcp-ready.mjs as the single source of truth for the
    // path shape, and avoids node-CLI argv ambiguity with `-e`.
    const childScript = `
      const { writeFileSync, unlinkSync } = require("node:fs");
      const { join } = require("node:path");
      const dir = process.env.MCP_SENTINEL_DIR;
      const path = join(dir, "context-mode-mcp-ready-" + process.pid);
      writeFileSync(path, String(process.pid));
      const cleanup = () => { try { unlinkSync(path); } catch {} process.exit(0); };
      process.on("SIGTERM", cleanup);
      process.on("SIGINT", cleanup);
      setInterval(() => {}, 1000);
    `;
    const resolvedDir = sentinelDir();
    const child = spawn(process.execPath, ["-e", childScript], {
      stdio: "ignore",
      env: { ...process.env, MCP_SENTINEL_DIR: resolvedDir },
    });
    const childPid = child.pid!;
    const childSentinel = join(resolvedDir, `${SENTINEL_PREFIX}${childPid}`);

    try {
      // Wait up to 2s for child to write its sentinel.
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline && !existsSync(childSentinel)) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(existsSync(childSentinel)).toBe(true);

      // The regression-defining assertion: the sentinel's PID is not in the
      // test runner's process tree. A PPID-keyed lookup would return false here.
      expect(childPid).not.toBe(process.pid);
      expect(childPid).not.toBe(process.ppid);

      // Directory-scan finds the child's sentinel regardless of PPID.
      expect(isMCPReady()).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.on("exit", () => r()));
      try { unlinkSync(childSentinel); } catch { /* child cleaned up */ }
    }
  });
});
