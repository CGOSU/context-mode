/** Server regressions: fetch. */



import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";
import { ContentStore } from "../../src/store.js";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// ctx_fetch_and_index batch path — schema + handler-level checks
// (Full subprocess fetch tested in tests/mcp-integration.ts;
//  these tests verify schema acceptance + serial-index contract via source-level read.)
// ═══════════════════════════════════════════════════════════════════════════

describe("ctx_fetch_and_index batch refactor", () => {
  const fetchHandlerSrc = readServerSource();

  test("schema accepts both legacy {url} and batch {requests}", () => {
    expect(fetchHandlerSrc).toContain('url: z.string().optional()');
    expect(fetchHandlerSrc).toContain('requests: z');
    // Zod array of {url, source?} wrapped with preprocess for native plugin coercion
    expect(fetchHandlerSrc).toContain('z.preprocess(');
    expect(fetchHandlerSrc).toContain('coerceJsonArray');
    expect(fetchHandlerSrc).toContain('url: z.string()');
    expect(fetchHandlerSrc).toContain('source: z.string().optional()');
  });

  test("handler exposes concurrency 1-8 with default 1", () => {
    // Find the fetch_and_index registerTool block, then assert concurrency schema near it.
    // Stop anchor: the next registerTool call (ctx_batch_execute).
    const fetchBlockMatch = fetchHandlerSrc.match(/registerTool\(\s*"ctx_fetch_and_index"[\s\S]+?registerTool\(\s*"ctx_batch_execute"/);
    expect(fetchBlockMatch).not.toBeNull();
    const block = fetchBlockMatch![0];
    expect(block).toContain("concurrency: z");
    expect(block).toMatch(/\.min\(1\)\s*\n?\s*\.max\(8\)/);
    expect(block).toContain(".default(1)");
  });

  test("handler exposes per-call ttl override for fetch cache freshness (#648)", () => {
    const fetchBlockMatch = fetchHandlerSrc.match(/registerTool\(\s*"ctx_fetch_and_index"[\s\S]+?registerTool\(\s*"ctx_batch_execute"/);
    expect(fetchBlockMatch).not.toBeNull();
    const block = fetchBlockMatch![0];
    expect(block).toContain("ttl: z");
    expect(block).toContain("Override the cache freshness window");
    expect(block).toContain("`ttl: 0` bypasses the cache like `force: true`");
    expect(block).toContain("async ({ url, source, requests, concurrency, force, ttl })");
    expect(block).toContain("fetchOneUrl(req.url, req.source, force, ttl)");
  });

  test("fetchOneUrl applies ttl override and treats ttl=0 as cache bypass (#648)", () => {
    const fetchOneSrc = fetchHandlerSrc.match(/async function fetchOneUrl\([\s\S]+?const outputPath =/m);
    expect(fetchOneSrc).not.toBeNull();
    const block = fetchOneSrc![0];
    expect(block).toContain("ttl: number | undefined");
    expect(block).toContain("if (!force && ttl !== 0)");
    expect(block).toContain("const cacheTtlMs = ttl ?? FETCH_TTL_MS");
    expect(block).toContain("ageMs < cacheTtlMs");
    expect(block).toContain("ttlStr: formatFetchTtl(cacheTtlMs)");
  });

  test("PARALLELIZE I/O guidance + locked requests:[] schema in description", () => {
    // PR #683 / ADR-0002: emoji bullets replaced with prose. PR #683 WS3
    // (canonical structure) folded the dedicated CONCURRENCY: section into
    // the WHEN: / RETURNS: prose so the description carries only the
    // canonical four sections (WHEN / WHEN NOT / RETURNS / EXAMPLE).
    // PR #683 second amendment then deepened the concurrency guidance
    // (gh API cap 4, single-writer mechanism explanation) and reframed the
    // FTS5 serialization in more technical terms ("write phase always runs
    // serially because SQLite is a single-writer store").
    // This test pins the load-bearing concepts (requests:[] batch shape,
    // 4-8 I/O window, FTS5 serial-write contract) using semantic regexes
    // so future copy-edits don't break it.
    expect(fetchHandlerSrc).toMatch(/requests(:\s*\[|`\s*array)/);
    expect(fetchHandlerSrc).toMatch(/4-8\s+(for|stable)/);
    expect(fetchHandlerSrc).toMatch(/FTS5[^.]*(serializes? writes?|write phase[^.]*serial|single-writer)/);
  });

  test("serial-write contract: index drain is a for-loop calling indexFetched serially", () => {
    // The handler must NOT spawn parallel store.index calls. The drain is a
    // for-loop over `settled` calling indexFetched serially. Anti-pattern check.
    expect(fetchHandlerSrc).toContain("Serial index drain");
    expect(fetchHandlerSrc).toContain("indexFetched(v)");
    // No `await Promise.all(... indexFetched ...)` pattern anywhere
    expect(fetchHandlerSrc).not.toMatch(/Promise\.all\([^)]*indexFetched/);
  });

  test("backward compat: legacy single-URL response wording preserved", () => {
    // Original handler returned "Cached: **${label}**" / "Fetched and indexed **N sections**"
    // The refactor must keep these EXACT strings for the legacy path so
    // tests/mcp-integration.ts and any user-side scripts grepping the response don't break.
    expect(fetchHandlerSrc).toContain("Cached: **${r.label}**");
    expect(fetchHandlerSrc).toContain("Fetched and indexed **${r.indexed.totalChunks} sections**");
    // The source escapes backticks inside a template literal — match the escaped form.
    expect(fetchHandlerSrc).toContain("To refresh: call ctx_fetch_and_index again with");
    expect(fetchHandlerSrc).toContain("force: true");
  });

  test("isLegacySingle gate prevents batch response wrapping for single-URL calls", () => {
    expect(fetchHandlerSrc).toContain("const isLegacySingle = !requests && batch.length === 1");
    expect(fetchHandlerSrc).toContain("if (isLegacySingle)");
  });

  test("capped-concurrency note appears only when capped", () => {
    expect(fetchHandlerSrc).toMatch(/cappedNote\s*=\s*capped\s*\?/);
    // Compact form `cap=N/Mcpu` (replaces verbose "capped from N to M; M cores available").
    expect(fetchHandlerSrc).toContain("cap=${effectiveConcurrency}/${cpus().length}cpu");
  });

  test("batch isError only when ALL URLs fail (errorCount === batch.length)", () => {
    expect(fetchHandlerSrc).toContain("isError: errorCount === batch.length");
  });

  test("batch preview is capped to prevent context flooding (review F2)", () => {
    // Per-URL preview in batch mode capped tightly so an 8-URL batch doesn't
    // dump ~24KB of context (8 × 3072 char single-URL preview cap).
    expect(fetchHandlerSrc).toContain("FETCH_BATCH_PREVIEW_LIMIT");
    // Cap value must be ≤500 chars (8 URLs × 500 = ~4KB max snippets total)
    const limitMatch = fetchHandlerSrc.match(/FETCH_BATCH_PREVIEW_LIMIT\s*=\s*(\d+)/);
    expect(limitMatch).not.toBeNull();
    expect(parseInt(limitMatch![1])).toBeLessThanOrEqual(500);
    // Must actually be applied to per-URL previews in the batch loop
    expect(fetchHandlerSrc).toMatch(/preview\.length\s*>\s*FETCH_BATCH_PREVIEW_LIMIT/);
  });

  test("batch header uses singular form for count=1 (review F5 plural fix)", () => {
    // Grammar correctness in the compact status line: "1 errors" → "1 error"
    // via the fmt() helper, so the line stays grammatical at any count.
    expect(fetchHandlerSrc).toContain('const fmt = (n: number, sing: string, plur: string)');
    expect(fetchHandlerSrc).toContain('n === 1 ? sing : plur');
  });

  test("batch header uses compact format (review F5)", () => {
    // Old: "Batch fetched N URLs at concurrency=X (capped from Y to X; Z cores available): a fetched, b cached, c errors. d new sections (eKB total)."
    // New: "fetched N c=X cap=X/Zcpu. ok=a cache=b err=c. d sections eKB."
    expect(fetchHandlerSrc).toContain("`fetched ${batch.length} c=${effectiveConcurrency}");
    expect(fetchHandlerSrc).toContain("ok=${fetchedCount} cache=${cachedCount} err=${errorCount}");
    expect(fetchHandlerSrc).not.toContain("Batch fetched"); // old verbose wording gone
  });

  test("fetchOneUrl is parallel-safe (no SQLite writes)", () => {
    // Verify by inspecting the helper source: it calls store.getSourceMeta (read)
    // but never store.index/indexJSON/indexPlainText (writes).
    const fetchOneSrc = fetchHandlerSrc.match(/async function fetchOneUrl\([\s\S]+?^}/m);
    expect(fetchOneSrc).not.toBeNull();
    const block = fetchOneSrc![0];
    expect(block).toContain("store.getSourceMeta"); // read OK
    expect(block).not.toContain("store.index"); // no writes
    expect(block).not.toContain("store.indexJSON");
    expect(block).not.toContain("store.indexPlainText");
  });

  test("indexFetched is serial-only (single FTS5 write per call)", () => {
    const indexFetchedSrc = fetchHandlerSrc.match(/function indexFetched\([\s\S]+?^}/m);
    expect(indexFetchedSrc).not.toBeNull();
    const block = indexFetchedSrc![0];
    // Has exactly one of: store.index / store.indexJSON / store.indexPlainText per branch
    expect(block).toContain("store.indexJSON");
    expect(block).toContain("store.indexPlainText");
    expect(block).toContain("store.index");
  });

  test("force and requests parameters coerce string types from in-process native plugins", () => {
    // OpenCode/Kilo in-process plugin bridge stringifies primitive types
    // (boolean → "false", array → "[]"). z.preprocess(coerceBoolean/coerceJsonArray)
    // defends against this in the Zod parse step. This test verifies those
    // preprocess wrappers are present (issue #627 follow-up).
    const fetchBlockMatch = fetchHandlerSrc.match(/registerTool\(\s*"ctx_fetch_and_index"[\s\S]+?registerTool\(\s*"ctx_batch_execute"/);
    expect(fetchBlockMatch).not.toBeNull();
    const block = fetchBlockMatch![0];
    // force must coerce "false"/"true" strings → boolean
    expect(block).toMatch(/force:\s*z\s*\n?\s*\.preprocess\(\s*coerceBoolean\s*,\s*z\.boolean\(\)\)/);
    // requests must coerce JSON-stringified arrays
    expect(block).toMatch(/requests:\s*z\s*\n?\s*\.preprocess\(\s*coerceJsonArray\s*,/);
  });
});


// ═══════════════════════════════════════════════════════════════════════════
// ctx_fetch_and_index cache-key collision (Fix 6/10)
// ═══════════════════════════════════════════════════════════════════════════
//
// Bug: cache key was `source ?? url`, so two distinct URLs sharing a `source`
// label silently returned the cached first response instead of fetching the
// second. Fix composes the cache key from label+url for cache lookup.

describe("ctx_fetch_and_index cache key includes URL (Fix 6/10)", () => {
  test("composeFetchCacheKey: same label + different URLs produce different keys", async () => {
    const { composeFetchCacheKey } = await import("../../src/fetch-cache.js");
    const k1 = composeFetchCacheKey("Docs", "https://x.com/a");
    const k2 = composeFetchCacheKey("Docs", "https://y.com/b");
    expect(k1).not.toBe(k2);
  });

  test("composeFetchCacheKey: same label + same URL → same key (legitimate cache hit)", async () => {
    const { composeFetchCacheKey } = await import("../../src/fetch-cache.js");
    const k1 = composeFetchCacheKey("Docs", "https://x.com/a");
    const k2 = composeFetchCacheKey("Docs", "https://x.com/a");
    expect(k1).toBe(k2);
  });

  test("server.ts uses composeFetchCacheKey for cache lookup (no bare-label collision)", () => {
    const serverSrc = readServerSource();
    // The cache lookup may live in the handler block OR in an extracted helper
    // (post-refactor: `fetchOneUrl` is the parallel-safe fetcher invoked by both
    // single-URL and batch paths). Either location must use composeFetchCacheKey,
    // not the bare label/url variable.

    // composeFetchCacheKey must be imported and referenced
    expect(serverSrc).toContain('from "./fetch-cache.js"');
    expect(serverSrc).toContain("composeFetchCacheKey");

    // Find ANY getSourceMeta call across the file
    const lookupCall = serverSrc.match(/getSourceMeta\(\s*([^)]+)\s*\)/);
    expect(lookupCall, "getSourceMeta call missing").not.toBeNull();
    const arg = lookupCall![1].trim();
    // Must NOT be the bare `label` variable (that was the bug).
    expect(arg).not.toBe("label");
    // Argument must be a key derived from composition (`cacheKey`, `storageLabel`,
    // or a direct `composeFetchCacheKey(...)` call). Reject any single-token
    // identifier that doesn't carry the composition contract.
    expect(arg).toMatch(/cacheKey|storageLabel|composeFetchCacheKey/);
  });

  test("ContentStore: per-(label,url) keys do not collide on getSourceMeta", () => {
    const store = new ContentStore(":memory:");
    // Simulate two distinct URLs sharing a user-supplied "source" label,
    // but stored under composed keys per the fix.
    const URL_A = "https://example.com/a";
    const URL_B = "https://example.com/b";
    const labelA = `Docs::${URL_A}`;
    const labelB = `Docs::${URL_B}`;

    store.index({ content: "# A\nContent A unique alpha", source: labelA });
    // Before fix: a second cache lookup with the bare "Docs" label would
    // hit A's meta and short-circuit. After fix: lookup uses labelB → miss.
    expect(store.getSourceMeta(labelB)).toBeNull();
    // Cache hit for the same (label,url) still works.
    expect(store.getSourceMeta(labelA)).not.toBeNull();

    // Now index B and verify both remain searchable independently.
    store.index({ content: "# B\nContent B unique bravo", source: labelB });
    const aResults = store.search("alpha", 5, labelA);
    const bResults = store.search("bravo", 5, labelB);
    expect(aResults.length).toBeGreaterThan(0);
    expect(bResults.length).toBeGreaterThan(0);
    store.close();
  });
});


describe("ctx_fetch_and_index: response body size cap", () => {
  // ctx_fetch_and_index spawns a subprocess that fetches a URL, writes the
  // response body to a tmpfile, exits, and the parent reads the file back
  // into the long-running MCP server's heap via readFileSync. Without a
  // cap, an unexpectedly large endpoint (or a slowloris that keeps
  // appending chunks until the subprocess is killed) can either OOM the
  // subprocess or, worse, propagate a multi-GB response into the parent
  // heap and crash the MCP server. Cap to 50 MB on both ends.

  const SERVER_SOURCE = readServerSource();

  test("subprocess buildFetchCode caps response via Content-Length and post-text length", () => {
    expect(SERVER_SOURCE).toContain("const MAX_FETCH_BYTES = 50 * 1024 * 1024;");
    expect(SERVER_SOURCE).toContain("async function safeText(resp)");
    // The three response paths (JSON, HTML, default) all route through safeText
    // instead of resp.text() directly.
    const buildFetchSrc = SERVER_SOURCE.slice(
      SERVER_SOURCE.indexOf("export function buildFetchCode"),
      SERVER_SOURCE.indexOf("// fetch_and_index helpers"),
    );
    expect(buildFetchSrc.length).toBeGreaterThan(0);
    expect(buildFetchSrc.match(/await safeText\(resp\)/g)?.length).toBeGreaterThanOrEqual(3);
    // The pre-fix call sites (one per content-type branch) routed through
    // `await resp.text()` directly. Now only one such call survives,
    // inside safeText itself. Count exactly one.
    const directCalls = buildFetchSrc.match(/await resp\.text\(\)/g) ?? [];
    expect(directCalls.length).toBe(1);
  });

  test("parent-side fetchOneUrl stat-gates outputPath before readFileSync", () => {
    const fetchOneUrlSrc = SERVER_SOURCE.slice(
      SERVER_SOURCE.indexOf("async function fetchOneUrl"),
      SERVER_SOURCE.indexOf("async function fetchOneUrl") + 6000,
    );
    expect(fetchOneUrlSrc).toContain("MAX_FETCH_OUTPUT_BYTES = 50 * 1024 * 1024");
    expect(fetchOneUrlSrc).toMatch(/statSync\(outputPath\)\.size/);
    expect(fetchOneUrlSrc).toMatch(/fileSize > MAX_FETCH_OUTPUT_BYTES/);
  });
});
