/** Server regressions: legacy. */


import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";



const __dirname = dirname(fileURLToPath(import.meta.url));


// ─────────────────────────────────────────────────────────
// Startup banner suppression in stdio transport mode.
// When the server runs as a child process (stdin is not a TTY), the banner
// must not appear on stderr — Pi and other hosts render stderr in their UI.
// ─────────────────────────────────────────────────────────
describe("startup banner suppressed in stdio transport mode", () => {
  test("no banner on stderr when stdin is not a TTY (child process)", async () => {
    const bundlePath = resolve(__dirname, "../../server.bundle.mjs");
    if (!existsSync(bundlePath)) return;

    const stderr = await new Promise<string>((res) => {
      const proc = spawn(process.execPath, [bundlePath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CONTEXT_MODE_SUPPRESS_SECURITY_WARNING: "1" },
      });
      let data = "";
      proc.stderr.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      setTimeout(() => { proc.kill(); res(data); }, 300);
    });

    expect(stderr).not.toContain("Context Mode MCP server");
    expect(stderr).not.toContain("Detected runtimes:");
  });
});


test("OpenCode/Kilo legacy MCP child suppresses ctx_* tool registration while embedded plugin import keeps it", async () => {
  const { shouldSuppressMcpToolsForNativePluginHost } = await import("../../src/server.js");
  const legacySettings = {
    plugin: ["context-mode"],
    mcp: { "context-mode": { type: "local", command: ["context-mode"] } },
  };
  expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "opencode", settings: legacySettings })).toBe(true);
  expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "kilo", settings: legacySettings })).toBe(true);
  expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "opencode", settings: { plugin: ["context-mode"] } })).toBe(false);
  expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "opencode", embedded: "1", settings: legacySettings })).toBe(false);
  expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "claude-code", embedded: undefined })).toBe(false);
});


test("OpenCode legacy MCP suppression parses JSONC URLs without stripping // inside strings", async () => {
  const { shouldSuppressMcpToolsForNativePluginHost } = await import("../../src/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opencode-jsonc-url-"));
  const cwd = process.cwd();
  try {
    writeFileSync(join(dir, "opencode.jsonc"), `{
      // Keep this URL intact; a naive /\\/\\/.*/ stripper corrupts it.
      "endpoint": "https://example.com/api",
      "plugin": ["context-mode"],
      "mcp": {
        "context-mode": { "type": "local", "command": ["context-mode"] },
        "other": { "type": "local", "command": ["other"] }
      }
    }\n`);
    process.chdir(dir);
    expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "opencode" })).toBe(true);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});


// Issue #623: when ctx_* tool registration is suppressed for the legacy MCP
// child on OpenCode/Kilo, an MCP client inspecting tools/list sees an empty
// list with NO explanation. The plugin-native tools work, but a user who only
// observes the MCP child (or another MCP host that doesn't load the plugin)
// has no signal that ctx_* tools were intentionally hidden. Surface a stderr
// diagnostic frame at first suppressed registerTool() call so operators can
// tell "tools/list is empty BECAUSE the legacy mcp.context-mode block coexists
// with plugin: ['context-mode']" — not "the server is broken".
test("OpenCode/Kilo legacy MCP child emits stderr diagnostic when ctx_* suppression fires (#623)", async () => {
  const { emitSuppressionDiagnostic, __resetSuppressionDiagnosticForTests } = await import("../../src/server.js");
  __resetSuppressionDiagnosticForTests();
  const lines: string[] = [];
  emitSuppressionDiagnostic({ platform: "opencode", write: (c) => lines.push(c) });
  // Second call must NOT re-emit — diagnostic is one-shot per process.
  emitSuppressionDiagnostic({ platform: "opencode", write: (c) => lines.push(c) });
  const joined = lines.join("");
  expect(joined).toMatch(/context-mode/);
  expect(joined).toMatch(/#623|plugin-native|legacy.*mcp\.context-mode|mcp\.context-mode.*legacy/i);
  // One-shot: exactly one line containing the marker.
  const matches = joined.match(/\[context-mode\]/g) ?? [];
  expect(matches.length).toBe(1);
  __resetSuppressionDiagnosticForTests();
});


// Issue #637: an operator who inspects the suppressed legacy MCP child via
// `tools/list` (or whose MCP host probes it on connect) currently receives a
// JSON-RPC -32601 "Method not found" error — because no `registerTool()` call
// survives the suppression shim, the SDK's `setToolRequestHandlers()` never
// runs and `tools/list` is therefore unregistered. To an outside observer that
// looks identical to a broken server and they reasonably conclude "the plugin
// never registers any ctx_* tools" (#637's headline framing). The real story
// is "the MCP child was intentionally muted; the plugin path is serving the
// tools natively" — already conveyed via the #623 stderr diagnostic, but
// JSON-RPC consumers don't read stderr.
//
// Fix: register an explicit empty `tools/list` handler whenever suppression
// is active, so the wire response becomes `{tools: []}` (spec-compliant,
// matches what operators expect) paired with the existing stderr diagnostic.
// This eliminates the misleading -32601 that started #637.
test("registerEmptyToolsListHandler responds with {tools:[]} so operators don't see -32601 on suppressed MCP child (#637)", async () => {
  // The user-facing failure mode that drove issue #637: an operator inspecting
  // the suppressed legacy MCP child via `tools/list` (or whose MCP host probes
  // it during connect) receives JSON-RPC -32601 "Method not found" because the
  // SDK only registers tools/list when `registerTool()` actually goes through —
  // and the #623 suppression shim returns undefined for every registration.
  // The reporter reads -32601 as "the plugin never registers any ctx_* tools",
  // which is the headline framing of #637.
  //
  // Fix: an exported helper that installs an explicit empty tools/list handler
  // when suppression is active. The bundle entry point calls it at module-init
  // time (alongside the prompts/resources handlers at server.ts:259-261).
  //
  // We test the helper in isolation against a fresh McpServer wired through an
  // in-memory transport to a Client. This avoids the module-load-time pinning
  // of `suppressMcpToolsForNativePluginHost` and gives a deterministic loop
  // that does not depend on the build bundle being present.
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerEmptyToolsListHandler } = await import("../../src/server.js");

  const mcp = new McpServer({ name: "issue-637-isolated", version: "0.0.0" });
  registerEmptyToolsListHandler(mcp);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    mcp.server.connect(serverTransport),
    (async () => {
      const client = new Client({ name: "issue-637-probe", version: "0.0.0" }, { capabilities: {} });
      await client.connect(clientTransport);
      const listed = await client.listTools();
      // Pre-fix: client.listTools() throws -32601 Method not found.
      // Post-fix: returns { tools: [] }.
      expect(listed).toBeDefined();
      expect(Array.isArray(listed.tools)).toBe(true);
      expect(listed.tools.length).toBe(0);
      await client.close();
    })(),
  ]);
}, 15_000);
