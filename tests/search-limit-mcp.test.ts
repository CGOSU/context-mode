import { expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

it("honors MCP result limits while retaining output budget and flood protection", async () => {
  const home = mkdtempSync(join(tmpdir(), "ctx-search-limit-"));
  const client = new Client({ name: "pi-coding-agent-context-mode-bridge", version: "1.0" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("server.bundle.mjs")],
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      CONTEXT_MODE_PROJECT_DIR: home,
      PI_WORKSPACE_DIR: home,
      CLAUDE_PROJECT_DIR: home,
      CONTEXT_MODE_SEARCH_WINDOW_MS: "60000",
      CONTEXT_MODE_SEARCH_MAX_RESULTS_AFTER: "3",
      CONTEXT_MODE_SEARCH_BLOCK_AFTER: "8",
    },
  });
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { error: result.isError, text: (result.content as Array<{ text?: string }>).map(c => c.text ?? "").join("\n") };
  };
  const count = (text: string) => (text.match(/^### /gm) ?? []).length;
  try {
    await client.connect(transport);
    for (let i = 0; i < 8; i++) {
      const indexed = await call("ctx_index", { source: `noise-${i}`, content: `# General ${i}\n${("orbit " + "padding ".repeat(18) + "handshake ").repeat(6)}` });
      expect(indexed.error).not.toBe(true);
    }
    const indexed = await call("ctx_index", { source: "answer", content: `# orbit handshake\n\`\`\`ts\nfunction orbit_handshake() { return 'orbit handshake'; }\n// ${"padding ".repeat(200)}\n\`\`\`` });
    expect(indexed.error).not.toBe(true);
    const defaults = await call("ctx_search", { queries: ["orbit handshake"] });
    const explicit = await call("ctx_search", { queries: ["orbit handshake"], limit: 5 });
    const budget = await call("ctx_search", { queries: Array(60).fill("orbit handshake"), limit: 5 });
    const soft = await call("ctx_search", { queries: ["orbit handshake"], limit: 5 });
    const empty = await call("ctx_search", { queries: ["zzzxxyyqqq"] });
    let blocked = empty;
    for (let i = 6; i <= 9; i++) blocked = await call("ctx_search", { queries: ["orbit handshake"] });
    for (const [query, result] of [["default", defaults], ["limit=5", explicit]] as const) {
      console.log(JSON.stringify({ query, firstSource: result.text.match(/\| ([^|\]]+)\] ---/)?.[1], results: count(result.text), bytes: Buffer.byteLength(result.text) }));
    }
    expect(defaults.error).not.toBe(true);
    expect(count(defaults.text)).toBe(3);
    expect(defaults.text.match(/\| ([^|\]]+)\] ---/)?.[1]).toBe("answer");
    expect(count(explicit.text)).toBe(5);
    expect(budget.text).toContain("(output cap reached)");
    expect(Buffer.byteLength(budget.text)).toBeLessThan(50 * 1024);
    expect(count(soft.text)).toBe(1);
    expect(count(empty.text)).toBe(0);
    expect(empty.text).toContain("No results found.");
    expect(blocked.error).toBe(true);
    expect(blocked.text).toContain("BLOCKED:");
  } finally {
    await client.close();
    rmSync(home, { recursive: true, force: true });
  }
}, 30000);
