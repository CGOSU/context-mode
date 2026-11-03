/** Server regressions: server. */


import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import { sanitizeSchemaForStrictClients, REGISTERED_CTX_TOOLS } from "../../src/server.js";
import { stripJsonComments, parseJsonc } from "../../src/util/jsonc.js";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// #787 review regression, applied to server.ts: its local stripJsonComments
// ended with a whole-string trailing-comma regex that deleted commas INSIDE
// string values ("[1, ]" -> "[1 ]"). That corruption always leaves the JSON
// valid (only the comma char is deleted; the anchoring bracket stays), and
// shouldSuppressMcpToolsForNativePluginHost() — the only public surface over
// readNativePluginHostSettings() — checks just the plugin array for a
// "context-mode" substring and the mcp object for a "context-mode" key, so a
// deleted in-string comma can never flip the boolean ("context-mode" contains
// no comma to delete and no bracket to leave behind). Pin the fix
// structurally instead: server.ts must delegate to the shared string-aware
// src/util/jsonc.ts — whose in-string-comma behavior IS pinned by the
// "parseJsonc / stripJsonComments" suite below — and must not reintroduce a
// local whole-string trailing-comma regex.
test("server.ts delegates JSONC stripping to string-aware src/util/jsonc (#787 in-string trailing-comma regression)", async () => {
  const serverSrc = readServerSource();
  expect(serverSrc).toContain('from "./util/jsonc.js"');
  expect(serverSrc).not.toContain('.replace(/,(\\s*[}\\]])/g');
  // End-to-end sanity through the public boolean: a JSONC config that needs
  // the strip path (comment + real trailing comma) and embeds a
  // trailing-comma-like pattern inside a string value still parses and
  // suppresses.
  const { shouldSuppressMcpToolsForNativePluginHost } = await import("../../src/server.js");
  const dir = mkdtempSync(join(tmpdir(), "opencode-jsonc-comma-"));
  const cwd = process.cwd();
  try {
    writeFileSync(join(dir, "opencode.jsonc"), `{
      // forces the comment/trailing-comma strip path
      "note": "array literal: [1, ]",
      "plugin": ["context-mode"],
      "mcp": {
        "context-mode": { "type": "local", "command": ["context-mode"] }
      },
    }\n`);
    process.chdir(dir);
    expect(shouldSuppressMcpToolsForNativePluginHost({ platform: "opencode" })).toBe(true);
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});


// ─── src/util/jsonc — shared string-aware JSONC strip/parse (#787/#806) ─────
// The naive regex strippers that lived in src/server.ts and the OpenCode
// adapter corrupted string VALUES: `//` inside URLs was cut as a "comment"
// (#806), and a whole-string trailing-comma regex ate commas inside string
// literals ("[1, ]" -> "[1 ]", the 386a196 regression). These tests pin the
// shared util that replaced both.
describe("parseJsonc / stripJsonComments (src/util/jsonc)", () => {
  test("preserves // inside string values (URLs) while stripping line comments", () => {
    const jsonc = '{\n  // strip me\n  "url": "https://mcp.context7.com/mcp"\n}';
    expect(parseJsonc<{ url: string }>(jsonc)?.url).toBe("https://mcp.context7.com/mcp");
    expect(stripJsonComments('{"url": "https://example.com/x"}')).toBe('{"url": "https://example.com/x"}');
  });

  test("treats // after an escaped quote as still inside the string", () => {
    const jsonc = '{ // c\n "say": "say \\"hi\\" // not a comment" }';
    expect(parseJsonc<{ say: string }>(jsonc)?.say).toBe('say "hi" // not a comment');
  });

  test("parses CRLF input with line comments", () => {
    const jsonc = '{\r\n  // comment\r\n  "a": 1,\r\n  "b": 2\r\n}\r\n';
    expect(parseJsonc(jsonc)).toEqual({ a: 1, b: 2 });
  });

  test("removes trailing commas before } and ], including whitespace/comment-separated ones", () => {
    expect(parseJsonc('{ // c\n "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
    expect(parseJsonc('{ "a": 1, /* note */ }')).toEqual({ a: 1 });
  });

  test("strips a block comment containing a URL without touching neighbors", () => {
    const jsonc = '{ /* see https://example.com/docs */ "a": 1, // tail\n "b": 2 }';
    expect(parseJsonc(jsonc)).toEqual({ a: 1, b: 2 });
  });

  test("preserves a comma inside a string value (the 386a196 regression)", () => {
    const jsonc = '{\n  // forces the strip path\n  "note": "array literal: [1, ]"\n}';
    expect(parseJsonc<{ note: string }>(jsonc)?.note).toBe("array literal: [1, ]");
    expect(stripJsonComments('{"a":"x, ]","b":[1,]}')).toBe('{"a":"x, ]","b":[1]}');
  });

  test("plain valid JSON passes through parseJsonc unchanged", () => {
    const raw = '{"a": [1, 2], "u": "https://example.com", "s": "x, ]"}';
    expect(parseJsonc(raw)).toEqual(JSON.parse(raw));
  });

  test("returns undefined when input is not JSON at all", () => {
    expect(parseJsonc("not json at all {{")).toBeUndefined();
  });
});


// Gemini's function-calling API (Antigravity CLI `agy`, Gemini CLI) rejects
// JSON Schema `const` and `additionalProperties` and then silently drops the
// tool from the model's function list. The sanitizer rewrites the EMITTED
// tools/list schema in a behavior-preserving way so those tools become callable.
describe("sanitizeSchemaForStrictClients", () => {
  test("rewrites `const: X` to `enum: [X]` (an identical single-value constraint)", () => {
    expect(sanitizeSchemaForStrictClients({ const: "javascript" })).toEqual({ enum: ["javascript"] });
    expect(sanitizeSchemaForStrictClients({ const: 1 })).toEqual({ enum: [1] });
  });

  test("strips `additionalProperties` (advisory-only — Zod validates args server-side)", () => {
    const out = sanitizeSchemaForStrictClients({
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "string" } },
    }) as Record<string, unknown>;
    expect(out).not.toHaveProperty("additionalProperties");
    expect(out.type).toBe("object");
    expect(out.properties).toEqual({ a: { type: "string" } });
  });

  test("preserves every Gemini-compatible keyword unchanged", () => {
    // enum / pattern / default / minLength etc. are accepted by Gemini and must
    // pass through untouched so non-Gemini clients see an identical schema.
    const input = {
      type: "string",
      enum: ["a", "b"],
      pattern: "^x",
      default: "a",
      minLength: 1,
      description: "desc",
    };
    expect(sanitizeSchemaForStrictClients(input)).toEqual(input);
  });

  test("recurses through nested properties and arrays", () => {
    const input = {
      type: "object",
      additionalProperties: false,
      properties: {
        language: { const: "shell" },
        items: { type: "array", items: { const: 1 }, additionalProperties: true },
      },
    };
    expect(sanitizeSchemaForStrictClients(input)).toEqual({
      type: "object",
      properties: {
        language: { enum: ["shell"] },
        items: { type: "array", items: { enum: [1] } },
      },
    });
  });

  test("leaves primitives and null untouched", () => {
    expect(sanitizeSchemaForStrictClients("x")).toBe("x");
    expect(sanitizeSchemaForStrictClients(7)).toBe(7);
    expect(sanitizeSchemaForStrictClients(true)).toBe(true);
    expect(sanitizeSchemaForStrictClients(null)).toBe(null);
  });

  test("does not mutate the input object", () => {
    const input = { const: "x", additionalProperties: false };
    sanitizeSchemaForStrictClients(input);
    expect(input).toEqual({ const: "x", additionalProperties: false });
  });
});


describe("parseJsonc / stripJsonComments (src/util/jsonc)", () => {
  // Regression for the #787 review: the trailing-comma strip used to run a regex
  // over the WHOLE string, eating commas INSIDE string values. parseJsonc only
  // reaches the stripper when strict JSON.parse fails (a comment forces that),
  // so the corruption was silent.
  test("preserves a comma inside a string value on the comment-strip path", () => {
    const jsonc = '{\n  // forces the strip path\n  "note": "array literal: [1, ]"\n}';
    expect(parseJsonc<{ note: string }>(jsonc)?.note).toBe("array literal: [1, ]");
  });

  test("still strips real trailing commas (object, array, nested) once a comment forces the path", () => {
    expect(parseJsonc('{ // c\n "a": [1, 2,], "b": { "c": 3, }, }')).toEqual({ a: [1, 2], b: { c: 3 } });
  });

  test("strips a trailing comma even when a comment sits between it and the bracket", () => {
    expect(parseJsonc('{ "a": 1, /* note */ }')).toEqual({ a: 1 });
  });

  test("strips // line and /* */ block comments", () => {
    expect(parseJsonc('{\n  "a": 1, // line\n  /* block */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  test("keeps // and , inside string values intact (URL with trailing-comma-like text)", () => {
    const jsonc = '{ // c\n "u": "http://x.com/a, ]" }';
    expect(parseJsonc<{ u: string }>(jsonc)?.u).toBe("http://x.com/a, ]");
  });

  test("stripJsonComments removes a trailing comma but keeps an identical in-string one", () => {
    expect(stripJsonComments('{"a":"x, ]","b":[1,]}')).toBe('{"a":"x, ]","b":[1]}');
  });

  test("returns undefined when both strict and lenient parses fail", () => {
    expect(parseJsonc("not json at all {{")).toBeUndefined();
  });
});


// ─── ctx_* MCP tool annotations (#846) ───────────────────
// "Server & tools" domain → this file owns tool registration per CONTRIBUTING.md.
// Inspects the actual registered descriptors via the exported registry, not just
// descriptions, so a missing/incorrect annotation fails CI.
describe("ctx_* MCP tool annotations (#846)", () => {
  type Hints = {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  // Classified by real behavior (no blanket readOnlyHint).
  const EXPECTED: Record<string, Hints> = {
    ctx_execute:         { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },
    ctx_execute_file:    { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },
    ctx_index:           { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    ctx_search:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
    ctx_fetch_and_index: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true  },
    ctx_batch_execute:   { readOnlyHint: false, destructiveHint: true,  idempotentHint: false, openWorldHint: true  },
    ctx_stats:           { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
    ctx_doctor:          { readOnlyHint: true,  destructiveHint: false, idempotentHint: true,  openWorldHint: false },
    ctx_upgrade:         { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: false },
    ctx_purge:           { readOnlyHint: false, destructiveHint: true,  idempotentHint: true,  openWorldHint: false },
    ctx_insight:         { readOnlyHint: false, destructiveHint: false, idempotentHint: true,  openWorldHint: true  },
  };
  const tools = REGISTERED_CTX_TOOLS as Array<{ name: string; config: { annotations?: Hints } }>;
  const find = (name: string) => tools.find((t) => t.name === name);

  test("registers exactly the expected ctx_* tools", () => {
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  test("every ctx_* tool carries explicit annotations classified by real behavior", () => {
    for (const [name, hints] of Object.entries(EXPECTED)) {
      const tool = find(name);
      expect(tool, `${name} not registered`).toBeDefined();
      expect(tool!.config.annotations, `${name} missing annotations`).toBeDefined();
      expect(tool!.config.annotations).toMatchObject(hints);
    }
  });

  test("read-only diagnostic/query tools are readOnlyHint:true (the #846 cancellation fix)", () => {
    for (const name of ["ctx_search", "ctx_stats", "ctx_doctor"]) {
      expect(find(name)!.config.annotations!.readOnlyHint).toBe(true);
    }
  });

  test("never blanket-marks executing/mutating/destructive tools read-only", () => {
    for (const name of [
      "ctx_execute", "ctx_execute_file", "ctx_batch_execute", "ctx_index",
      "ctx_fetch_and_index", "ctx_purge", "ctx_upgrade", "ctx_insight",
    ]) {
      expect(find(name)!.config.annotations!.readOnlyHint).toBe(false);
    }
  });
});
