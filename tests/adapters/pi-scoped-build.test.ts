import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "../..");

describe("isolated Pi runtime build", () => {
  it.each([
    ["--server-only", "server.bundle.mjs", "build/adapters/pi/extension.js"],
    ["--extension-only", "build/adapters/pi/extension.js", "server.bundle.mjs"],
  ])("preserves the shared %s build consumer", (mode, present, absent) => {
    const outdir = mkdtempSync(join(tmpdir(), "ctx-pi-partial-"));
    try {
      const result = spawnSync(process.execPath, ["scripts/build-pi.mjs", mode, "--outdir", outdir], { cwd: root, encoding: "utf8", timeout: 30000 });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(outdir, present))).toBe(true);
      expect(existsSync(join(outdir, absent))).toBe(false);
    } finally { rmSync(outdir, { recursive: true, force: true }); }
  });

  it.each([["--unknown"], ["--outdir"], ["--server-only", "--extension-only"]])("rejects invalid build options %j", (...args) => {
    const result = spawnSync(process.execPath, ["scripts/build-pi.mjs", ...args], { cwd: root, encoding: "utf8", timeout: 10000 });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Unknown build option|requires a directory|at most one partial/);
  });

  it("builds from source and runs the real extension/bridge without other generated entries", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "ctx-pi-build-"));
    const runtime = join(sandbox, "runtime");
    const home = join(sandbox, "home");
    const workspace = join(sandbox, "workspace");
    try {
      mkdirSync(home); mkdirSync(workspace);
      const built = spawnSync(process.execPath, ["scripts/build-pi.mjs", "--outdir", runtime], { cwd: root, encoding: "utf8", timeout: 30000 });
      expect(built.status, built.stderr).toBe(0);
      // Runtime packages remain normal installed dependencies, not bundled copies.
      symlinkSync(join(root, "node_modules"), join(runtime, "node_modules"), "dir");
      writeFileSync(join(runtime, "package.json"), JSON.stringify({ type: "module", version: "1.0.0" }));
      expect(existsSync(join(runtime, "cli.bundle.mjs"))).toBe(false);
      expect(existsSync(join(runtime, "hooks/session-db.bundle.mjs"))).toBe(false);
      const probe = join(sandbox, "probe.mjs");
      writeFileSync(probe, `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { default: extension } = await import(pathToFileURL(process.argv[2]));
const hooks = new Map(), tools = new Map();
const pi = {
 on: (name, callback) => hooks.set(name, callback),
 registerCommand() {},
 registerTool: tool => tools.set(tool.name, tool),
 getActiveTools: () => ['codemode'],
 getAllTools: () => [{name: 'codemode', reachesTools: () => 'all'}],
};
const start = performance.now();
extension(pi);
const ctx = {hasUI: false, sessionManager: {getSessionFile: () => process.env.HOME + '/session.jsonl'}};
try {
 await hooks.get('session_start')({}, ctx);
 await hooks.get('before_agent_start')({prompt: 'Check isolated Pi build', systemPrompt: ''}, ctx);
 const startupMs = performance.now() - start;
 assert.equal(tools.size, 11);
 assert.equal([...tools.values()].filter(t => t.exposure === 'deferred').length, 5);
 assert.equal([...tools.values()].filter(t => t.exposure === 'direct').length, 6);
 for (const tool of tools.values()) assert.ok(tool.description.length < 600, tool.name);
 const call = async (name, params) => (await tools.get(name).execute('probe', params)).content[0].text;
 assert.match(await call('ctx_execute', {language: 'javascript', code: 'console.log("pi-build-ok")'}), /pi-build-ok/);
 await assert.rejects(() => call('ctx_execute', {language: 'unsupported', code: ''}));
 const failed = await call('ctx_execute', {language: 'javascript', code: 'throw new Error("pi-build-failure")'}).catch(e => e.message);
 assert.match(failed, /pi-build-failure/);
 await call('ctx_index', {content: 'The zephyrwidget registry uses cobalt routing for isolated builds.', source: 'pi-build-probe'});
 assert.match(await call('ctx_search', {queries: ['zephyrwidget cobalt'], source: 'pi-build-probe'}), /zephyrwidget/);
 console.log(JSON.stringify({startupMs, tools: tools.size, direct: 6, deferred: 5, execution: 'ok', failure: 'reported', search: 'ok'}));
} finally { await hooks.get('session_shutdown')(); }
`);
      const run = spawnSync(process.execPath, [probe, join(runtime, "build/adapters/pi/extension.js")], {
        cwd: workspace, encoding: "utf8", timeout: 40000,
        env: { PATH: process.env.PATH, HOME: home, TMPDIR: sandbox, PI_WORKSPACE_DIR: workspace, PWD: workspace, CONTEXT_MODE_PLATFORM: "pi" },
      });
      expect(run.status, run.stdout + run.stderr + String(run.error ?? "")).toBe(0);
      const result = JSON.parse(run.stdout.trim());
      expect(result).toMatchObject({ tools: 11, execution: "ok", failure: "reported", search: "ok" });
      console.log("Pi isolated runtime probe:", JSON.stringify(result));
    } finally { rmSync(sandbox, { recursive: true, force: true }); }
  }, 80000);
});
