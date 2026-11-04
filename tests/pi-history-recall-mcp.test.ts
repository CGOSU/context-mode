import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SessionDB, resolveSessionDbPath } from "../src/session/db.js";

it("Pi historical hints can recall captured events before any document is indexed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-history-recall-"));
  const storage = join(root, "state");
  mkdirSync(join(storage, "sessions"), { recursive: true });
  const db = new SessionDB({ dbPath: resolveSessionDbPath({ projectDir: root, sessionsDir: join(storage, "sessions") }) });
  db.ensureSession("history-session", root);
  db.insertEvent("history-session", {
    type: "error_tool", category: "error", priority: 3,
    data: "captured-proof-needle: actual compiler failure details",
  }, "pi:v1:" + JSON.stringify({ hook: "PostToolUse", entryId: "result-entry" }), {
    projectDir: root, source: "workspace_root", confidence: 1,
  });
  db.close();

  const client = new Client({ name: "pi-coding-agent-context-mode-bridge", version: "1" }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve("server.bundle.mjs")], stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "", HOME: root, USERPROFILE: root,
      CONTEXT_MODE_DIR: storage, CONTEXT_MODE_PROJECT_DIR: root,
      PI_WORKSPACE_DIR: root, CLAUDE_PROJECT_DIR: root,
      CONTEXT_MODE_DISABLE_VERSION_CHECK: "1",
    },
  });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "ctx_search", arguments: {
      sort: "timeline", queries: ["captured-proof-needle"],
    } });
    expect(result.isError).not.toBe(true);
    expect((result.content as Array<{ text?: string }>).map(c => c.text ?? "").join("\n"))
      .toContain("actual compiler failure details");
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
