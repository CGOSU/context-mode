import "../setup-home";
import { describe, it, expect, vi } from "vitest";
import { bootstrapMCPTools, MCPStdioClient, type PiToolRegistration } from "../../src/adapters/pi/mcp-bridge.js";
import { piToolMetadata } from "../../src/adapters/pi/tool-metadata.js";

// Validation keywords (including nested schemas) must survive presentation changes.
function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, child]) => [key, withoutDescriptions(child)]));
  }
  return value;
}

describe("Pi-only tool metadata", () => {
  it("preserves validation schemas without mutating MCP metadata", () => {
    const inputSchema = {
      type: "object",
      additionalProperties: false,
      required: ["commands"],
      properties: {
        commands: {
          description: "Server command instructions",
          type: "array", minItems: 1,
          items: {
            type: "object", required: ["label", "command"],
            properties: { label: { type: "string" }, command: { type: "string", minLength: 1 } },
          },
        },
        concurrency: { type: "integer", minimum: 1, maximum: 8, default: 1, description: "Server concurrency instructions" },
        future: { anyOf: [{ type: "string" }, { type: "null" }], description: "Unknown field safety instructions" },
      },
    };
    const tool = { name: "ctx_batch_execute", description: "Server description", inputSchema };
    const original = structuredClone(tool);
    const compact = piToolMetadata(tool);
    expect(withoutDescriptions(compact.parameters)).toEqual(withoutDescriptions(inputSchema));
    expect((compact.parameters.properties as typeof inputSchema.properties).future).toEqual(inputSchema.properties.future);
    expect(tool).toEqual(original);
    expect(piToolMetadata({ name: "future_tool", description: "Future safety instructions", inputSchema }))
      .toEqual({ description: "Future safety instructions", parameters: inputSchema });
    expect(piToolMetadata({ name: "no_params" }).parameters).toEqual({ type: "object", properties: {} });
  });

  it("keeps tool registration, execution payloads, and MCP failures intact", async () => {
    const tools = ["ctx_execute", "ctx_execute_file", "ctx_index", "ctx_search", "ctx_fetch_and_index",
      "ctx_batch_execute", "ctx_stats", "ctx_doctor", "ctx_upgrade", "ctx_purge", "ctx_insight"]
      .map(name => ({ name, description: "MCP description", inputSchema: { type: "object", properties: {} } }));
    const registrations: PiToolRegistration[] = [];
    vi.spyOn(MCPStdioClient.prototype, "start").mockImplementation(() => {});
    vi.spyOn(MCPStdioClient.prototype, "initialize").mockResolvedValue();
    vi.spyOn(MCPStdioClient.prototype, "listTools").mockResolvedValue(tools);
    vi.spyOn(MCPStdioClient.prototype, "shutdown").mockImplementation(() => {});
    const call = vi.spyOn(MCPStdioClient.prototype, "callTool").mockImplementation(async (name, params) => ({
      content: [{ type: "text", text: JSON.stringify({ name, params }) }],
    }));
    try {
      const bridge = await bootstrapMCPTools({ registerTool: tool => registrations.push(tool) }, "/unused/server.mjs", {
        _resolveJsRuntime: () => process.execPath,
      });
      expect(bridge.tools).toEqual(tools.map(tool => tool.name));
      expect(registrations.map(tool => tool.name)).toEqual(bridge.tools);
      for (const tool of registrations) {
        expect(withoutDescriptions(tool.parameters)).toEqual({ type: "object", properties: {} });
        const params = { probe: tool.name };
        const result = await tool.execute("probe", params);
        expect(JSON.parse(result.content[0].text)).toEqual({ name: tool.name, params });
      }
      call.mockResolvedValueOnce({ isError: true, content: [{ type: "text", text: "Permission denied" }] });
      await expect(registrations[0].execute("failure", {})).rejects.toThrow("Permission denied");
      call.mockRejectedValueOnce(new Error("MCP transport unavailable"));
      await expect(registrations[0].execute("transport-failure", {})).rejects.toThrow("MCP transport unavailable");
      bridge.shutdown();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
