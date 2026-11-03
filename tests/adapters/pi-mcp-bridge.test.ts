import "../setup-home";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "ctx-pi-forkbomb-"));
});

afterEach(() => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  delete process.env.CONTEXT_MODE_BRIDGE_DEPTH;
});

// Slice 1 — runtime name guard
describe("resolveJsRuntimeForBridge — Pi fork-bomb guard (#516)", () => {
  it("rejects a pi-named binary returned by detectRuntimes and falls back to PATH node/bun", async () => {
    const mod = await import("../../src/adapters/pi/mcp-bridge.js");
    const { resolveJsRuntimeForBridge } = mod as unknown as {
      resolveJsRuntimeForBridge: (deps?: {
        detect?: () => { javascript: string | null };
        which?: (cmd: string) => string | null;
        execPath?: string;
      }) => string | null;
    };
    expect(typeof resolveJsRuntimeForBridge).toBe("function");

    // Detect returns the Pi binary (the bug condition). Helper must
    // refuse it and fall back to whatever `which` resolves for node/bun.
    const resolved = resolveJsRuntimeForBridge({
      detect: () => ({ javascript: "/usr/local/bin/pi" }),
      which: (cmd) => (cmd === "node" ? "/usr/bin/node" : null),
      execPath: "/usr/local/bin/pi",
    });

    expect(resolved).toBe("/usr/bin/node");
  });

  it("rejects pi.exe (case-insensitive, .exe suffix) on Windows-shaped paths", async () => {
    const mod = await import("../../src/adapters/pi/mcp-bridge.js");
    const { resolveJsRuntimeForBridge } = mod as unknown as {
      resolveJsRuntimeForBridge: (deps?: {
        detect?: () => { javascript: string | null };
        which?: (cmd: string) => string | null;
        execPath?: string;
      }) => string | null;
    };

    const resolved = resolveJsRuntimeForBridge({
      detect: () => ({ javascript: "C:\\Program Files\\Pi\\Pi.EXE" }),
      which: (cmd) => (cmd === "bun" ? "C:\\bun\\bun.exe" : null),
      execPath: "C:\\Program Files\\Pi\\Pi.EXE",
    });

    expect(resolved).toBe("C:\\bun\\bun.exe");
  });
});


// Slice 3 — recursion guard via env counter
describe("bootstrapMCPTools — recursion guard (#516)", () => {
  it("aborts and logs to pi.logger (NOT the TUI terminal) when CONTEXT_MODE_BRIDGE_DEPTH > 0 already set (#868)", async () => {
    process.env.CONTEXT_MODE_BRIDGE_DEPTH = "1";

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");
    const warn = vi.fn();
    const fakePi = { registerTool: vi.fn(), logger: { warn, debug: vi.fn() } };

    const handle = await bootstrapMCPTools(fakePi, "/non/existent/server.mjs");

    expect(handle.tools).toEqual([]);
    expect(fakePi.registerTool).not.toHaveBeenCalled();
    // #868: the diagnostic must go to Pi's file logger, never process.stderr
    // (Pi's raw-mode TUI renders any console write into the editor).
    expect(stderrSpy).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(
      logged.includes("recursion") || logged.includes("depth") || logged.includes("fork"),
    ).toBe(true);

    stderrSpy.mockRestore();
  });
});


// Slice 4 — graceful skip when no JS runtime
describe("bootstrapMCPTools — no JS runtime + execPath is pi (#516)", () => {
  it("logs to pi.logger (NOT the TUI terminal) and returns an empty handle without throwing (#868)", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");
    const warn = vi.fn();
    const fakePi = { registerTool: vi.fn(), logger: { warn, debug: vi.fn() } };

    // Inject the no-runtime condition through the same DI hook the
    // bridge uses internally — see resolveJsRuntimeForBridge above.
    const handle = await bootstrapMCPTools(fakePi, "/non/existent/server.mjs", {
      _resolveJsRuntime: () => null,
    } as unknown as { env?: NodeJS.ProcessEnv });

    expect(handle.tools).toEqual([]);
    expect(fakePi.registerTool).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join("");
    expect(logged.includes("no JS runtime") || logged.includes("runtime")).toBe(true);

    stderrSpy.mockRestore();
  });

  it("makeBridgeDiag routes to pi.logger and NEVER process.stderr; splitDiagLines is regex-free (#868)", async () => {
    const { makeBridgeDiag, splitDiagLines } = await import(
      "../../src/adapters/pi/mcp-bridge.js"
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const warn = vi.fn();
    const debug = vi.fn();
    const diag = makeBridgeDiag({ registerTool: vi.fn(), logger: { warn, debug } });
    // the exact line that corrupted the editor in #868:
    diag(
      "[mcp-bridge] [context-mode] idle MCP bridge child self-shutdown after 180000ms with no activity (#854)",
      "debug",
    );
    diag("[context-mode] WARNING: actionable", "warn");
    expect(debug).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(stderrSpy).not.toHaveBeenCalled();

    // No logger reachable -> drop silently, never throw, never touch stderr.
    const diagNoLogger = makeBridgeDiag({ registerTool: vi.fn() });
    expect(() => diagNoLogger("anything", "warn")).not.toThrow();
    expect(stderrSpy).not.toHaveBeenCalled();

    // splitDiagLines: \n split, trailing \r stripped, final partial preserved.
    expect(splitDiagLines("a\nb\r\nc")).toEqual(["a", "b", "c"]);
    expect(splitDiagLines("solo")).toEqual(["solo"]);
    expect(splitDiagLines("trailing\n")).toEqual(["trailing"]);

    stderrSpy.mockRestore();
  });
});


// ── Slice 9 — bootstrap retries on slow `initialize` (#647) ──
//
// Reported in #647: when the spawned MCP child is slow to start (cold
// NFS home dir, first JIT compile of server.bundle.mjs, constrained CI),
// `initialize` can exceed the 60s ceiling. The bridge then catches the
// timeout, logs to stderr, and continues with NO `ctx_*` tools
// registered — the session is silently degraded for its entire lifetime
// while the routing block keeps spending ~2.5K tokens per turn telling
// the LLM to call ctx_* tools it cannot reach.
//
// The 60s timeout itself is correct (per #643) and must stay. The fix
// is at the bootstrap layer: on `initialize` failure, shut down the
// child, respawn, and retry — up to MAX_INIT_RETRIES additional
// attempts, then degrade as today (let the existing extension-level
// rejection handler log + run with empty tool list).
//
// These tests pin three things:
//   1. Two consecutive `initialize` failures followed by success → bridge
//      registers tools normally (recovery happy path).
//   2. All attempts fail → bootstrap rejects (preserves the existing
//      "degrade via extension.ts then/onRejected" contract).
//   3. Each retry shuts down the prior child (no orphan accumulation).
describe("bootstrapMCPTools — retries on slow initialize (#647)", () => {
  it("registers tools after two transient initialize timeouts followed by success", async () => {
    const { bootstrapMCPTools, MCPStdioClient } = await import(
      "../../src/adapters/pi/mcp-bridge.js"
    );

    // Track how many initialize/start/shutdown cycles ran.
    const startCalls: number[] = [];
    const initCalls: number[] = [];
    const shutdownCalls: number[] = [];

    let attempt = 0;
    type AnyClient = MCPStdioClient & { initialized: boolean; exited: boolean };

    // Patch prototype so the inner `new MCPStdioClient(...)` is captured.
    const realStart = MCPStdioClient.prototype.start;
    const realInit = MCPStdioClient.prototype.initialize;
    const realList = MCPStdioClient.prototype.listTools;
    const realShutdown = MCPStdioClient.prototype.shutdown;

    MCPStdioClient.prototype.start = function (this: AnyClient) {
      startCalls.push(Date.now());
      // Stub a non-null `child` so other code paths see a live client.
      (this as unknown as { child: unknown }).child = { kill: () => true };
      this.exited = false;
    };
    MCPStdioClient.prototype.initialize = async function (this: AnyClient) {
      attempt++;
      initCalls.push(attempt);
      if (attempt <= 2) {
        // Simulate the exact rejection shape produced by request() on
        // the 60s timeout — caller must accept any Error-shaped failure.
        throw new Error("MCP request timeout after 60000ms: initialize");
      }
      this.initialized = true;
    };
    MCPStdioClient.prototype.listTools = async function () {
      return [{ name: "ctx_search", description: "search", inputSchema: { type: "object" } }];
    };
    MCPStdioClient.prototype.shutdown = function (this: AnyClient) {
      shutdownCalls.push(Date.now());
      (this as unknown as { child: unknown }).child = null;
      this.initialized = false;
      this.exited = true;
    };

    try {
      const registered: string[] = [];
      const fakePi = {
        registerTool: (tool: { name: string }) => {
          registered.push(tool.name);
        },
      };

      const handle = await bootstrapMCPTools(fakePi, "/unused/server.mjs", {
        _resolveJsRuntime: () => "/usr/bin/node",
      });

      // Happy-path recovery: tool registered after retries.
      expect(handle.tools).toEqual(["ctx_search"]);
      expect(registered).toEqual(["ctx_search"]);
      // Exactly 3 initialize attempts (1 initial + 2 retries).
      expect(initCalls.length).toBe(3);
      // Each failed attempt MUST shutdown the prior child before respawn
      // (no orphan accumulation). Two failures → at least two shutdowns.
      expect(shutdownCalls.length).toBeGreaterThanOrEqual(2);
      // start() called once per attempt (3 total).
      expect(startCalls.length).toBe(3);
    } finally {
      MCPStdioClient.prototype.start = realStart;
      MCPStdioClient.prototype.initialize = realInit;
      MCPStdioClient.prototype.listTools = realList;
      MCPStdioClient.prototype.shutdown = realShutdown;
    }
  }, 30_000);

  it("rejects after exhausting retries so extension.ts can run its degrade-and-log handler", async () => {
    const { bootstrapMCPTools, MCPStdioClient } = await import(
      "../../src/adapters/pi/mcp-bridge.js"
    );

    const realStart = MCPStdioClient.prototype.start;
    const realInit = MCPStdioClient.prototype.initialize;
    const realShutdown = MCPStdioClient.prototype.shutdown;

    let initAttempts = 0;
    MCPStdioClient.prototype.start = function (this: MCPStdioClient) {
      (this as unknown as { child: unknown }).child = { kill: () => true };
      (this as unknown as { exited: boolean }).exited = false;
    };
    MCPStdioClient.prototype.initialize = async function () {
      initAttempts++;
      throw new Error("MCP request timeout after 60000ms: initialize");
    };
    MCPStdioClient.prototype.shutdown = function (this: MCPStdioClient) {
      (this as unknown as { child: unknown }).child = null;
      (this as unknown as { exited: boolean }).exited = true;
    };

    try {
      const fakePi = { registerTool: vi.fn() };
      await expect(
        bootstrapMCPTools(fakePi, "/unused/server.mjs", {
          _resolveJsRuntime: () => "/usr/bin/node",
        }),
      ).rejects.toThrow(/timeout|initialize/i);

      // Must have made the full 1 + MAX_INIT_RETRIES (=2) = 3 attempts
      // before giving up.
      expect(initAttempts).toBe(3);
      expect(fakePi.registerTool).not.toHaveBeenCalled();
    } finally {
      MCPStdioClient.prototype.start = realStart;
      MCPStdioClient.prototype.initialize = realInit;
      MCPStdioClient.prototype.shutdown = realShutdown;
    }
  }, 30_000);
});


  // ── Integration: bootstrapMCPTools + real MCP server ──────────────

  describe("bootstrapMCPTools — registers every ctx_* tool with Pi", () => {
    // Lifted out of each `it` so the path resolution lives in one place
    // and a future MCP-entrypoint move only has to change one line.
    const path = require("node:path") as typeof import("node:path");
    const url = require("node:url") as typeof import("node:url");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const mcpEntry = path.resolve(here, "..", "..", "start.mjs");
    const mcpEnv = { ...process.env, CONTEXT_MODE_DISABLE_VERSION_CHECK: "1" };

    let bridge: { tools: string[]; shutdown: () => void } | null = null;

    afterEach(() => {
      if (bridge) {
        bridge.shutdown();
        bridge = null;
      }
    });

    it("registers the canonical ctx_* tool set", async () => {
      const registered: Array<{ name: string; label: string; description: string; parameters: unknown; execute: Function }> = [];
      const fakePi = {
        registerTool: (tool: any) => {
          registered.push(tool);
        },
      };

      const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");
      bridge = await bootstrapMCPTools(fakePi, mcpEntry, { env: mcpEnv });

      // Pin the canonical names — adding new MCP tools is fine
      // (arrayContaining), but losing one of these is the bug regression.
      expect(bridge.tools).toEqual(
        expect.arrayContaining([
          "ctx_execute",
          "ctx_execute_file",
          "ctx_search",
          "ctx_index",
          "ctx_batch_execute",
          "ctx_fetch_and_index",
          "ctx_doctor",
          "ctx_stats",
          "ctx_purge",
        ]),
      );

      // Each registration must satisfy the Pi contract.
      for (const reg of registered) {
        expect(reg.name).toMatch(/^ctx_/);
        expect(reg.label).toBe(reg.name);
        expect(typeof reg.description).toBe("string");
        expect(reg.parameters).toBeTruthy();
        expect(typeof reg.execute).toBe("function");
      }
    }, 30_000);

    it("execute() round-trips through tools/call to the MCP server", async () => {
      const registered: any[] = [];
      const fakePi = {
        registerTool: (tool: any) => registered.push(tool),
      };

      const { bootstrapMCPTools } = await import("../../src/adapters/pi/mcp-bridge.js");
      bridge = await bootstrapMCPTools(fakePi, mcpEntry, { env: mcpEnv });

      const indexTool = registered.find((t) => t.name === "ctx_index");
      expect(indexTool).toBeDefined();

      const marker = `pi-bridge-marker-${process.pid}-${Date.now()}`;
      const result = await indexTool.execute("test-call-1", {
        content: `# heading\n\n${marker}\n`,
        source: "pi-bridge-smoke",
      });

      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe("text");
      // Server returns "Indexed N sections … from: pi-bridge-smoke" on
      // success — pin the source label so a regression in tools/call
      // arg-passing also fails this test.
      expect(result.content[0].text).toMatch(/pi-bridge-smoke/);
      expect(result.isError).toBeFalsy();
    }, 30_000);
  });
