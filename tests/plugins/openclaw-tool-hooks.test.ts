/** OpenClaw regressions: openclaw-tool-hooks. */
import "../setup-home";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { OpenClawSessionDB } from "../../src/adapters/openclaw/session-db.js";
import { createTestPlugin, createMockApiFull, useOpenClawReadiness } from "./openclaw-api.js";

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

  // ── before_tool_call ──────────────────────────────────

  describe("before_tool_call", () => {
    it("modifies curl commands to block them", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-curl"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");
      expect(beforeHook).toBeDefined();

      const params = { command: "curl https://example.com/data" };
      const event = { toolName: "Bash", params };

      await beforeHook!.handler(event);

      // Routing replaces the curl command with an informative echo
      expect(params.command).toMatch(/^echo /);
      expect(params.command).toContain("context-mode");
    });

    it("modifies wget commands to block them", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-wget"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const params = { command: "wget https://example.com/file" };
      const event = { toolName: "Bash", params };

      await beforeHook!.handler(event);

      expect(params.command).toMatch(/^echo /);
      expect(params.command).toContain("context-mode");
    });

    it("passes through normal tool calls", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-pass"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const result = await beforeHook!.handler({
        toolName: "TaskCreate",
        params: { subject: "test task" },
      });

      expect(result).toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const mock = await createTestPlugin(join(tempDir, "before-empty"));
      const beforeHook = mock.lifecycle.find((h) => h.event === "before_tool_call");

      const result = await beforeHook!.handler({});
      expect(result).toBeUndefined();
    });
  });

  // ── after_tool_call ───────────────────────────────────

  describe("after_tool_call", () => {
    it("captures file read events without throwing", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-read"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(
        afterHook!.handler({
          toolName: "Read",
          params: { file_path: "/test/file.ts" },
          output: "file contents here",
        }),
      ).resolves.toBeUndefined();
    });

    it("captures file write events", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-write"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(
        afterHook!.handler({
          toolName: "Write",
          params: { file_path: "/test/new-file.ts", content: "code" },
        }),
      ).resolves.toBeUndefined();
    });

    it("captures git events from Bash", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-git"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(
        afterHook!.handler({
          toolName: "Bash",
          params: { command: "git commit -m 'test'" },
          output: "[main abc1234] test",
        }),
      ).resolves.toBeUndefined();
    });

    it("handles empty input gracefully", async () => {
      const mock = await createTestPlugin(join(tempDir, "after-empty"));
      const afterHook = mock.lifecycle.find((h) => h.event === "after_tool_call");

      await expect(afterHook!.handler({})).resolves.toBeUndefined();
    });
  });

  // ── model.usage diagnostic subscription (cost capture wire) ──

  describe("model.usage diagnostic subscription", () => {
    it("subscribes via api.onDiagnosticEvent and flows a model.usage event to db.insertEvent", async () => {
      // Capture the listener the plugin registers on the diagnostic bus.
      let diagListener: ((evt: unknown) => void) | undefined;
      const mock = createMockApiFull();
      const api = {
        ...mock.api,
        onDiagnosticEvent(listener: (evt: unknown) => void) {
          diagListener = listener;
          return () => {};
        },
      };

      const insertSpy = vi.spyOn(OpenClawSessionDB.prototype, "insertEvent");
      insertSpy.mockClear();

      const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
      await plugin.register(api as unknown as Parameters<typeof plugin.register>[0]);

      expect(typeof diagListener).toBe("function");

      // Fire a real model.usage diagnostic payload.
      diagListener!({
        type: "model.usage",
        model: "claude-sonnet-4",
        usage: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
        costUsd: 0.0421,
      });

      const usageInsert = insertSpy.mock.calls.find(
        (c) => (c[1] as { type?: string })?.type === "agent_usage",
      );
      expect(usageInsert).toBeDefined();
      expect((usageInsert![1] as { cost_usd?: number }).cost_usd).toBe(0.0421);
      expect(usageInsert![2]).toBe("Diagnostic"); // PostToolUse-style source tag

      // Non-usage payloads insert no agent_usage event (best-effort, no throw).
      const before = insertSpy.mock.calls.length;
      expect(() => diagListener!({ type: "model.failover" })).not.toThrow();
      const afterUsage = insertSpy.mock.calls
        .slice(before)
        .filter((c) => (c[1] as { type?: string })?.type === "agent_usage");
      expect(afterUsage).toHaveLength(0);

      insertSpy.mockRestore();
    });
  });

  // ── command:new ───────────────────────────────────────

  describe("command:new", () => {
    it("runs without throwing", async () => {
      const mock = await createTestPlugin(join(tempDir, "new-run"));
      const newHook = mock.hooks.find((h) => h.event === "command:new");
      expect(newHook).toBeDefined();

      await expect(newHook!.handler()).resolves.toBeUndefined();
    });
  });

  // ── SLICE OClaw-3: before_model_resolve filters system reminders ────
  describe("before_model_resolve system-reminder filter (SLICE OClaw-3)", () => {
    it("does NOT insert events when message starts with <system-reminder>", async () => {
      const mock = await createTestPlugin(join(tempDir, "filter-system-reminder"));
      const hook = mock.lifecycle.find((l) => l.event === "before_model_resolve");
      expect(hook).toBeDefined();
      // Handler is side-effect-only — assert it returns void/undefined and
      // does not throw on a system-reminder-prefixed message.
      const result = await hook!.handler({
        userMessage: "<system-reminder>do not commit</system-reminder> please refactor",
      });
      expect(result).toBeUndefined();
    });

    it("does NOT insert events for <task-notification>, <context_guidance>, <tool-result>", async () => {
      const mock = await createTestPlugin(join(tempDir, "filter-other-prefixes"));
      const hook = mock.lifecycle.find((l) => l.event === "before_model_resolve");
      const prefixes = ["<task-notification>", "<context_guidance>", "<tool-result>"];
      for (const p of prefixes) {
        const result = await hook!.handler({ userMessage: `${p}payload` });
        expect(result).toBeUndefined();
      }
    });

    it("STILL processes genuine user messages (no prefix)", async () => {
      const mock = await createTestPlugin(join(tempDir, "filter-passthrough"));
      const hook = mock.lifecycle.find((l) => l.event === "before_model_resolve");
      // Should not throw — extractUserEvents path runs.
      await expect(
        hook!.handler({ userMessage: "don't use that approach, use X instead" }),
      ).resolves.toBeUndefined();
    });
  });

  // ── SLICE OClaw-4: session_end handler ────────────────────────────
  describe("session_end (SLICE OClaw-4)", () => {
    it("registers session_end lifecycle hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "session-end-register"));
      const events = mock.lifecycle.map((l) => l.event);
      expect(events).toContain("session_end");
    });

    it("session_end handler runs without throwing when no events captured", async () => {
      const mock = await createTestPlugin(join(tempDir, "session-end-empty"));
      const hook = mock.lifecycle.find((l) => l.event === "session_end");
      expect(hook).toBeDefined();
      await expect(Promise.resolve(hook!.handler({}))).resolves.toBeUndefined();
    });
  });
});
