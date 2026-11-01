import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod/v4";

// Exercise shipped schemas, not a copied approximation or the retired v3 converter.
const root = mkdtempSync(join(tmpdir(), "context-mode-schema-"));
const saved = { embedded: process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS, dir: process.env.CONTEXT_MODE_DIR };
process.env.CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS = "1";
process.env.CONTEXT_MODE_DIR = root;
const { REGISTERED_CTX_TOOLS } = await import("../../build/server.js");
afterAll(() => {
  for (const [key, value] of [["CONTEXT_MODE_EMBEDDED_PLUGIN_TOOLS", saved.embedded], ["CONTEXT_MODE_DIR", saved.dir]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function hostValidator(name: string) {
  const registered = REGISTERED_CTX_TOOLS.find((entry) => entry.name === name);
  if (!registered) throw new Error(`Missing tool ${name}`);
  return z.object(registered.config.inputSchema.shape);
}

const requests = [{ url: "https://example.com", source: "one" }, { url: "https://example.org", source: "two" }];
describe("shipped native Zod v4 host schema contract", () => {
  const schema = hostValidator("ctx_fetch_and_index");
  it("preserves JSON array, numeric and boolean preprocessing together", () => {
    expect(schema.parse({ requests: JSON.stringify(requests), concurrency: "3", force: "false", ttl: "0" }))
      .toMatchObject({ requests, concurrency: 3, force: false, ttl: 0 });
  });
  it("preserves native arrays, true strings and numeric values", () => {
    expect(schema.parse({ requests, concurrency: 2, force: "true", ttl: 60000 }))
      .toMatchObject({ requests, concurrency: 2, force: true, ttl: 60000 });
  });
  it("preserves single URL mode and the concurrency default", () => {
    expect(schema.parse({ url: "https://example.com" })).toMatchObject({ url: "https://example.com", concurrency: 1 });
  });
  it.each([{ concurrency: "abc" }, { concurrency: 0 }, { concurrency: 9 }, { concurrency: 1.5 }, { ttl: -1 }, { force: "not-a-bool" }, { requests: [] }, { requests: [{ url: 12 }] }])("rejects invalid input %j", (input) => {
    expect(schema.safeParse(input).success).toBe(false);
  });
  it("retains execute language validation and defaults", () => {
    const execute = hostValidator("ctx_execute");
    expect(execute.safeParse({ language: "unsupported", code: "x" }).success).toBe(false);
    expect(execute.parse({ language: "javascript", code: "1" })).toMatchObject({ background: false });
  });
});
