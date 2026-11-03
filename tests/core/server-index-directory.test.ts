/** ctx_index directory traversal and symlink-boundary regressions. */
/** Server regressions: index. */


import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, test, expect, afterAll } from "vitest";

import { mcpEntry, type DoctorJsonRpcResponse, sendRpc } from "../helpers/server-rpc.js";
import { readServerSource } from "../helpers/server-source.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
// ═══════════════════════════════════════════════════════════════════════════
// 3. Turndown HTML-to-markdown conversion
// ═══════════════════════════════════════════════════════════════════════════

// Resolve turndown path the same way server.ts will
const require = createRequire(import.meta.url);




// ═══════════════════════════════════════════════════════════════════════════
// ctx_index: directory path support (#687)
// ═══════════════════════════════════════════════════════════════════════════
//
// Reported by @matiasduartee in #687: passing a directory path to ctx_index
// surfaces `refusing to index <path>: not a regular file` from the security
// gate at src/store.ts:845. The gate is correct and stays — directory support
// is added as a separate concern via `ContentStore.indexDirectory()` dispatched
// at the server handler, with each discovered file going through the existing
// per-file `openSync + fstatSync.isFile()` invariant.
//
// Cross-OS — repro spanned macOS + Windows 11 across 4 clients.

describe("ctx_index: directory path support (#687)", () => {
  const baseDir = mkdtempSync(join(tmpdir(), "ctx-index-dir-687-"));

  function makeProjectDir(name: string): string {
    const dir = join(baseDir, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  afterAll(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  function spawnServerWithProjectDir(projectDirEnv: string): ChildProcess {
    return spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        CLAUDE_PROJECT_DIR: projectDirEnv,
      },
    });
  }

  async function awaitRpc(
    proc: ChildProcess,
    id: number,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse | undefined> {
    return new Promise((resolveProm) => {
      let buffer = "";
      const onData = (d: Buffer) => {
        buffer += d.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const parsed = JSON.parse(line) as DoctorJsonRpcResponse;
            if (parsed.id === id) {
              proc.stdout!.off("data", onData);
              clearTimeout(timer);
              resolveProm(parsed);
              return;
            }
          } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        resolveProm(undefined);
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      sendRpc(proc, request);
    });
  }

  async function initialize(proc: ChildProcess, suffix: string): Promise<void> {
    await awaitRpc(proc, 1, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: `ctx-index-dir-${suffix}`, version: "1.0" } },
    });
    sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  test("file path still indexes (backwards-compat control)", async () => {
    const projectDir = makeProjectDir("compat");
    writeFileSync(join(projectDir, "doc.md"), "# Doc\n\nbody\n");
    const proc = spawnServerWithProjectDir(projectDir);
    try {
      await initialize(proc, "compat");
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "doc.md" } },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";
      expect(text).toMatch(/Indexed \d+ section/);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("directory with 3 .md files indexes all 3", async () => {
    const projectDir = makeProjectDir("happy");
    const docs = join(projectDir, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, "a.md"), "# A\n\nalpha-687\n");
    writeFileSync(join(docs, "b.md"), "# B\n\nbeta-687\n");
    writeFileSync(join(docs, "c.md"), "# C\n\ngamma-687\n");
    const proc = spawnServerWithProjectDir(projectDir);
    try {
      await initialize(proc, "happy");
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "docs" } },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";
      // Response must report directory indexing — 3 files.
      expect(text).toMatch(/3 file/i);
      expect(text).not.toMatch(/not a regular file/);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("empty directory returns 0-files response, not error", async () => {
    const projectDir = makeProjectDir("empty");
    const empty = join(projectDir, "empty");
    mkdirSync(empty);
    const proc = spawnServerWithProjectDir(projectDir);
    try {
      await initialize(proc, "empty");
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "empty" } },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";
      expect(resp?.result?.isError).not.toBe(true);
      expect(text).toMatch(/0 file/i);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("nested directory respects maxDepth", async () => {
    const projectDir = makeProjectDir("depth");
    mkdirSync(join(projectDir, "lvl1", "lvl2", "lvl3"), { recursive: true });
    writeFileSync(join(projectDir, "root.md"), "# root\n");
    writeFileSync(join(projectDir, "lvl1", "one.md"), "# one\n");
    writeFileSync(join(projectDir, "lvl1", "lvl2", "two.md"), "# two\n");
    writeFileSync(join(projectDir, "lvl1", "lvl2", "lvl3", "three.md"), "# three\n");
    const proc = spawnServerWithProjectDir(projectDir);
    try {
      await initialize(proc, "depth");
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ".", maxDepth: 1 } },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";
      // maxDepth 1: root.md + one.md = 2 files (lvl2/* and lvl3/* excluded).
      expect(text).toMatch(/2 file/i);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("respects default exclude patterns (node_modules, .git skip)", async () => {
    const projectDir = makeProjectDir("excl");
    mkdirSync(join(projectDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(projectDir, ".git"), { recursive: true });
    writeFileSync(join(projectDir, "real.md"), "# real\n");
    writeFileSync(join(projectDir, "node_modules", "pkg", "junk.md"), "# junk\n");
    writeFileSync(join(projectDir, ".git", "config.md"), "# git\n");
    const proc = spawnServerWithProjectDir(projectDir);
    try {
      await initialize(proc, "excl");
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "." } },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";
      // Only real.md indexed.
      expect(text).toMatch(/1 file/i);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("respects maxFiles cap (50 fixtures, request 10)", async () => {
    const projectDir = makeProjectDir("cap");
    const fixtures = join(projectDir, "fx");
    mkdirSync(fixtures);
    for (let i = 0; i < 50; i++) {
      writeFileSync(join(fixtures, `f${i}.md`), `# file ${i}\n`);
    }
    const proc = spawnServerWithProjectDir(projectDir);
    try {
      await initialize(proc, "cap");
      const resp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "fx", maxFiles: 10 } },
      });
      expect(resp?.error).toBeUndefined();
      const text = resp?.result?.content?.[0]?.text ?? "";
      // Cap notice in response (architect FTS5-blowup guard).
      expect(text).toMatch(/10 file/i);
      expect(text).toMatch(/cap|limit|max/i);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);
});



describe("ctx_index: root-level symlink defense in directory dispatch", () => {
  // The directory-dispatch branch used statSync to decide whether to walk
  // a path as a directory. statSync follows symlinks, so a path like
  // `/tmp/link -> /etc` reported as a directory and walkDirectoryDetailed
  // then realpathSync'd internally and indexed /etc. The deny-glob check
  // at the head of the handler had run against `/tmp/link`, not /etc, so a
  // user whose deny globs include /etc but not /tmp would still see /etc
  // contents land in the FTS5 store. Fix: detect root-level symlinks with
  // lstatSync, realpath them once, and re-apply the deny check against
  // the actual walk target before dispatching.

  const SERVER_SOURCE = readServerSource();

  test("ctx_index handler lstats and re-deny-checks symlinks before directory dispatch", () => {
    const dispatchBlock = SERVER_SOURCE.match(
      /Root-level symlink defense[\s\S]*?if \(resolvedPath && existsSync\(resolvedPath\) && statSync\(resolvedPath\)\.isDirectory\(\)\)/,
    );
    expect(dispatchBlock).not.toBeNull();
    const block = dispatchBlock![0];
    expect(block).toMatch(/const lst = lstatSync\(resolvedPath\);/);
    expect(block).toMatch(/lst\.isSymbolicLink\(\)/);
    expect(block).toMatch(/realpathSync\(resolvedPath\)/);
    expect(block).toMatch(
      /const realDenied = checkFilePathDenyPolicy\(realTarget, "ctx_index"\);/,
    );
    expect(block).toMatch(/if \(realDenied\) return realDenied;/);
    expect(SERVER_SOURCE).toMatch(
      /import\s*\{[^}]*\brealpathSync\b[^}]*\}\s*from\s*"node:fs"/,
    );
  });

  test("algorithm: lstatSync + realpath identifies a symlinked directory whose target differs", () => {
    // The behavior the fix depends on: lstatSync on a symlink reports
    // isSymbolicLink()=true and isDirectory()=false. realpathSync resolves
    // to the target. statSync, by contrast, would report isDirectory()=true
    // and silently follow -- the pre-fix dispatch relied on that.
    const base = mkdtempSync(join(tmpdir(), "ctx-index-symlink-defense-"));
    try {
      const realDir = join(base, "real");
      const linkPath = join(base, "link");
      mkdirSync(realDir, { recursive: true });
      writeFileSync(join(realDir, "marker.txt"), "real");

      const fsLocal = require("node:fs") as typeof import("node:fs");
      // "junction" on Windows so the test works without admin / Developer
      // Mode; lstatSync still reports isSymbolicLink()===true for junctions,
      // which is what the algorithm-under-test depends on.
      const symlinkType = process.platform === "win32" ? "junction" : "dir";
      fsLocal.symlinkSync(realDir, linkPath, symlinkType);

      const lst = fsLocal.lstatSync(linkPath);
      expect(lst.isSymbolicLink()).toBe(true);
      expect(lst.isDirectory()).toBe(false);
      expect(fsLocal.statSync(linkPath).isDirectory()).toBe(true);

      const real = fsLocal.realpathSync(linkPath);
      expect(real).not.toBe(linkPath);
      expect(real).toBe(fsLocal.realpathSync(realDir));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
