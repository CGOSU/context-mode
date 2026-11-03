/** OpenClaw regressions: openclaw-context-engine. */
import "../setup-home";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestPlugin, useOpenClawReadiness } from "./openclaw-api.js";

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

  // ── before_prompt_build ───────────────────────────────

  describe("before_prompt_build", () => {
    /**
     * Force the plugin's lazy initPromise (which resolves dynamic routing-block
     * + routing.mjs imports) to settle before asserting on hook output. We
     * piggyback on before_tool_call which awaits initPromise internally.
     */
    async function flushInit(mock: Awaited<ReturnType<typeof createTestPlugin>>) {
      const before = mock.lifecycle.find((l) => l.event === "before_tool_call");
      if (before) {
        try { await before.handler({ toolName: "noop", params: {} }); } catch { /* ignore */ }
      }
    }

    it("returns appendSystemContext with routing instructions", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-build"));
      await flushInit(mock);
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build" && l.opts?.priority === 5,
      );
      expect(promptHook).toBeDefined();

      const result = promptHook!.handler() as { appendSystemContext: string };
      expect(result).toHaveProperty("appendSystemContext");
      expect(result.appendSystemContext).toContain("context-mode");
    });

    it("injects skill-like guidance derived from skills/context-mode/SKILL.md", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-skill-like"));
      await flushInit(mock);
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build" && l.opts?.priority === 5,
      );
      const result = promptHook!.handler() as { appendSystemContext?: string };
      expect(result?.appendSystemContext).toContain("<context_mode_skill_like_guidance");
      expect(result?.appendSystemContext).toContain("Default to context-mode for ALL commands.");
    });

    it("has priority 5", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-priority"));
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build" && l.opts?.priority === 5,
      );
      expect(promptHook?.opts?.priority).toBe(5);
    });

    // SLICE OClaw-2: dynamic routing block via createRoutingBlock(toolNamer).
    it("appendSystemContext is the dynamic <context_window_protection> XML, not stale AGENTS.md disk content", async () => {
      const mock = await createTestPlugin(join(tempDir, "prompt-dynamic"));
      await flushInit(mock);
      const promptHook = mock.lifecycle.find(
        (l) => l.event === "before_prompt_build" && l.opts?.priority === 5,
      );
      const result = promptHook!.handler() as { appendSystemContext?: string };
      expect(result?.appendSystemContext).toBeDefined();
      // Hallmark of createRoutingBlock(toolNamer) — see hooks/routing-block.mjs:19.
      expect(result.appendSystemContext).toContain("<context_window_protection>");
      expect(result.appendSystemContext).toContain("<tool_selection_hierarchy>");
      // OpenClaw tool-namer leaves bare ctx_* names unprefixed (no MCP wrap).
      expect(result.appendSystemContext).toContain("ctx_batch_execute");
    });
  });

  // ── SLICE OClaw-5: subagent_spawning injects routing block ────────
  describe("subagent_spawning routing-block injection (SLICE OClaw-5)", () => {
    async function flushInit(mock: Awaited<ReturnType<typeof createTestPlugin>>) {
      const before = mock.lifecycle.find((l) => l.event === "before_tool_call");
      if (before) {
        try { await before.handler({ toolName: "noop", params: {} }); } catch { /* ignore */ }
      }
    }

    it("registers subagent_spawning lifecycle hook", async () => {
      const mock = await createTestPlugin(join(tempDir, "subagent-register"));
      const events = mock.lifecycle.map((l) => l.event);
      expect(events).toContain("subagent_spawning");
    });

    it("returns inputOverride.prompt with routing block appended to the original prompt", async () => {
      const mock = await createTestPlugin(join(tempDir, "subagent-inject"));
      await flushInit(mock);
      const hook = mock.lifecycle.find((l) => l.event === "subagent_spawning");
      const out = hook!.handler({
        input: { prompt: "Investigate the failing test." },
      }) as { inputOverride?: { prompt?: string } } | undefined;
      expect(out?.inputOverride?.prompt).toBeDefined();
      expect(out!.inputOverride!.prompt!).toContain("Investigate the failing test.");
      expect(out!.inputOverride!.prompt!).toContain("<context_window_protection>");
      expect(out!.inputOverride!.prompt!).toContain("<context_mode_skill_like_guidance");
    });

    it("falls back gracefully when input.prompt is missing", async () => {
      const mock = await createTestPlugin(join(tempDir, "subagent-no-prompt"));
      await flushInit(mock);
      const hook = mock.lifecycle.find((l) => l.event === "subagent_spawning");
      const out = hook!.handler({ input: {} }) as
        | { inputOverride?: { prompt?: string } }
        | undefined;
      expect(out?.inputOverride?.prompt).toContain("<context_window_protection>");
      expect(out?.inputOverride?.prompt).toContain("<context_mode_skill_like_guidance");
    });
  });

  // ── Context engine ────────────────────────────────────

  describe("context engine", () => {
    it("creates engine with ownsCompaction: false (host owns compaction to preserve thinking blocks)", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-info"));
      const engine = mock.contextEngines[0].factory();
      expect(engine.info.id).toBe("context-mode");
      expect(engine.info.name).toBe("Context Mode");
      expect(engine.info.ownsCompaction).toBe(false);
    });

    it("ingest returns { ingested: true }", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-ingest"));
      const engine = mock.contextEngines[0].factory();
      const result = await engine.ingest({});
      expect(result).toEqual({ ingested: true });
    });

    it("assemble passes through messages", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-assemble"));
      const engine = mock.contextEngines[0].factory();
      const messages = [{ role: "user", content: "hello" }];
      const result = await engine.assemble({ messages });
      expect(result.messages).toBe(messages);
      expect(result.estimatedTokens).toBe(0);
    });

    it("compact returns { ok: true, compacted: false } when no events", async () => {
      const mock = await createTestPlugin(join(tempDir, "engine-compact-empty"));
      const engine = mock.contextEngines[0].factory();
      const result = await engine.compact();
      expect(result).toEqual({ ok: true, compacted: false });
    });
  });
});
