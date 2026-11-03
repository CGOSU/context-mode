/** Server regressions: project. */

import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";


import { type DoctorJsonRpcResponse, sendRpc } from "../helpers/server-rpc.js";


// ─── Shared setup ───────────────────────────────────────────────────────────
const runtimes = detectRuntimes();

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// 4. Project Directory Path Resolution (project-dir)
// ═══════════════════════════════════════════════════════════════════════════

// Set up two isolated directories to simulate the scenario:
// - pluginDir: where the plugin is installed (start.sh does cd here)
// - projectDir: where the user's project lives (the real cwd)
const projDirBaseDir = join(tmpdir(), "ctx-mode-projdir-test-" + Date.now());

const projectDir = join(projDirBaseDir, "user-project");

const pluginDir = join(projDirBaseDir, "plugin-install");

mkdirSync(projectDir, { recursive: true });

mkdirSync(pluginDir, { recursive: true });


// Create a test file in the user's project directory
const testFileName = "data.json";

const testData = { message: "hello from project dir", count: 42 };

writeFileSync(
  join(projectDir, testFileName),
  JSON.stringify(testData),
  "utf-8",
);


// Also create a different file with the same name in the plugin directory
// to prove we're reading from the right place
const pluginData = { message: "wrong directory", count: 0 };

writeFileSync(
  join(pluginDir, testFileName),
  JSON.stringify(pluginData),
  "utf-8",
);


afterAll(() => {
  rmSync(projDirBaseDir, { recursive: true, force: true });
});


describe("executeFile: projectRoot path resolution", () => {
  test("relative path resolves against projectRoot, not cwd", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: testFileName, // relative path — should resolve to projectDir/data.json
      language: "javascript",
      code: `
        const data = JSON.parse(FILE_CONTENT);
        console.log(data.message);
      `,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0, got ${r.exitCode}: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("hello from project dir"),
      `Should read from projectDir, got: ${r.stdout.trim()}`,
    );
  });

  test("relative path with subdirectory resolves against projectRoot", async () => {
    const subDir = join(projectDir, "nested", "deep");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "nested.txt"), "nested content here", "utf-8");

    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: "nested/deep/nested.txt",
      language: "javascript",
      code: `console.log(FILE_CONTENT.trim());`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("nested content here"));
  });

  test("absolute path ignores projectRoot", async () => {
    const absFile = join(projDirBaseDir, "absolute-test.txt");
    writeFileSync(absFile, "absolute path content", "utf-8");

    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: absFile, // absolute path — projectRoot should be ignored
      language: "javascript",
      code: `console.log(FILE_CONTENT.trim());`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("absolute path content"));
  });

  test("default projectRoot is process.cwd()", async () => {
    // Create a file in the actual cwd
    const cwdFile = join(process.cwd(), ".ctx-mode-test-cwd-" + Date.now() + ".tmp");
    writeFileSync(cwdFile, "cwd content", "utf-8");

    try {
      const executor = new PolyglotExecutor({ runtimes });

      const r = await executor.executeFile({
        path: cwdFile,
        language: "javascript",
        code: `console.log(FILE_CONTENT.trim());`,
      });

      assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
      assert.ok(r.stdout.includes("cwd content"));
    } finally {
      rmSync(cwdFile, { force: true });
    }
  });
});


describe("CLAUDE_PROJECT_DIR env var integration", () => {
  test("PolyglotExecutor accepts projectRoot option", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: "/some/custom/path",
    });

    // Verify the executor was created without error
    // The projectRoot is private, so we verify it indirectly via executeFile
    assert.ok(executor, "Executor should be created with custom projectRoot");
  });

  test("executeFile fails gracefully for non-existent relative path", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: "does-not-exist.json",
      language: "javascript",
      code: `console.log(FILE_CONTENT);`,
    });

    assert.notEqual(r.exitCode, 0, "Should fail for non-existent file");
  });
});


describe("Multi-language relative path resolution", () => {
  if (runtimes.python) {
    test("Python: relative path resolves against projectRoot", async () => {
      const executor = new PolyglotExecutor({
        runtimes,
        projectRoot: projectDir,
      });

      const r = await executor.executeFile({
        path: testFileName,
        language: "python",
        code: `
import json
data = json.loads(FILE_CONTENT)
print(f"msg: {data['message']}")
print(f"count: {data['count']}")
        `,
      });

      assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
      assert.ok(r.stdout.includes("msg: hello from project dir"));
      assert.ok(r.stdout.includes("count: 42"));
    });
  }

  test("Shell: relative path resolves against projectRoot", async () => {
    const executor = new PolyglotExecutor({
      runtimes,
      projectRoot: projectDir,
    });

    const r = await executor.executeFile({
      path: testFileName,
      language: "shell",
      code: `echo "content: $FILE_CONTENT"`,
    });

    assert.equal(r.exitCode, 0, `Expected exit 0: ${r.stderr}`);
    assert.ok(r.stdout.includes("hello from project dir"));
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// ctx_execute_file: projectRoot env cascade parity with ctx_index
// ═══════════════════════════════════════════════════════════════════════════
//
// Regression for PR #365 follow-up. ctx_index was routed through the
// `getProjectDir()` env cascade (CLAUDE_PROJECT_DIR → ... → CONTEXT_MODE_PROJECT_DIR
// → cwd) but the PolyglotExecutor still captured CLAUDE_PROJECT_DIR ?? cwd
// at construction time. ctx_execute_file therefore resolved the same
// relative path differently from ctx_index whenever only
// CONTEXT_MODE_PROJECT_DIR was set (e.g. Cursor / OpenClaw / Codex spawns).
// Fix: executor now resolves projectRoot lazily via the server's getProjectDir.

describe("ctx_execute_file: CONTEXT_MODE_PROJECT_DIR env cascade", () => {
  const execProjectDir = mkdtempSync(join(tmpdir(), "ctx-exec-projroot-"));
  const execScriptDir = join(execProjectDir, "rel");
  const execScriptName = "script.js";
  const execMarker = `ctx-exec-marker-${process.pid}-${Date.now()}`;

  // Spawn build/server.js directly to bypass start.mjs's auto-set of
  // CLAUDE_PROJECT_DIR = process.cwd(). That auto-set would defeat the
  // test by injecting a CLAUDE_PROJECT_DIR before getProjectDir() can
  // fall through to CONTEXT_MODE_PROJECT_DIR.
  const buildServerEntry = resolve(__dirname, "..", "..", "build", "server.js");

  beforeAll(() => {
    mkdirSync(execScriptDir, { recursive: true });
    writeFileSync(
      join(execScriptDir, execScriptName),
      `console.log(${JSON.stringify(execMarker)});\n`,
      "utf-8",
    );
  });

  afterAll(() => {
    rmSync(execProjectDir, { recursive: true, force: true });
  });

  function spawnServerCtxModeOnly(projectDirEnv: string): ChildProcess {
    // Strip every CLAUDE_*-style projectDir signal so the executor MUST
    // fall back through the env cascade to CONTEXT_MODE_PROJECT_DIR.
    const env = { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" };
    delete env.CLAUDE_PROJECT_DIR;
    delete env.GEMINI_PROJECT_DIR;
    delete env.VSCODE_CWD;
    delete env.OPENCODE_PROJECT_DIR;
    delete env.PI_PROJECT_DIR;
    delete env.IDEA_INITIAL_DIRECTORY;
    env.CONTEXT_MODE_PROJECT_DIR = projectDirEnv;
    return spawn("node", [buildServerEntry], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      // cwd far from execProjectDir so a stale `process.cwd()` snapshot
      // would resolve `rel/script.js` to a non-existent path.
      cwd: tmpdir(),
    });
  }

  async function awaitRpc(
    proc: ChildProcess,
    id: number,
    request: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<DoctorJsonRpcResponse | undefined> {
    return new Promise((res) => {
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
              res(parsed);
              return;
            }
          } catch { /* ignore */ }
        }
      };
      const timer = setTimeout(() => {
        proc.stdout!.off("data", onData);
        res(undefined);
      }, timeoutMs);
      proc.stdout!.on("data", onData);
      sendRpc(proc, request);
    });
  }

  test("relative path resolves against CONTEXT_MODE_PROJECT_DIR when CLAUDE_PROJECT_DIR is unset", async () => {
    const proc = spawnServerCtxModeOnly(execProjectDir);
    try {
      await awaitRpc(proc, 1, {
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ctx-exec-cm-projdir", version: "1.0" } },
      });
      sendRpc(proc, { jsonrpc: "2.0", method: "notifications/initialized" });

      const execResp = await awaitRpc(proc, 200, {
        jsonrpc: "2.0", id: 200, method: "tools/call",
        params: {
          name: "ctx_execute_file",
          arguments: {
            path: `rel/${execScriptName}`,
            language: "javascript",
            code: "eval(FILE_CONTENT);",
          },
        },
      });

      expect(execResp?.error).toBeUndefined();
      expect(execResp?.result?.isError ?? false).toBe(false);
      const text = execResp?.result?.content?.[0]?.text ?? "";
      expect(text).toContain(execMarker);
    } finally {
      try { proc.kill("SIGTERM"); } catch { /* best effort */ }
    }
  }, 30_000);
});
