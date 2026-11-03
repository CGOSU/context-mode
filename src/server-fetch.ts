import { readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, cpus } from "node:os";
import { z } from "zod";
import { runPool, type PoolJob } from "./runPool.js";
import { type IndexResult } from "./store.js";
import { composeFetchCacheKey } from "./fetch-cache.js";
import { charSafePrefix } from "./truncate.js";
import { emitCacheHitEvent } from "./session/event-emit.js";
import { type FetchOneResult, ssrfGuard, formatFetchTtl, buildFetchCode } from "./server-fetch-code.js";
import { coerceJsonArray, coerceBoolean } from "./server-input.js";
import type { ServerToolContext } from "./server.js";

export function registerFetchTool(context: ServerToolContext): void {
  const { getStore, executor, currentAttribution, trackIndexed, server, trackResponse, sessionStats, getSessionDbPath } = context;


// ─────────────────────────────────────────────────────────
// fetch_and_index helpers — split into parallel-safe fetch and serial-only index
// ─────────────────────────────────────────────────────────

const FETCH_TTL_MS = 24 * 60 * 60 * 1000;
 // 24 hours
const FETCH_PREVIEW_LIMIT = 3072;


async function fetchOneUrl(url: string, source: string | undefined, force: boolean | undefined, ttl: number | undefined): Promise<FetchOneResult> {
  // SSRF guard — reject file://, javascript:, loopback, RFC1918, IMDS, link-local
  // BEFORE any cache lookup or subprocess spawn. Even cached entries shouldn't
  // serve a previously-poisoned source label.
  const ssrfBlock = await ssrfGuard(url);
  if (ssrfBlock) return ssrfBlock;

  if (!force && ttl !== 0) {
    const store = getStore();
    // Cache key composes (source, url) so two distinct URLs sharing the same
    // `source` label do not collide — they each get their own cache slot
    // (commit 1f1243e regression test enforced).
    const cacheKey = composeFetchCacheKey(source, url);
    const meta = store.getSourceMeta(cacheKey);
    if (meta) {
      const indexedAt = new Date(meta.indexedAt + "Z"); // SQLite datetime is UTC without Z
      const ageMs = Date.now() - indexedAt.getTime();
      const cacheTtlMs = ttl ?? FETCH_TTL_MS;
      if (ageMs < cacheTtlMs) {
        const ageHours = Math.floor(ageMs / (60 * 60 * 1000));
        const ageMin = Math.floor(ageMs / (60 * 1000));
        const ageStr = ageHours > 0 ? `${ageHours}h ago` : ageMin > 0 ? `${ageMin}m ago` : "just now";
        const estimatedBytes = meta.chunkCount * 1600; // ~1.6KB/chunk avg
        return { kind: "cached", label: meta.label, chunkCount: meta.chunkCount, estimatedBytes, ageStr, ttlStr: formatFetchTtl(cacheTtlMs) };
      }
      // Stale — fall through to re-fetch silently
    }
  }

  const outputPath = join(tmpdir(), `ctx-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.dat`);
  try {
    const fetchCode = buildFetchCode(url, outputPath);
    const result = await executor.execute({
      language: "javascript",
      code: fetchCode,
      timeout: 30_000,
    });
    if (result.exitCode !== 0) {
      // Subprocess fetch failure — undici / fetch can surface EAI_AGAIN /
      // ETIMEDOUT / ENETUNREACH in stderr when the resolver is overloaded
      // or the network is briefly unavailable. Append the same retry hint
      // ssrfGuard's pre-flight DNS path emits so the agent doesn't capitulate
      // to training data on the first transient failure (PR #654 substitute —
      // sibling-tool consistency with hooks/core/routing.mjs WebFetch wording).
      const raw = result.stderr || result.stdout || "unknown error";
      const isTransientDns = /\b(EAI_AGAIN|ETIMEDOUT|ETIMEOUT|ENETUNREACH|EPERM|getaddrinfo)\b/.test(raw);
      const hint = isTransientDns
        ? " — transient DNS error; retry once before falling back. If it keeps failing, the MCP host may be running under a network sandbox; restart the host with network access enabled."
        : "";
      return { kind: "fetch_error", url, error: `${raw}${hint}`, reason: "exit" };
    }
    const header = (result.stdout || "").trim();
    let markdown: string;
    try {
      // Parent-side defense-in-depth on the subprocess output size. The
      // embedded safeText() in buildFetchCode already caps before writing,
      // but a torn write (subprocess killed mid-write, fs cache desync,
      // etc.) could still leave an oversized file. Bail before slurping
      // multiple gigabytes into the long-running MCP server's heap.
      const MAX_FETCH_OUTPUT_BYTES = 50 * 1024 * 1024;
      const fileSize = statSync(outputPath).size;
      if (fileSize > MAX_FETCH_OUTPUT_BYTES) {
        return { kind: "fetch_error", url, error: `subprocess output ${fileSize} bytes exceeds cap ${MAX_FETCH_OUTPUT_BYTES}`, reason: "read" };
      }
      markdown = readFileSync(outputPath, "utf-8").trim();
    } catch {
      return { kind: "fetch_error", url, error: "could not read subprocess output", reason: "read" };
    }
    if (markdown.length === 0) {
      return { kind: "fetch_error", url, error: "empty content", reason: "empty" };
    }
    return { kind: "fetched", url, source, markdown, header };
  } catch (err: unknown) {
    return {
      kind: "fetch_error",
      url,
      error: err instanceof Error ? err.message : String(err),
      reason: "throw",
    };
  } finally {
    try { rmSync(outputPath); } catch { /* already gone */ }
  }
}


interface IndexedFetchResult {
  label: string;
  totalChunks: number;
  totalBytes: number;
  preview: string;
}


/**
 * Serial-only indexing step — single FTS5 write per call. Caller loops over
 * fetched results and calls this one-at-a-time to avoid SQLite WAL contention
 * (PRD finding E).
 */
function indexFetched(f: { url: string; source?: string; markdown: string; header: string }): IndexedFetchResult {
  const store = getStore();
  // Storage label composed via composeFetchCacheKey so two URLs sharing a
  // `source` label do not overwrite each other (commit 1f1243e). ctx_search()
  // still finds both via LIKE-mode source filter on the `source` substring.
  const storageLabel = composeFetchCacheKey(f.source, f.url);
  const attribution = currentAttribution();
  let indexed: IndexResult;
  if (f.header === "__CM_CT__:json") {
    indexed = store.indexJSON(f.markdown, storageLabel, undefined, attribution);
  } else if (f.header === "__CM_CT__:text") {
    indexed = store.indexPlainText(f.markdown, storageLabel, undefined, attribution);
  } else {
    indexed = store.index({ content: f.markdown, source: storageLabel, attribution });
  }
  // Track AFTER the FTS5 write succeeds — failed indexes shouldn't inflate the counter.
  trackIndexed(Buffer.byteLength(f.markdown));
  const preview = f.markdown.length > FETCH_PREVIEW_LIMIT
    ? charSafePrefix(f.markdown, FETCH_PREVIEW_LIMIT) + "\n\n…[truncated — use ctx_search() for full content]"
    : f.markdown;
  return {
    label: indexed.label,
    totalChunks: indexed.totalChunks,
    totalBytes: Buffer.byteLength(f.markdown),
    preview,
  };
}


server.registerTool(
  "ctx_fetch_and_index",
  {
    title: "Fetch & Index URL(s)",
    // #846: fetches external URLs (open world) and writes them into the store.
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    description: `Fetches URL content, converts HTML to markdown (JSON is chunked by key paths, plain text indexed directly), persists it in a searchable knowledge base, and returns a small preview window per source. The raw page bytes never enter your conversation — they live in storage and you retrieve any section on-demand via ctx_search.

Caching: every fetch is cached on disk and reused for repeat calls within the TTL window. The default TTL is 24 hours; override per-call with the \`ttl\` parameter (milliseconds, \`ttl: 0\` bypasses cache like \`force: true\`). Stored content older than 14 days is cleaned up on startup.

WHEN:
  - You need web content (docs, changelogs, API references, spec pages) and the raw page bytes should NOT enter your conversation
  - Multi-URL research (library evaluation, migration scans, doc comparisons): pass the \`requests\` array and a \`concurrency\` value 2-8 for parallel I/O
  - You want repeat lookups against the same URL to be cheap (TTL cache hits return only a hint, no re-fetch)
  - You want a long-lived cache window (override \`ttl\` upward for stable specs) or a guaranteed-fresh fetch (\`ttl: 0\` or \`force: true\`)

WHEN NOT:
  - You already have the content locally — store it via the inline index tool
  - The page is SPA-rendered (JavaScript-required to materialize content) — this is a plain HTTP fetch, no headless browser

RETURNS:
  Per-source preview windows extracted around indexable headings plus indexing metadata (chunk counts, source labels, cache state). Raw content is NOT echoed back — retrieve any section on-demand via ctx_search(source: "<label>"). Concurrency parallelizes the fetch phase up to your chosen value (capped by the host's logical CPU count); the FTS5 write phase always runs serially because SQLite is a single-writer store. Net latency = max(fetch latency across the pool) + sum(per-source index write time). Cache hits skip both phases and return a small freshness hint instead of re-fetching. Use 4-8 for stable I/O-bound batches; lower the value when the target host enforces a per-IP rate limit you cannot raise.

EXAMPLE: ctx_fetch_and_index(
  requests: [{url: "https://react.dev/...", source: "react"}, {url: "https://vuejs.org/...", source: "vue"}],
  concurrency: 5
)`,
    inputSchema: z.object({
      url: z.string().optional().describe("Single URL to fetch and index (legacy single-shape)"),
      source: z
        .string()
        .optional()
        .describe(
          "Label for the indexed content when using single `url` (e.g., 'React useEffect docs', 'Supabase Auth API'). For batch, put source in each requests entry.",
        ),
      requests: z
        .preprocess(
          coerceJsonArray,
          z.array(
            z.object({
              url: z.string().describe("URL to fetch"),
              source: z.string().optional().describe("Label for this URL's indexed content"),
            }),
          ).min(1),
        )
        .optional()
        .describe(
          "Batch shape: array of {url, source?} entries. Use with concurrency>1 for parallel fetch. " +
          "Each request indexed under its own source label. Output preserves input order.",
        ),
      concurrency: z
        .coerce.number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .default(1)
        .describe(
          "Max URLs to fetch in parallel (1-8, default: 1). " +
          "Use 4-8 for I/O-bound multi-URL batches (library docs, changelogs, pricing pages). " +
          "Capped by os.cpus().length on small machines (response notes when capped). " +
          "Indexing is always serial regardless — only fetches race.",
        ),
      force: z
        .preprocess(coerceBoolean, z.boolean())
        .optional()
        .describe("Skip cache and re-fetch even if content was recently indexed"),
      ttl: z
        .coerce.number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Override the cache freshness window for this call, in milliseconds. " +
          "`ttl: 0` bypasses the cache like `force: true`; omit to use the default 24h TTL.",
        ),
    }),
  },
  async ({ url, source, requests, concurrency, force, ttl }) => {
    // Normalize input: legacy {url} or new {requests: [...]}.
    // requests wins when both are provided (explicit batch intent).
    const batch: { url: string; source?: string }[] = requests
      ? requests
      : url
        ? [{ url, source }]
        : [];

    if (batch.length === 0) {
      return trackResponse("ctx_fetch_and_index", {
        content: [{
          type: "text" as const,
          text: "ctx_fetch_and_index requires either `url` (single) or `requests: [{url, source?}, ...]` (batch).",
        }],
        isError: true,
      });
    }

    const isLegacySingle = !requests && batch.length === 1;
    const requestedConcurrency = concurrency ?? 1;

    // Parallel fetch via shared runPool primitive. capByCpuCount only for batch
    // — single-URL doesn't need the cap (only one job, executor is one subprocess).
    const jobs: PoolJob<FetchOneResult>[] = batch.map((req) => ({
      run: () => fetchOneUrl(req.url, req.source, force, ttl),
    }));
    const { settled, effectiveConcurrency, capped } = await runPool(jobs, {
      concurrency: requestedConcurrency,
      capByCpuCount: !isLegacySingle && requestedConcurrency > 1,
    });

    // Serial index drain — workers race on fetch, but store.index* runs one at a time.
    type Finalized =
      | { kind: "cached"; label: string; chunkCount: number; ageStr: string; ttlStr: string }
      | { kind: "fetched"; indexed: IndexedFetchResult }
      | { kind: "fetch_error"; url: string; error: string; reason: "exit" | "read" | "empty" | "throw" }
      | { kind: "job_error"; url: string; error: string };

    const finalized: Finalized[] = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === "rejected") {
        const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
        finalized.push({ kind: "job_error", url: batch[i].url, error: message });
        continue;
      }
      const v = r.value;
      if (v.kind === "cached") {
        sessionStats.cacheHits++;
        sessionStats.cacheBytesSaved += v.estimatedBytes;
        // D2 Phase 5/7 — cache-hit event emission. `bytes_avoided` is the
        // size of the cached payload that would have re-entered context
        // had the TTL window missed. Best-effort, off the hot path.
        const cachedBytes = v.estimatedBytes;
        const cachedLabel = v.label;
        setImmediate(() =>
          emitCacheHitEvent({
            sessionDbPath: getSessionDbPath(),
            source: cachedLabel,
            bytesAvoided: cachedBytes,
          })
        );
        finalized.push({ kind: "cached", label: v.label, chunkCount: v.chunkCount, ageStr: v.ageStr, ttlStr: v.ttlStr });
      } else if (v.kind === "fetch_error") {
        finalized.push({ kind: "fetch_error", url: v.url, error: v.error, reason: v.reason });
      } else {
        // Serial FTS5 write here — no parallel store.index calls.
        // Cache miss: the URL was not in the TTL window so we paid the
        // network round-trip + re-indexed. Counted here so ctx_stats can
        // report nominal cache_hit_rate alongside the existing hit metrics.
        sessionStats.cacheMisses++;
        finalized.push({ kind: "fetched", indexed: indexFetched(v) });
      }
    }

    // Backward-compat single-URL response shape — preserve the EXACT original wording.
    if (isLegacySingle) {
      const r = finalized[0];
      if (r.kind === "cached") {
        return trackResponse("ctx_fetch_and_index", {
          content: [{
            type: "text" as const,
            text: `Cached: **${r.label}** — ${r.chunkCount} sections, indexed ${r.ageStr} (fresh, TTL: ${r.ttlStr}).\nTo refresh: call ctx_fetch_and_index again with \`force: true\`.\n\nYou MUST call ctx_search() to answer questions about this content — this cached response contains no content.\nUse: ctx_search(queries: [...], source: "${r.label}")`,
          }],
        });
      }
      if (r.kind === "fetched") {
        const totalKB = (r.indexed.totalBytes / 1024).toFixed(1);
        const text = [
          `Fetched and indexed **${r.indexed.totalChunks} sections** (${totalKB}KB) from: ${r.indexed.label}`,
          `Full content indexed in sandbox — use ctx_search(queries: [...], source: "${r.indexed.label}") for specific lookups.`,
          "",
          "---",
          "",
          r.indexed.preview,
        ].join("\n");
        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text }],
        });
      }
      // fetch_error — preserve original error wording per reason
      if (r.kind === "fetch_error") {
        const text =
          r.reason === "empty" ? `Fetched ${r.url} but got empty content`
          : r.reason === "read" ? `Fetched ${r.url} but could not read subprocess output`
          : r.reason === "exit" ? `Failed to fetch ${r.url}: ${r.error}`
          : /* throw */         `Fetch error: ${r.error}`;
        return trackResponse("ctx_fetch_and_index", {
          content: [{ type: "text" as const, text }],
          isError: true,
        });
      }
      // job_error
      return trackResponse("ctx_fetch_and_index", {
        content: [{ type: "text" as const, text: `Fetch error: ${r.error}` }],
        isError: true,
      });
    }

    // Batch response — aggregated summary; isError only when EVERY URL failed.
    // Per-URL preview capped tightly so a 8-URL batch doesn't undo the
    // context-savings the tool exists to deliver (PRD review finding G1).
    const FETCH_BATCH_PREVIEW_LIMIT = 384; // ~3KB total for 8-URL batches
    const lines: string[] = [];
    let totalSections = 0;
    let totalBytes = 0;
    let cachedCount = 0;
    let fetchedCount = 0;
    let errorCount = 0;
    const snippets: string[] = [];
    for (const r of finalized) {
      if (r.kind === "cached") {
        cachedCount++;
        lines.push(`- [cache] ${r.label} — ${r.chunkCount} sections (${r.ageStr}, TTL: ${r.ttlStr})`);
      } else if (r.kind === "fetched") {
        fetchedCount++;
        totalSections += r.indexed.totalChunks;
        totalBytes += r.indexed.totalBytes;
        const kb = (r.indexed.totalBytes / 1024).toFixed(1);
        lines.push(`- [new]   ${r.indexed.label} — ${r.indexed.totalChunks} sections (${kb}KB)`);
        const snippet = r.indexed.preview.length > FETCH_BATCH_PREVIEW_LIMIT
          ? r.indexed.preview.slice(0, FETCH_BATCH_PREVIEW_LIMIT).trimEnd() + "…"
          : r.indexed.preview;
        snippets.push(`### ${r.indexed.label}\n\n${snippet}`);
      } else {
        errorCount++;
        lines.push(`- [err]   ${r.url}: ${r.error}`);
      }
    }

    const totalKB = (totalBytes / 1024).toFixed(1);
    const cappedNote = capped
      ? ` cap=${effectiveConcurrency}/${cpus().length}cpu`
      : "";
    // Status line: counts + sections + size, with singular/plural agreement
    // (count=1 → "1 error" not "1 errors") so the line stays grammatical.
    const fmt = (n: number, sing: string, plur: string) => `${n} ${n === 1 ? sing : plur}`;
    const headerLine =
      `fetched ${batch.length} c=${effectiveConcurrency}${cappedNote}. ` +
      `ok=${fetchedCount} cache=${cachedCount} err=${errorCount}. ` +
      `${fmt(totalSections, "section", "sections")} ${totalKB}KB.`;

    const text = [
      headerLine,
      "",
      ...lines,
      "",
      `ctx_search(queries: [...], source: "<label>") for full content.`,
      ...(snippets.length > 0 ? ["", "---", "", ...snippets] : []),
    ].join("\n");

    return trackResponse("ctx_fetch_and_index", {
      content: [{ type: "text" as const, text }],
      isError: errorCount === batch.length, // only mark error if every URL failed
    });
  },
);
}
