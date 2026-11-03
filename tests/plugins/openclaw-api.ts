/** Shared mock host API only; no SessionDB fixture or installation configuration. */
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach } from "vitest";

export function useOpenClawReadiness(): void {
  // MCP readiness sentinel — routing.mjs checks process.ppid in-process
  const _sentinelDir = process.platform === "win32" ? tmpdir() : "/tmp";
  const mcpSentinel = resolve(_sentinelDir, `context-mode-mcp-ready-${process.pid}`);
  beforeEach(() => { writeFileSync(mcpSentinel, String(process.pid)); });
  afterEach(() => { try { unlinkSync(mcpSentinel); } catch {} });
}


// ═══════════════════════════════════════════════════════════
// Mock helpers (from openclaw-plugin.test.ts)
// ═══════════════════════════════════════════════════════════

interface MockHookEntry {
  event: string;
  handler: (...args: unknown[]) => unknown;
  meta: { name: string; description: string };
}

interface MockLifecycleEntry {
  event: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

interface MockContextEngine {
  id: string;
  factory: () => {
    info: { id: string; name: string; ownsCompaction: boolean };
    ingest: (data: unknown) => Promise<{ ingested: boolean }>;
    assemble: (ctx: { messages: unknown[] }) => Promise<{ messages: unknown[]; estimatedTokens: number }>;
    compact: () => Promise<{ ok: boolean; compacted: boolean }>;
  };
}

export function createMockApiWithoutRegisterHook() {
  const lifecycle: MockLifecycleEntry[] = [];
  const tools: MockToolEntry[] = [];
  const commands: MockCommandEntry[] = [];
  const warnings: unknown[][] = [];

  return {
    lifecycle,
    tools,
    commands,
    warnings,
    api: {
      on(
        event: string,
        handler: (...args: unknown[]) => unknown,
        opts?: { priority?: number },
      ) {
        lifecycle.push({ event, handler, opts });
      },
      registerCommand(command: unknown) {
        if (
          !command ||
          typeof command !== "object" ||
          typeof (command as { name?: unknown }).name !== "string" ||
          typeof (command as { handler?: unknown }).handler !== "function"
        ) {
          throw new TypeError("registerCommand(command) expected");
        }
        commands.push(command as MockCommandEntry);
      },
      registerTool(
        tool: Omit<MockToolEntry, "optional">,
        opts?: { optional?: boolean },
      ) {
        tools.push({ ...tool, optional: opts?.optional });
      },
      logger: {
        warn: (...args: unknown[]) => warnings.push(args),
      },
    },
  };
}

interface MockCommandEntry {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler: (ctx: Record<string, unknown>) => { text: string } | Promise<{ text: string }>;
}

interface MockToolEntry {
  name: string;
  description: string;
  parameters: { type: string; properties: Record<string, unknown>; required?: string[] };
  execute: (id: string, params: Record<string, unknown>) =>
    Promise<{ content: Array<{ type: "text"; text: string }> }>;
  optional?: boolean;
}

export function createMockApiFull() {
  const hooks: MockHookEntry[] = [];
  const lifecycle: MockLifecycleEntry[] = [];
  const contextEngines: MockContextEngine[] = [];
  const commands: MockCommandEntry[] = [];
  const tools: MockToolEntry[] = [];

  return {
    hooks,
    lifecycle,
    contextEngines,
    commands,
    tools,
    api: {
      registerHook(
        event: string,
        handler: (...args: unknown[]) => unknown,
        meta: { name: string; description: string },
      ) {
        hooks.push({ event, handler, meta });
      },
      on(
        event: string,
        handler: (...args: unknown[]) => unknown,
        opts?: { priority?: number },
      ) {
        lifecycle.push({ event, handler, opts });
      },
      registerContextEngine(
        id: string,
        factory: () => MockContextEngine["factory"] extends () => infer R ? R : never,
      ) {
        contextEngines.push({ id, factory: factory as MockContextEngine["factory"] });
      },
      registerCommand(cmd: MockCommandEntry) {
        commands.push(cmd);
      },
      registerTool(
        tool: Omit<MockToolEntry, "optional">,
        opts?: { optional?: boolean },
      ) {
        tools.push({ ...tool, optional: opts?.optional });
      },
    },
  };
}

/**
 * Create a plugin instance with a mock API.
 * Returns the mock API state and helper functions.
 */
export async function createTestPlugin(tempDir: string) {
  // Each test gets an isolated DB by running from a unique cwd (tempDir).
  // The plugin reads process.cwd() for projectDir — no fake env var needed.
  const { default: plugin } = await import("../../src/adapters/openclaw/plugin.js");
  const mock = createMockApiFull();
  await plugin.register(mock.api);
  return mock;
}

// ═══════════════════════════════════════════════════════════
// Mock helpers (from openclaw-plugin-hooks.test.ts)
// ═══════════════════════════════════════════════════════════

interface RegisteredHook {
  hookName: string;
  handler: (...args: unknown[]) => unknown;
  opts?: { priority?: number };
}

export function createMockApiHooks(withLogger = false) {
  const hooks: RegisteredHook[] = [];
  const typedHooks: RegisteredHook[] = [];
  const logLines: { level: string; args: unknown[] }[] = [];

  const logger = withLogger
    ? {
        info: (...args: unknown[]) => logLines.push({ level: "info", args }),
        error: (...args: unknown[]) => logLines.push({ level: "error", args }),
        debug: (...args: unknown[]) => logLines.push({ level: "debug", args }),
        warn: (...args: unknown[]) => logLines.push({ level: "warn", args }),
      }
    : undefined;

  const api = {
    registerHook(event: string, handler: (...args: unknown[]) => unknown, _meta: unknown) {
      hooks.push({ hookName: event, handler });
    },
    on(hookName: string, handler: (...args: unknown[]) => unknown, opts?: { priority?: number }) {
      typedHooks.push({ hookName, handler, opts });
    },
    registerContextEngine(_id: string, _factory: () => unknown) {},
    registerCommand(_cmd: unknown) {},
    logger,
  };

  return { api, hooks, typedHooks, logLines };
}
