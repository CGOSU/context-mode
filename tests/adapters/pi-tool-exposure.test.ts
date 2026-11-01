import "../setup-home";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapMCPTools, MCPStdioClient, type PiLikeAPI, type PiToolRegistration,
} from "../../src/adapters/pi/mcp-bridge.js";

const core = ["ctx_execute", "ctx_execute_file", "ctx_index", "ctx_search", "ctx_fetch_and_index", "ctx_batch_execute"];
const maintenance = ["ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge", "ctx_insight"];
const names = [...core, ...maintenance, "future_tool"];

afterEach(() => vi.restoreAllMocks());

async function register(discovery: Partial<PiLikeAPI> = {}) {
  const tools: PiToolRegistration[] = [];
  vi.spyOn(MCPStdioClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(MCPStdioClient.prototype, "initialize").mockResolvedValue();
  vi.spyOn(MCPStdioClient.prototype, "listTools").mockResolvedValue(names.map(name => ({
    name, description: "MCP tool", inputSchema: {
      type: "object", properties: { confirm: { type: "boolean" } }, required: ["confirm"],
    },
  })));
  vi.spyOn(MCPStdioClient.prototype, "shutdown").mockImplementation(() => {});
  const call = vi.spyOn(MCPStdioClient.prototype, "callTool").mockImplementation(async (name, args) => ({
    content: [{ type: "text", text: JSON.stringify({ name, args }) }],
  }));
  const handle = await bootstrapMCPTools({ registerTool: tool => tools.push(tool), ...discovery }, "/unused/server.mjs", {
    _resolveJsRuntime: () => process.execPath,
  });
  return { tools, handle, call };
}

describe("Pi low-frequency tool exposure", () => {
  it.each(["codemode", "tool_search"])("keeps maintenance discoverable through active %s", async name => {
    const { tools, handle, call } = await register({
      getActiveTools: () => [name, "read"],
      getAllTools: () => [{ name, reachesTools: () => "all" }],
    });
    try {
      expect(handle.tools).toEqual(names);
      expect(tools.filter(t => t.exposure === "direct").map(t => t.name)).toEqual([...core, "future_tool"]);
      expect(tools.filter(t => t.exposure === "deferred").map(t => t.name)).toEqual(maintenance);
      // A deferred registration is still the same callable tool, with the same
      // arguments and validation requirements. No real purge/upgrade is run.
      for (const name of maintenance) {
        const tool = tools.find(t => t.name === name)!;
        expect(tool.parameters).toMatchObject({ required: ["confirm"] });
        const result = await tool.execute("discovered", { confirm: true });
        expect(JSON.parse(result.content[0].text)).toEqual({ name, args: { confirm: true } });
      }
      call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Purge scope is ambiguous" }] });
      await expect(tools.find(t => t.name === "ctx_purge")!.execute("invalid", { confirm: true }))
        .rejects.toThrow("Purge scope is ambiguous");
    } finally { handle.shutdown(); }
  });

  it.each([
    { label: "legacy host", api: {} },
    { label: "inactive discovery", api: {
      getActiveTools: () => ["read"],
      getAllTools: () => [{ name: "codemode", reachesTools: () => "all" }],
    } },
    { label: "unverified name-only discovery", api: {
      getActiveTools: () => ["codemode"], getAllTools: () => [{ name: "codemode" }],
    } },
    { label: "unrelated orchestrator", api: {
      getActiveTools: () => ["other"], getAllTools: () => [{ name: "other", reachesTools: () => "all" }],
    } },
  ])("preserves access on $label", async ({ api }) => {
    const { tools, handle } = await register(api);
    try {
      expect(tools.filter(t => t.exposure === "direct").map(t => t.name)).toEqual(names);
      const result = await tools.find(t => t.name === "ctx_doctor")!.execute("fallback", { confirm: true });
      expect(JSON.parse(result.content[0].text).name).toBe("ctx_doctor");
    } finally { handle.shutdown(); }
  });
});
