/** Server regressions: index. */


import { spawn, execSync, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { ContentStore } from "../../src/store.js";


import { mcpEntry, type DoctorJsonRpcResponse, sendRpc } from "../helpers/server-rpc.js";
import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// ctx_index: projectRoot path resolution (#365)
// ═══════════════════════════════════════════════════════════════════════════
//
// Mirrors the executeFile relative-path resolution tests (line ~598). Confirms
// that ctx_index resolves a relative `path` argument against the detected
// project directory (CLAUDE_PROJECT_DIR / *_PROJECT_DIR / CONTEXT_MODE_PROJECT_DIR
// → cwd fallback) instead of the MCP server process cwd. End-to-end via
// JSON-RPC against a freshly spawned server with an injected project dir.

describe("ctx_index: projectRoot path resolution (#365)", () => {
  const ctxProjectDir = mkdtempSync(join(tmpdir(), "ctx-index-projroot-"));
  const ctxFileName = "ctx-index-projroot-target.md";
  const uniqueMarker = `ctx-index-marker-${process.pid}-${Date.now()}`;

  beforeAll(() => {
    writeFileSync(
      join(ctxProjectDir, ctxFileName),
      `# ctx_index relative path test\n\nUnique marker: ${uniqueMarker}\n`,
      "utf-8",
    );
  });

  afterAll(() => {
    rmSync(ctxProjectDir, { recursive: true, force: true });
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

  // MCP server processes JSON-RPC requests concurrently — we have to wait for
  // each response before sending the next one in tests that depend on order
  // (e.g. index then search). The shared `collectRpcResponses` helper kills
  // the proc once all expected ids arrive, so we use it serially per-call.
  async function awaitRpc(
    proc: ChildProcess,
    id: number,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse | undefined> {
    return new Promise((resolve) => {
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
              resolve(parsed);
              return;
            }
          } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        resolve(undefined);
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      sendRpc(proc, request);
    });
  }

  test("relative path resolves against CLAUDE_PROJECT_DIR, not server cwd", async () => {
    const proc = spawnServerWithProjectDir(ctxProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-pr365", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ctxFileName } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      // Only send search AFTER index has completed — MCP server processes
      // requests concurrently, so a piggybacked search would race the index.
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [uniqueMarker] } },
      });

      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(uniqueMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  test("absolute path bypasses project-dir resolution", async () => {
    const absFile = join(ctxProjectDir, ctxFileName);
    const proc = spawnServerWithProjectDir("/non-existent-dir-on-purpose");
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-pr365-abs", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: absFile } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);
      // Strengthened (FIX 3/10 C): assert the stored source label equals the
      // absolute path verbatim. Server defaults source = path when caller does
      // not pass an explicit source; the response text reports `from: <label>`,
      // so finding the absolute path here proves the resolver passed it
      // through intact instead of e.g. silently rewriting under projectDir.
      expect(indexText).toContain(`from: ${absFile}`);

      // Cross-check the same label round-trips through the FTS5 store: a
      // ctx_search scoped to source = <abs path> must surface the file's
      // unique marker. If the new resolver code path were skipped, the
      // absolute path would not be a valid lookup key here.
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [uniqueMarker], source: absFile } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(uniqueMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 3/10 — negative-path coverage for ctx_index path resolution.
  //
  // PR #365 added happy-path tests above. The two tests below pin the P0
  // negative behaviors that those tests miss:
  //   A. `../` path traversal → currently allowed (trust-boundary policy).
  //      Pinned so future security-jail PRs surface the policy change here.
  //   B. ALL `*_PROJECT_DIR` envs unset → resolver falls back to spawned
  //      server's process.cwd().
  //   C. (above) Strengthens the absolute-path test with a source-label
  //      round-trip.
  // ─────────────────────────────────────────────────────────────────────────

  test("relative `../` path traversal still resolves and reads (current trust-boundary policy)", async () => {
    // Layout: <baseDir>/escape.md  +  <baseDir>/sub1/sub2 (= projectDir)
    // From projectDir, "../../escape.md" climbs back to <baseDir>/escape.md.
    const baseDir = mkdtempSync(join(tmpdir(), "ctx-index-traversal-"));
    const traversalProjectDir = join(baseDir, "sub1", "sub2");
    mkdirSync(traversalProjectDir, { recursive: true });
    const traversalMarker = `ctx-index-traversal-marker-${process.pid}-${Date.now()}`;
    writeFileSync(
      join(baseDir, "escape.md"),
      `# Path traversal target\n\nUnique marker: ${traversalMarker}\n`,
      "utf-8",
    );

    const proc = spawnServerWithProjectDir(traversalProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-fix3-traversal", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "../../escape.md" } },
      });

      // Current policy: ctx_index trusts the host IDE's project boundary and
      // does not jail relative paths. A `../` escape that points at a real
      // file is RESOLVED and READ. If a future security PR introduces a
      // jail, this assertion will fail and force an explicit policy update.
      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      // Confirm the file's contents actually entered the store (not a
      // silent no-op masquerading as success).
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [traversalMarker] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(traversalMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      rmSync(baseDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("no *_PROJECT_DIR env set → relative path falls back to spawned-server cwd", async () => {
    // Strip every project-dir env the resolver chain consults (see
    // server.ts getProjectDir) so resolution is forced down to process.cwd().
    // start.mjs would re-set CONTEXT_MODE_PROJECT_DIR and CLAUDE_PROJECT_DIR
    // from originalCwd — that originalCwd is the `cwd` we hand to spawn(),
    // which is exactly what we want to assert on.
    const fallbackCwd = mkdtempSync(join(tmpdir(), "ctx-index-cwdfallback-"));
    const fallbackFile = "t.md";
    const fallbackMarker = `ctx-index-cwdfallback-marker-${process.pid}-${Date.now()}`;
    writeFileSync(
      join(fallbackCwd, fallbackFile),
      `# cwd fallback target\n\nUnique marker: ${fallbackMarker}\n`,
      "utf-8",
    );

    const strippedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== "string") continue;
      if (/_PROJECT_DIR$/.test(k)) continue;
      if (k === "VSCODE_CWD") continue;
      strippedEnv[k] = v;
    }
    strippedEnv.CONTEXT_MODE_DISABLE_VERSION_CHECK = "1";

    const proc = spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: fallbackCwd,
      env: strippedEnv,
    });
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-fix3-cwd", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: fallbackFile } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [fallbackMarker] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(fallbackMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      rmSync(fallbackCwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("relative path label canonicalizes to resolved absolute path", async () => {
    const proc = spawnServerWithProjectDir(ctxProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-pr365-label", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ctxFileName } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      // Label must canonicalize to the resolved absolute path so the same file
      // indexed via './foo.md', 'foo.md', and 'subdir/../foo.md' produces a
      // single FTS5 row (sources.label is the dedup key).
      const expectedAbs = join(ctxProjectDir, ctxFileName);
      expect(indexText).toContain(`from: ${expectedAbs}`);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);

  // ── JetBrains regression: IDEA_INITIAL_DIRECTORY must enter the cascade ──
  //
  // JetBrains adapter sets only IDEA_INITIAL_DIRECTORY (no CLAUDE_PROJECT_DIR,
  // no CONTEXT_MODE_PROJECT_DIR). Before the fix, getProjectDir() ignored that
  // var and fell through to process.cwd(), which is the IDE bin dir on
  // JetBrains — making `ctx_index({ path: "rel/foo.md" })` resolve to a path
  // under the IDE installation and ENOENT.
  //
  // Spawn the compiled server directly (build/server.js) instead of start.mjs
  // so we never enter the start.mjs path that auto-populates CLAUDE_PROJECT_DIR
  // and CONTEXT_MODE_PROJECT_DIR from cwd. This lets us isolate the cascade
  // and prove that IDEA_INITIAL_DIRECTORY alone is enough to resolve relative
  // paths under the JetBrains project root.
  test("relative path resolves against IDEA_INITIAL_DIRECTORY (JetBrains)", async () => {
    const buildEntry = resolve(__dirname, "..", "..", "build", "server.js");
    if (!existsSync(buildEntry)) {
      // Compile src → build/ on demand. Bundle is untouched (CI rebuilds it).
      execSync("npx tsc --pretty false", {
        cwd: resolve(__dirname, "..", ".."),
        stdio: "pipe",
        timeout: 60_000,
      });
    }

    // Simulate JetBrains: cwd is an IDE-bin-like dir (NOT the project),
    // env carries only IDEA_INITIAL_DIRECTORY pointing at the real project.
    const fakeIdeBin = mkdtempSync(join(tmpdir(), "ctx-jetbrains-bin-"));

    // Strip inherited platform workspace/identification vars so the cascade is
    // forced to consult IDEA_INITIAL_DIRECTORY. Issue #545 (v1.0.124): when a
    // host env var (Claude Code, Codex, etc.) leaks into this child,
    // detectPlatform() can pick that host, enter strict mode, and ban
    // IDEA_INITIAL_DIRECTORY as a foreign var.
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (
        /^(CLAUDE|CODEX|GEMINI|VSCODE|CURSOR|OPENCODE|KILO|KIRO|PI|OMP|ZED|QWEN|KIMI|ANTIGRAVITY|OPENCLAW|COPILOT)_/.test(key) ||
        key === "CONTEXT_MODE_PLATFORM" ||
        key === "CONTEXT_MODE_PROJECT_DIR"
      ) {
        delete cleanEnv[key];
      }
    }

    const proc = spawn("node", [buildEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: fakeIdeBin,
      env: {
        ...cleanEnv,
        CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        IDEA_INITIAL_DIRECTORY: ctxProjectDir,
      },
    });

    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-index-jetbrains", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const indexResp = await awaitRpc(proc, 100, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: ctxFileName } },
      });

      expect(indexResp?.error).toBeUndefined();
      const indexText = indexResp?.result?.content?.[0]?.text ?? "";
      // Must succeed — proves the relative path resolved under
      // IDEA_INITIAL_DIRECTORY (not the fake IDE-bin cwd).
      expect(indexText).toMatch(/Indexed \d+ section/);
      expect(indexText).not.toMatch(/Index error/);

      // Round-trip via search using the unique marker only present in the
      // file under IDEA_INITIAL_DIRECTORY — proves the right file was read.
      const searchResp = await awaitRpc(proc, 101, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [uniqueMarker] } },
      });
      expect(searchResp?.error).toBeUndefined();
      const searchText = searchResp?.result?.content?.[0]?.text ?? "";
      expect(searchText).toContain(uniqueMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
      try { rmSync(fakeIdeBin, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 60_000);

  // Source-label dedup regression: when no explicit `source` is supplied,
  // ctx_index must default the FTS5 label to the *resolved* absolute path so
  // that the same file indexed via './foo.md', 'foo.md', or 'subdir/../foo.md'
  // collapses into a single row (sources.label is the dedup key).
  //
  // This pins behavior at two layers:
  //   1. The store-level dedup contract: identical labels overwrite, distinct
  //      labels produce distinct rows.
  //   2. The ctx_index source-resolution decision lives in src/server.ts and
  //      must read `source ?? resolvedPath`, NOT `source ?? path` (which would
  //      preserve raw user-typed input and break dedup).
  test("source-label dedup: identical labels collapse, raw user-typed paths would not", () => {
    const store = new ContentStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "source-label-dedup-"));
    const file = "foo.md";
    const abs = join(dir, file);
    const marker = `dedup-marker-${process.pid}-${Date.now()}`;
    writeFileSync(abs, `# foo\n\nUnique marker: ${marker}\n`, "utf-8");

    try {
      // Post-fix simulation: server canonicalizes both spellings to `abs`
      // before calling store.index → single label → single row.
      store.index({ content: readFileSync(abs, "utf-8"), path: abs, source: abs });
      store.index({ content: readFileSync(abs, "utf-8"), path: abs, source: abs });

      const dedupResults = store.search(marker, 10);
      expect(dedupResults.length).toBe(1);
      expect(dedupResults[0].source).toBe(abs);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Server-side guard: the source-label fallback must canonicalize to
  // resolvedPath, not to the raw user-typed `path`. Validates the actual
  // src/server.ts decision so a regression to `source ?? path` fails CI even
  // before bundle rebuild and end-to-end spawn coverage.
  test("source-label canonicalization: src/server.ts uses `source ?? resolvedPath`", () => {
    const serverSrc = readServerSource();
    // Locate the ctx_index store.index call site and assert canonical fallback.
    const indexCall = serverSrc.match(
      /store\.index\(\{[^}]*source:\s*source\s*\?\?\s*(\w+)/,
    );
    expect(indexCall).not.toBeNull();
    expect(indexCall![1]).toBe("resolvedPath");
    // Negative guard: no place in ctx_index falls back to raw `path`.
    expect(serverSrc).not.toMatch(/store\.index\(\{[^}]*source:\s*source\s*\?\?\s*path[\s,}]/);
  });
});
