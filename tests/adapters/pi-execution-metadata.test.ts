import { afterEach, expect, test, vi } from "vitest";
import { bootstrapMCPTools, MCPStdioClient, type MCPCallResult } from "../../src/adapters/pi/mcp-bridge.js";

afterEach(() => { vi.restoreAllMocks(); });

async function registeredTool(result: MCPCallResult) {
  // All child-process paths are stubbed. This tests the registered Pi callback
  // without launching an MCP server or touching a session directory.
  vi.spyOn(MCPStdioClient.prototype, "start").mockImplementation(() => {});
  vi.spyOn(MCPStdioClient.prototype, "initialize").mockResolvedValue(undefined);
  vi.spyOn(MCPStdioClient.prototype, "shutdown").mockImplementation(() => {});
  vi.spyOn(MCPStdioClient.prototype, "listTools").mockResolvedValue([
    { name: "ctx_execute", inputSchema: { type: "object" } },
  ]);
  vi.spyOn(MCPStdioClient.prototype, "callTool").mockResolvedValue(result);
  let tool: any;
  await bootstrapMCPTools({ registerTool: (registered) => { tool = registered; } }, "/unused/server.mjs", {
    env: {}, _resolveJsRuntime: () => "unused-node",
  });
  return tool;
}

test("Pi bridge preserves background state and batch metadata in successful results", async () => {
  const details = {
    execution: { status: "backgrounded", exitCode: null, source: "execution-run", outputIndexed: true },
    batch: { status: "completed", source: "batch-run", outcomes: [{ command: "test", exitCode: 0 }] },
  };
  const tool = await registeredTool({
    content: [{ type: "text", text: "still running" }], structuredContent: details,
  } as MCPCallResult);
  const response = await tool.execute("tool-call", {});
  expect(response.details).toEqual(details);
  expect(response.content[0].text).toBe("still running");
});

test("Pi bridge failed execution retains status and recall source in the thrown diagnostic", async () => {
  const text = 'Execution status: timed_out — timed out. Source: "saved-run". Partial diagnostic.';
  const tool = await registeredTool({
    content: [{ type: "text", text }], isError: true,
    structuredContent: { execution: { status: "timed_out", source: "saved-run" } },
  } as MCPCallResult);
  await expect(tool.execute("tool-call", {})).rejects.toThrow(text);
});
