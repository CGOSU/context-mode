/** Server regressions: policy. */


import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect } from "vitest";


import { mcpEntry, type DoctorJsonRpcResponse, sendRpc } from "../helpers/server-rpc.js";


// ═══════════════════════════════════════════════════════════════════════════
// ctx_index: Read deny-policy enforcement (#442)
// ═══════════════════════════════════════════════════════════════════════════
//
// Real-MCP integration test: ctx_execute_file calls checkFilePathDenyPolicy
// before reading the file, but ctx_index historically skipped the check —
// any file readable by the MCP server process could be indexed into FTS5
// and exfiltrated through ctx_search. This pins the fix end-to-end via
// JSON-RPC against a freshly spawned server with .claude/settings.json
// containing a Read deny pattern matching the target file.

describe("ctx_index: Read deny-policy enforcement (#442)", () => {
  // Per-test projectDir prevents FTS5 cross-pollution between tests and
  // removes order-coupling on the empty-store cross-check.
  function setupProject(
    denyRules: string[],
    files: Record<string, string>,
  ): string {
    const dir = mkdtempSync(join(tmpdir(), "ctx-index-deny-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: denyRules } }),
      "utf-8",
    );
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content, "utf-8");
    }
    return dir;
  }

  function spawnServerInProject(
    projectDir: string,
    extraEnv: Record<string, string> = {},
  ): ChildProcess {
    return spawn("node", [mcpEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
        CLAUDE_PROJECT_DIR: projectDir,
        ...extraEnv,
      },
    });
  }

  // Rejects on timeout (rather than resolving undefined) so silent
  // server-spawn / import failures surface as a failing test instead of
  // false-positive assertions on optional-chained undefined access.
  async function awaitRpc(
    proc: ChildProcess,
    request: Record<string, unknown> & { id: number },
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse> {
    const id = request.id;
    return new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";
      const onStderr = (d: Buffer) => { stderr += d.toString(); };
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
              proc.stderr!.off("data", onStderr);
              clearTimeout(timer);
              resolve(parsed);
              return;
            }
          } catch { /* not JSON-RPC line */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        proc.stderr!.off("data", onStderr);
        reject(new Error(
          `awaitRpc timeout after ${timeoutMs}ms for id=${id} method=${request.method}\n` +
          `stderr: ${stderr.slice(-2000)}`,
        ));
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      proc.stderr!.on("data", onStderr);
      sendRpc(proc, request);
    });
  }

  async function initServer(proc: ChildProcess, clientName: string): Promise<void> {
    await awaitRpc(proc, {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: clientName, version: "1.0" } },
    });
    sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });
  }

  function killProc(proc: ChildProcess): void {
    try { proc.kill("SIGTERM"); } catch { /* best effort */ }
  }

  test("ctx_index({ path: <denied> }) returns deny-policy error and never indexes", async () => {
    const secretMarker = `secret-marker-${process.pid}-${Date.now()}`;
    const projectDir = setupProject(
      ["Read(./secret.env)", "Read(secret.env)"],
      { "secret.env": `SECRET_TOKEN=${secretMarker}\n` },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-442");

      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "secret.env" } },
      });

      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBe(true);
      const indexText = indexResp.result?.content?.[0]?.text ?? "";
      expect(indexText).toContain("blocked by security policy");
      expect(indexText).toContain("Read deny pattern");
      // Pin the matched pattern so a future bug firing the wrong rule
      // cannot pass on the generic substring alone.
      expect(indexText).toMatch(/Read deny pattern \.?\/?secret\.env/);
      expect(indexText).not.toMatch(/Indexed \d+ section/);

      // Per-test projectDir guarantees an empty FTS5 store, so the secret
      // marker absence is the load-bearing exfil-prevention pin.
      const searchResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [secretMarker] } },
      });
      expect(searchResp.error).toBeUndefined();
      const searchText = searchResp.result?.content?.[0]?.text ?? "";
      const searchedEmpty =
        searchText.includes("No results found") ||
        searchText.includes("After indexing");
      expect(searchedEmpty).toBe(true);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <denied via glob *.env> }) blocks", async () => {
    const projectDir = setupProject(
      ["Read(*.env)"],
      { "secret.env": `SECRET_TOKEN=glob-${process.pid}\n` },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-glob-442");
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "secret.env" } },
      });
      expect(indexResp.result?.isError).toBe(true);
      const text = indexResp.result?.content?.[0]?.text ?? "";
      expect(text).toContain("blocked by security policy");
      expect(text).toMatch(/Read deny pattern .*\*\.env/);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <absolute denied> }) blocks", async () => {
    const projectDir = setupProject(
      [], // populated below after we know absolute path
      { "secret.env": `SECRET_TOKEN=abs-${process.pid}\n` },
    );
    const absSecret = join(projectDir, "secret.env");
    // Rewrite settings.json with the absolute deny rule.
    writeFileSync(
      join(projectDir, ".claude", "settings.json"),
      JSON.stringify({ permissions: { deny: [`Read(${absSecret})`] } }),
      "utf-8",
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-abs-442");
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: absSecret } },
      });
      expect(indexResp.result?.isError).toBe(true);
      const text = indexResp.result?.content?.[0]?.text ?? "";
      expect(text).toContain("blocked by security policy");
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <denied via ../traversal> }) blocks", async () => {
    // Use a glob deny rule that matches the canonical (lexical/realpath)
    // form — proves evaluateFilePath's canonicalization defeats the
    // `sub/../secret.env` traversal trick.
    const projectDir = setupProject(
      ["Read(**/secret.env)"],
      {
        "secret.env": `SECRET_TOKEN=trav-${process.pid}\n`,
        "sub/placeholder.md": "# placeholder\n",
      },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-deny-trav-442");
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "sub/../secret.env" } },
      });
      expect(indexResp.result?.isError).toBe(true);
      const text = indexResp.result?.content?.[0]?.text ?? "";
      expect(text).toContain("blocked by security policy");
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ path: <allowed> }) succeeds and is searchable", async () => {
    const allowedMarker = `allowed-marker-${process.pid}-${Date.now()}`;
    const projectDir = setupProject(
      ["Read(./secret.env)", "Read(secret.env)"],
      { "public-doc.md": `# Public doc\n\n${allowedMarker}\n` },
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-allow-442");

      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "public-doc.md" } },
      });
      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBeFalsy();
      const indexText = indexResp.result?.content?.[0]?.text ?? "";
      expect(indexText).toMatch(/Indexed \d+ section/);

      const searchResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 101, method: "tools/call",
        params: { name: "ctx_search", arguments: { queries: [allowedMarker] } },
      });
      expect(searchResp.error).toBeUndefined();
      expect(searchResp.result?.content?.[0]?.text ?? "").toContain(allowedMarker);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index({ content: ... }) bypass branch — gate truly tied to `path`", async () => {
    // Configure a deny rule that WOULD match the inline `source` value if
    // the gate naively ran on it. Success here proves the bypass is keyed
    // on `path` absence, not on `source`.
    const projectDir = setupProject(
      ["Read(test-inline)", "Read(./test-inline)"],
      {},
    );
    const proc = spawnServerInProject(projectDir);
    try {
      await initServer(proc, "ctx-index-content-442");
      const inlineMarker = `inline-marker-${process.pid}-${Date.now()}`;
      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0", id: 100, method: "tools/call",
        params: {
          name: "ctx_index",
          arguments: {
            content: `# Inline\n\n${inlineMarker}\n`,
            source: "test-inline",
          },
        },
      });
      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBeFalsy();
      expect(indexResp.result?.content?.[0]?.text ?? "").toMatch(/Indexed \d+ section/);
    } finally {
      killProc(proc);
      rmSync(projectDir, { recursive: true, force: true });
    }
  }, 30_000);

  test("ctx_index returns an actionable storage error when CONTEXT_MODE_DIR is unwritable", async () => {
    if (process.platform === "win32") return;

    const projectDir = setupProject([], {
      "public-doc.md": "storage failure contract",
    });
    const storageRoot = mkdtempSync(join(tmpdir(), "ctx-storage-deny-"));
    chmodSync(storageRoot, 0o500);
    const proc = spawnServerInProject(projectDir, {
      CONTEXT_MODE_DIR: storageRoot,
    });

    try {
      await initServer(proc, "ctx-index-storage-error");

      const indexResp = await awaitRpc(proc, {
        jsonrpc: "2.0",
        id: 103,
        method: "tools/call",
        params: { name: "ctx_index", arguments: { path: "public-doc.md" } },
      });

      expect(indexResp.error).toBeUndefined();
      expect(indexResp.result?.isError).toBe(true);
      expect(indexResp.result?.content?.[0]?.text).toContain(
        "context-mode content directory is not writable:",
      );
      expect(indexResp.result?.content?.[0]?.text).toContain(
        "Set CONTEXT_MODE_DIR to a writable absolute path.",
      );
    } finally {
      killProc(proc);
      chmodSync(storageRoot, 0o700);
      rmSync(storageRoot, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
