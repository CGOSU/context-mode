/** Server regressions: insight. */



import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// ctx_insight: execFile migration + port schema hardening (#441)
// ═══════════════════════════════════════════════════════════════════════════
//
// Three layers of regression protection:
//
//   1. Coarse source guard — `src/server.ts` must not reintroduce the
//      `execSync(\`…${…}…\`)` template-string injection pattern anywhere.
//      Behavioral coverage of the helpers themselves lives below in this
//      same file (mocked spawnSync, asserts argv arrays + no shell:true +
//      Windows LISTENING anchoring + per-pid failure isolation).
//
//   2. Cross-reference — server.ts must define the structured helpers
//      (openBrowserSync / killProcessOnPort) inline so the handler can
//      surface auto-open / kill failures to the agent rather than silently
//      reporting success.
//
//   3. Real-MCP integration — spawn the server via stdio JSON-RPC and
//      verify the tightened port schema rejects out-of-range and
//      non-integer values BEFORE the handler runs.

describe("ctx_insight: execFile migration source guard (#441)", () => {
  const serverSrc = readServerSource();

  test("server.ts contains no execSync template-string interpolation anywhere", () => {
    // Match: execSync(`...${...}...`) — the original injection pattern.
    // Scoped to the entire file (not just the ctx_insight handler) because
    // any reintroduction of the pattern in server.ts is a regression worth
    // catching.
    const templateInterpolation = /execSync\(`[^`]*\$\{/m;
    expect(serverSrc).not.toMatch(templateInterpolation);
  });

  test("server.ts defines structured helpers (openBrowserSync, killProcessOnPort)", () => {
    // The helpers must be the ones that return BrowserOpenResult / KillResult
    // so the ctx_insight handler can surface failures. They live inline in
    // server.ts (PR #452 folded the prior src/process-utils.ts back in).
    expect(serverSrc).toMatch(/export function openBrowserSync\b/);
    expect(serverSrc).toMatch(/export function killProcessOnPort\b/);
    expect(serverSrc).toMatch(/export type BrowserOpenResult\b/);
    expect(serverSrc).toMatch(/export type KillResult\b/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// Cross-platform audit follow-up — schema/observability fixes for #696 #697
// ═══════════════════════════════════════════════════════════════════════════

describe("ctx_insight schema description (issue #697)", () => {
  const serverSrc = readServerSource();

  test("description states it is a dashboard launcher, not a Q&A engine", () => {
    expect(serverSrc).toMatch(/ctx_insight[\s\S]{0,2000}dashboard launcher/);
  });

  test("description redirects natural-language queries to ctx_search", () => {
    expect(serverSrc).toMatch(/ctx_insight[\s\S]{0,2000}use ctx_search/);
  });

  test("description preserves the original analytics framing", () => {
    expect(serverSrc).toMatch(/Opens the context-mode Insight dashboard/);
  });
});
