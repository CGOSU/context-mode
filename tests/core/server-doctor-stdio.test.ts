/** Server regressions: doctor-stdio. */


import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test, expect, afterAll } from "vitest";


import { startMcpServer, initAndCallDoctor } from "../helpers/server-rpc.js";
import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const storageRoots: string[] = [];
afterAll(() => {
  for (const root of storageRoots) rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});


describe("ctx_doctor — resource cleanup regression (#247)", () => {
  test("single ctx_doctor call returns a status report", async () => {
    const proc = startMcpServer();
    const responses = await initAndCallDoctor(proc, 1);
    const call = responses.find((r) => r.id === 100);
    expect(call).toBeDefined();
    expect(call!.error).toBeUndefined();
    const text = call!.result?.content?.[0]?.text ?? "";
    expect(text).toContain("context-mode doctor");
    expect(text).toMatch(/Server test:/);
    expect(text).toMatch(/FTS5 \/ SQLite:/);
  }, 30_000);

  test("ctx_doctor reports storage roots and ignored empty override", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "ctx-doctor-storage-"));
    storageRoots.push(storageRoot);
    const proc = startMcpServer({ CONTEXT_MODE_DIR: " \t ", HOME: storageRoot, USERPROFILE: storageRoot });
    const responses = await initAndCallDoctor(proc, 1);
    const call = responses.find((r) => r.id === 100);

    expect(call).toBeDefined();
    expect(call!.error).toBeUndefined();
    const text = call!.result?.content?.[0]?.text ?? "";
    expect(text).toContain("Storage sessions:");
    expect(text).toContain("Storage content:");
    expect(text).toContain("Storage stats:");
    expect(text).toContain("(default; ignored empty CONTEXT_MODE_DIR)");
  }, 30_000);

  test("ctx_doctor reports storage root override source", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "ctx-doctor-storage-root-"));
    storageRoots.push(storageRoot);
    const proc = startMcpServer({ CONTEXT_MODE_DIR: storageRoot });
    const responses = await initAndCallDoctor(proc, 1);
    const call = responses.find((r) => r.id === 100);

    expect(call).toBeDefined();
    expect(call!.error).toBeUndefined();
    const text = call!.result?.content?.[0]?.text ?? "";
    expect(text).toContain(`Storage sessions: ${join(storageRoot, "sessions")} (via CONTEXT_MODE_DIR)`);
    expect(text).toContain(`Storage content: ${join(storageRoot, "content")} (via CONTEXT_MODE_DIR)`);
    expect(text).toContain(`Storage stats: ${join(storageRoot, "sessions")} (via CONTEXT_MODE_DIR)`);
  }, 30_000);

  test("three concurrent ctx_doctor calls all succeed without crashing the server", async () => {
    const proc = startMcpServer();
    const responses = await initAndCallDoctor(proc, 3, 20_000);
    const calls = [100, 101, 102].map((id) => responses.find((r) => r.id === id));
    for (const c of calls) {
      expect(c, "missing ctx_doctor response — server likely crashed").toBeDefined();
      expect(c!.error).toBeUndefined();
      expect(c!.result?.content?.[0]?.text).toContain("context-mode doctor");
    }
  }, 35_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// ctx_doctor renderer-safe output (Mickey #3 — Z.ai GLM compatibility)
// ═══════════════════════════════════════════════════════════════════════════
//
// Z.ai's MCP renderer crashes with `ReferenceError: client is not defined`
// when it parses GitHub-flavored markdown task-list syntax (`- [x]`, `- [ ]`,
// `- [-]`). To stay safe across all MCP clients (including renderers that mount
// custom React components for task lists or h2 headers), ctx_doctor MUST emit
// plain-text status prefixes (`[OK]`, `[FAIL]`, `[WARN]`) and avoid `##`
// headings.
describe("ctx_doctor — renderer-safe output (Z.ai compat)", () => {
  test("output uses [OK]/[FAIL]/[WARN] prefixes and no markdown task-list syntax", async () => {
    const proc = startMcpServer();
    const responses = await initAndCallDoctor(proc, 1);
    const call = responses.find((r) => r.id === 100);
    expect(call).toBeDefined();
    expect(call!.error).toBeUndefined();
    const text: string = call!.result?.content?.[0]?.text ?? "";

    // Must NOT contain GFM task-list syntax (triggers Z.ai's broken renderer)
    expect(text).not.toMatch(/-\s+\[x\]/);
    expect(text).not.toMatch(/-\s+\[ \]/);
    expect(text).not.toMatch(/-\s+\[-\]/);

    // Must NOT contain `## ` h2 (some renderers mount custom h2 components)
    expect(text).not.toMatch(/^##\s/m);

    // Must use plain-text status prefixes
    expect(text).toMatch(/\[OK\]/);
    // Header is plain text, no markdown
    expect(text).toMatch(/^context-mode doctor/m);
  }, 30_000);
});


// ═══════════════════════════════════════════════════════════════════════════
// Pre-detection session dir (race-condition fix)
// ═══════════════════════════════════════════════════════════════════════════
//
// Before the MCP `initialize` handshake completes, `_detectedAdapter` is null.
// Tools called in that window must still resolve a platform-correct sessions
// dir instead of falling back to hardcoded `~/.claude/context-mode/sessions/`.
//
// `getSessionDirSegments` is a sync, env-free map from PlatformId → segments
// (no adapter instantiation). `getSessionDir` calls `detectPlatform()` (sync,
// env-var-based) and feeds the result into the map. Falls back to `.claude`
// only if the map returns null (defensive — covers "unknown" PlatformId).

describe("ctx_doctor hook script checks", () => {
  const serverSrc = readServerSource();

  test("resolves relative hook script paths against pluginRoot", () => {
    const doctorSection = serverSrc.slice(serverSrc.indexOf("ctx_doctor"), serverSrc.indexOf("ctx_upgrade"));
    expect(doctorSection).toContain("for (const scriptPath of hookScriptPaths)");
    expect(doctorSection).toContain("const hookPath = resolve(pluginRoot, scriptPath)");
    expect(doctorSection).not.toContain("for (const hookPath of hookScriptPaths)");
  });
});
