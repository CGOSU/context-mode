/** OpenClaw regressions: openclaw. */
import "../setup-home";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, test, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { createTestPlugin, createMockApiWithoutRegisterHook, useOpenClawReadiness } from "./openclaw-api.js";

useOpenClawReadiness();

describe("OpenClawPlugin", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaw-plugin-test-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch { /* cleanup best effort */ }
  });

  // ── Object export form ────────────────────────────────

  describe("object export", () => {
    it("exports object with id, name, configSchema, register", async () => {
      const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
      expect(plugin.id).toBe("context-mode");
      expect(plugin.name).toBe("Context Mode");
      expect(plugin.configSchema).toBeDefined();
      expect(plugin.configSchema.type).toBe("object");
      expect(typeof plugin.register).toBe("function");
    });

    it("configSchema has enabled property", async () => {
      const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
      expect(plugin.configSchema.properties.enabled).toBeDefined();
      expect(plugin.configSchema.properties.enabled.type).toBe("boolean");
      expect(plugin.configSchema.properties.enabled.default).toBe(true);
    });
  });

  // ── Registration ──────────────────────────────────────

  describe("registration", () => {
    it("registers before_tool_call hook via api.on()", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-before"));
      const lifecycleNames = mock.lifecycle.map((h) => h.event);
      expect(lifecycleNames).toContain("before_tool_call");
    });

    it("registers after_tool_call hook via api.on()", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-after"));
      const lifecycleNames = mock.lifecycle.map((h) => h.event);
      expect(lifecycleNames).toContain("after_tool_call");
    });

    it("registers command:new hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-new"));
      const hookNames = mock.hooks.map((h) => h.event);
      expect(hookNames).toContain("command:new");
    });

    it("registers before_prompt_build lifecycle hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-prompt"));
      const lifecycleEvents = mock.lifecycle.map((l) => l.event);
      expect(lifecycleEvents).toContain("before_prompt_build");
    });

    it("registers context-mode context engine", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-engine"));
      expect(mock.contextEngines).toHaveLength(1);
      expect(mock.contextEngines[0].id).toBe("context-mode");
    });

    it("hooks have proper metadata names", async () => {
      const mock = await createTestPlugin(join(tempDir, "reg-meta"));
      for (const hook of mock.hooks) {
        expect(hook.meta.name).toMatch(/^context-mode\./);
        expect(hook.meta.description.length).toBeGreaterThan(0);
      }
    });

    it("degrades gracefully when registerHook and registerContextEngine are unavailable", async () => {
      const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
      const mock = createMockApiWithoutRegisterHook();

      expect(() => plugin.register(mock.api as unknown as Parameters<typeof plugin.register>[0]))
        .not.toThrow();
      expect(mock.tools.length).toBeGreaterThan(0);
      expect(mock.commands.map((c) => c.name)).toEqual(
        expect.arrayContaining(["ctx-stats", "ctx-doctor", "ctx-upgrade"]),
      );
      const lifecycleNames = mock.lifecycle.map((h) => h.event);
      expect(lifecycleNames).toContain("before_tool_call");
      expect(lifecycleNames).toContain("command:new");
      expect(mock.warnings.length).toBeGreaterThan(0);
    });
  });

  // ── Auto-reply commands ───────────────────────────────

  describe("auto-reply commands", () => {
    it("registers ctx-stats command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-stats"));
      const statsCmd = mock.commands.find((c) => c.name === "ctx-stats");
      expect(statsCmd).toBeDefined();
      expect(statsCmd!.description).toContain("statistics");
    });

    it("registers ctx-doctor command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-doctor"));
      const doctorCmd = mock.commands.find((c) => c.name === "ctx-doctor");
      expect(doctorCmd).toBeDefined();
      expect(doctorCmd!.description).toContain("diagnostics");
    });

    it("registers ctx-upgrade command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-upgrade"));
      const upgradeCmd = mock.commands.find((c) => c.name === "ctx-upgrade");
      expect(upgradeCmd).toBeDefined();
      expect(upgradeCmd!.description).toContain("Upgrade");
    });

    it("ctx-stats handler returns session stats text", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-stats-run"));
      const statsCmd = mock.commands.find((c) => c.name === "ctx-stats");
      const result = await statsCmd!.handler({});
      expect(result.text).toContain("context-mode stats");
      expect(result.text).toContain("Events captured:");
    });

    it("ctx-doctor handler returns diagnostics command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-doctor-run"));
      const doctorCmd = mock.commands.find((c) => c.name === "ctx-doctor");
      const result = await doctorCmd!.handler({});
      expect(result.text).toContain("ctx-doctor");
      expect(result.text).toContain("doctor");
    });

    it("ctx-upgrade handler returns upgrade command", async () => {
      const mock = await createTestPlugin(join(tempDir, "cmd-upgrade-run"));
      const upgradeCmd = mock.commands.find((c) => c.name === "ctx-upgrade");
      const result = await upgradeCmd!.handler({});
      expect(result.text).toContain("ctx-upgrade");
      expect(result.text).toContain("upgrade");
      expect(result.text).toContain("Restart");
    });
  });

  // ── SLICE OClaw-1: registerTool exposes 11 ctx_* MCP tools ────────
  describe("registerTool (SLICE OClaw-1 — sidecar MCP)", () => {
    const EXPECTED_NAMES = [
      "ctx_execute",
      "ctx_execute_file",
      "ctx_index",
      "ctx_search",
      "ctx_fetch_and_index",
      "ctx_batch_execute",
      "ctx_stats",
      "ctx_doctor",
      "ctx_upgrade",
      "ctx_purge",
      "ctx_insight",
    ] as const;

    it("registers all 11 ctx_* tools via api.registerTool", async () => {
      const mock = await createTestPlugin(join(tempDir, "register-tool"));
      const names = mock.tools.map((t) => t.name);
      for (const expected of EXPECTED_NAMES) {
        expect(names).toContain(expected);
      }
      expect(mock.tools.length).toBeGreaterThanOrEqual(EXPECTED_NAMES.length);
    });

    it("each tool definition has description + parameters schema", async () => {
      const mock = await createTestPlugin(join(tempDir, "register-tool-shape"));
      for (const tool of mock.tools) {
        expect(tool.description.length).toBeGreaterThan(0);
        expect(tool.parameters.type).toBe("object");
        expect(typeof tool.execute).toBe("function");
      }
    });

    it("execute() returns MCP-shaped { content: [{type, text}] } response", async () => {
      const mock = await createTestPlugin(join(tempDir, "register-tool-exec"));
      const tool = mock.tools.find((t) => t.name === "ctx_search");
      expect(tool).toBeDefined();
      const out = await tool!.execute("call-1", { queries: ["hello"] });
      expect(out).toHaveProperty("content");
      expect(Array.isArray(out.content)).toBe(true);
      expect(out.content[0].type).toBe("text");
      expect(typeof out.content[0].text).toBe("string");
    });
  });
});


// ═══════════════════════════════════════════════════════════
// BLOCK 2: Plugin hooks (from openclaw-plugin-hooks.test.ts)
// ═══════════════════════════════════════════════════════════

describe("Plugin exports", () => {
  beforeEach(() => { vi.resetModules(); });

  test("plugin exports id, name, configSchema, register", async () => {
    const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
    assert.equal(plugin.id, "context-mode");
    assert.equal(plugin.name, "Context Mode");
    assert.ok(plugin.configSchema);
    assert.equal(typeof plugin.register, "function");
  });
});
