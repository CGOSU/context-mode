import type { HookInput, SessionEvent } from "./extract-types.js";
import { safeString } from "./extract-common.js";
import {
  lookupPrice as catalogLookupPrice,
  computeCostUsd as catalogComputeCostUsd,
} from "./pricing.js";

/**
 * Per-model USD pricing now lives in the curated multi-vendor catalog
 * (src/pricing/catalog.ts), which prices each model from ITS OWN row across
 * Anthropic / OpenAI / Google / Chinese / other vendors. This kills the old
 * bug where the hardcoded Anthropic-only table here billed every non-Claude
 * model at Claude-Sonnet's `default` rate. Unknown ids now resolve to a null
 * cost (one console.warn) instead of a silently wrong Claude rate.
 *
 * resolveModelId picks the first non-empty model id from the hook candidates;
 * date-suffixed ids (e.g. claude-haiku-4-5-20251001) are reduced to a catalog
 * hit by progressively dropping trailing `-segment` suffixes (NO regex).
 */
function resolveModelId(input: HookInput, parsedResp: Record<string, unknown>): string {
  const candidates: unknown[] = [
    input.tool_input?.model,
    (input as unknown as Record<string, unknown>).model,
    parsedResp.model,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/**
 * Drop one trailing `-<segment>` from a model id, char-algorithmically (no
 * regex): walks back to the last '-' and returns the head, or null when there
 * is no usable separator. Lets a date-suffixed id fall back to its base id
 * (claude-haiku-4-5-20251001 → claude-haiku-4-5 → … ) one segment at a time.
 */
function dropTrailingSegment(id: string): string | null {
  for (let i = id.length - 1; i > 0; i--) {
    if (id.charCodeAt(i) === 45 /* '-' */) return id.slice(0, i);
  }
  return null;
}

/**
 * Resolve a model id to one the catalog can price: try the raw id, then
 * progressively trim trailing `-segment` suffixes so a date-suffixed id still
 * prices off its base model. Probes with lookupPrice (no warn) and returns the
 * first id that hits, or "" on a full miss — so cost compute warns at most once.
 */
function resolveCatalogId(modelId: string): string {
  let candidate: string | null = modelId;
  while (candidate && candidate.length > 0) {
    if (catalogLookupPrice(candidate) !== null) return candidate;
    candidate = dropTrailingSegment(candidate);
  }
  return "";
}

/**
 * Cost for a turn via the catalog. Returns null on a price miss (catalog emits
 * one console.warn of the unmatched id) or when all token buckets are zero.
 */
function computeTurnCostUsd(
  modelId: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
): number | null {
  const resolved = resolveCatalogId(modelId);
  // Feed the resolved id when found; otherwise pass the raw id so the catalog's
  // single miss-warning carries the id the operator actually saw.
  return catalogComputeCostUsd(resolved || modelId, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_tokens: cacheCreationTokens,
    cache_read_tokens: cacheReadTokens,
  });
}

/**
 * Format a cost to a compact `cost_usd` string, char-algorithmically (no
 * regex). Renders 6 decimals, drops trailing zeros, and keeps a single `.0`
 * when the fraction trims to empty (e.g. 0 → "0.0"), matching the prior
 * `.toFixed(6).replace(...)` output exactly.
 */
function formatCostUsd(cost: number): string {
  let s = cost.toFixed(6);
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 48 /* '0' */) end--;
  s = s.slice(0, end);
  if (s.length > 0 && s.charCodeAt(s.length - 1) === 46 /* '.' */) s += "0";
  return s;
}

/**
 * AgentOutput.usage capture — fires on the Task sub-agent dispatcher.
 * Captures the 7 cost/perf fields from sdk-tools.d.ts:64-75. Derives
 * cost_usd from per-model pricing (Gap #1 fix). The platform persists
 * these as typed columns post-release; the bridge emits them as
 * structured tokens in event.data for forward-compatible ingestion.
 */
export function extractAgentUsage(input: HookInput): SessionEvent[] {
  if (input.tool_name !== "Task") return [];
  const resp = input.tool_response;
  if (typeof resp !== "string" || resp.length === 0) return [];

  let parsed: unknown;
  try { parsed = JSON.parse(resp); } catch { return []; }
  if (!parsed || typeof parsed !== "object") return [];

  const out = parsed as Record<string, unknown>;
  const usage = (out.usage && typeof out.usage === "object")
    ? out.usage as Record<string, unknown>
    : {};

  const hasSignal =
    typeof out.totalTokens === "number" ||
    typeof out.totalDurationMs === "number" ||
    typeof usage.input_tokens === "number" ||
    typeof usage.output_tokens === "number" ||
    typeof usage.service_tier === "string";
  if (!hasSignal) return [];

  const parts: string[] = [];
  if (typeof out.totalTokens === "number") parts.push(`totalTokens:${out.totalTokens}`);
  if (typeof out.totalDurationMs === "number") parts.push(`totalDurMs:${out.totalDurationMs}`);
  if (typeof usage.input_tokens === "number") parts.push(`tokens_in:${usage.input_tokens}`);
  if (typeof usage.output_tokens === "number") parts.push(`tokens_out:${usage.output_tokens}`);
  if (typeof usage.cache_creation_input_tokens === "number") {
    parts.push(`cache_create:${usage.cache_creation_input_tokens}`);
  }
  if (typeof usage.cache_read_input_tokens === "number") {
    parts.push(`cache_read:${usage.cache_read_input_tokens}`);
  }
  if (typeof usage.service_tier === "string") {
    parts.push(`tier:${usage.service_tier.slice(0, 32)}`);
  }

  // CUMULATIVE-USAGE GUARD (docs/handoff/cumulative-cost-bug.md): a Task
  // tool_response carries the sub-agent's usage SUMMED across its entire run —
  // every internal turn re-reads the cache, so cache_read reaches the billions.
  // Pricing that cumulative figure as a single turn produced four-figure
  // per-event costs ($3,532 with cache_read 4.7B) that poisoned every FinOps
  // aggregate. We therefore do NOT derive cost_usd here. The raw token counts
  // stay, tagged usage_scope="task_cumulative", so the platform buckets them as
  // lifetime spend; real per-turn cost comes only from per-turn signals
  // (extractTranscriptUsage + each adapter's own session).
  const modelId = resolveModelId(input, out);

  // Wave 2b — emit structured top-level fields alongside the colon-string so
  // the forward envelope (which spreads `...event`) hands the platform typed
  // columns. Each field is set only when its source signal is present, so the
  // forward payload stays minimal; cost_usd is omitted on a price miss or a
  // zero-token turn. The colon-string `data` stays for human/debug + back-compat.
  const event: SessionEvent = {
    type: "agent_usage",
    category: "cost",
    data: safeString(parts.join(" ")),
    priority: 2,
  };
  if (modelId.length > 0) event.model_id = modelId;
  if (typeof usage.input_tokens === "number") event.input_tokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") event.output_tokens = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") {
    event.cache_read_tokens = usage.cache_read_input_tokens;
  }
  if (typeof usage.cache_creation_input_tokens === "number") {
    event.cache_creation_tokens = usage.cache_creation_input_tokens;
  }
  event.usage_scope = "task_cumulative";

  return [event];
}

/** Input shape `buildAgentUsageEvent` consumes — re-exported for parser typing. */
export interface AgentUsageCounts {
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  native_cost_usd?: number | null;
}

/**
 * Pi (oh-my-pi) per-turn usage parser.
 *
 * Maps a Pi `turn_end` payload (`{ message: AssistantMessage }`) to the
 * `buildAgentUsageEvent` input shape, or null when there is nothing to record.
 *
 * Field provenance (adapter-matrix/pi.md @320261f + cited refs):
 *   - usage:        AssistantMessage.usage          (ai/src/types.ts:521 -> catalog/src/types.ts:100-145)
 *   - model_id:     AssistantMessage.model          (ai/src/types.ts:510; kept "provider/model" — builder normalizes)
 *   - input:        Usage.input                     -> input_tokens
 *   - output:       Usage.output                    -> output_tokens
 *   - cacheWrite:   Usage.cacheWrite                -> cache_creation_tokens
 *   - cacheRead:    Usage.cacheRead                 -> cache_read_tokens
 *   - native USD:   Usage.cost.total                -> native_cost_usd (HIGH confidence; no price-table needed)
 *
 * The event is per-turn incremental (per-response usage; anthropic.ts:1893-1901;
 * "for the turn" catalog/types.ts:103), so each turn_end maps to exactly one
 * agent_usage event with no cross-turn accumulation.
 *
 * Algorithmic + null-safe, NO regex. Accepts either the full TurnEndEvent
 * (`{ message }`) or a bare AssistantMessage (`{ usage, model }`) so callers
 * can pass `event` or `event.message` interchangeably. Returns null when the
 * payload is not an assistant message, carries no usage object, or every token
 * bucket is zero/absent (an all-zero turn emits no event — matches
 * buildAgentUsageEvent's own zero->null contract).
 */
export function parsePiUsage(payload: unknown): AgentUsageCounts | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  // Unwrap TurnEndEvent.message when present; otherwise treat the payload as
  // the AssistantMessage itself.
  const maybeMessage = root.message;
  const message: Record<string, unknown> =
    maybeMessage && typeof maybeMessage === "object"
      ? (maybeMessage as Record<string, unknown>)
      : root;

  // Only assistant turns carry LLM usage. Custom/non-LLM turns are skipped.
  // Tolerate a missing role (some payloads omit it) but reject an explicit
  // non-assistant role.
  if (typeof message.role === "string" && message.role !== "assistant") {
    return null;
  }

  const usageRaw = message.usage;
  if (!usageRaw || typeof usageRaw !== "object") return null;
  const usage = usageRaw as Record<string, unknown>;

  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

  const input_tokens = num(usage.input);
  const output_tokens = num(usage.output);
  const cache_creation_tokens = num(usage.cacheWrite);
  const cache_read_tokens = num(usage.cacheRead);

  // Zero-everything turn → null (mirrors buildAgentUsageEvent's contract; keeps
  // the DB free of no-op cost events).
  if (
    input_tokens <= 0 &&
    output_tokens <= 0 &&
    cache_creation_tokens <= 0 &&
    cache_read_tokens <= 0
  ) {
    return null;
  }

  // Pi-native USD cost lives on usage.cost.total. Preserve it only when finite;
  // omit (null) on absence so the builder falls back to the pricing catalog.
  let native_cost_usd: number | null = null;
  const costRaw = usage.cost;
  if (costRaw && typeof costRaw === "object") {
    const total = (costRaw as Record<string, unknown>).total;
    if (typeof total === "number" && Number.isFinite(total)) {
      native_cost_usd = total;
    }
  }

  const model_id = typeof message.model === "string" ? message.model : "";

  return {
    model_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    native_cost_usd,
  };
}

/**
 * openclaw `model.usage` diagnostic-event capture — parseOpenclawUsage.
 *
 * openclaw exposes a first-class `model.usage` diagnostic event
 * (`DiagnosticUsageEvent`, refs/platforms/openclaw/src/infra/diagnostic-events.ts:18-47),
 * emitted once per turn and consumed via `onDiagnosticEvent(listener)`
 * (diagnostic-events.ts:1156) — the same bus the first-party diagnostics-otel /
 * diagnostics-prometheus extensions read.
 *
 * Field mapping (openclaw → AgentUsageCounts):
 *   evt.usage.input     → input_tokens
 *   evt.usage.output    → output_tokens
 *   evt.usage.cacheWrite→ cache_creation_tokens   (cache-creation)
 *   evt.usage.cacheRead → cache_read_tokens       (cache-read)
 *   evt.costUsd         → native_cost_usd  (pre-computed via estimateUsageCost,
 *                                           agent-runner.ts:1995 — preferred over catalog)
 *   evt.model           → model_id
 *
 * CRITICAL: read `evt.usage` (the PER-TURN TOTAL — "Last Turn Total"
 * agent-runner.ts:943), NEVER `evt.lastCallUsage` (the last-model-call DELTA,
 * diagnostic-events.ts:34-40). Summing both would double-count.
 *
 * Returns AgentUsageCounts (the buildAgentUsageEvent input shape) or null when
 * the event is not a usage event / carries no usage / sums to zero. Pure,
 * null-safe, algorithmic — NO regex.
 */
export function parseOpenclawUsage(payload: unknown): AgentUsageCounts | null {
  if (!payload || typeof payload !== "object") return null;
  const evt = payload as Record<string, unknown>;

  // Only the `model.usage` diagnostic carries token usage. Tolerate an absent
  // type (defensive against a thinner payload variant) but reject any explicit
  // non-usage diagnostic (model.failover, log.record, …).
  if (typeof evt.type === "string" && evt.type !== "model.usage") {
    return null;
  }

  // PER-TURN TOTAL lives on `usage`. `lastCallUsage` is the last-call delta and
  // must NOT be consumed — reading it instead would understate (or, when summed
  // with usage, double-count) the turn.
  const usageRaw = evt.usage;
  if (!usageRaw || typeof usageRaw !== "object") return null;
  const usage = usageRaw as Record<string, unknown>;

  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

  const input_tokens = num(usage.input);
  const output_tokens = num(usage.output);
  const cache_creation_tokens = num(usage.cacheWrite);
  const cache_read_tokens = num(usage.cacheRead);

  // Zero-everything turn → null (mirrors buildAgentUsageEvent's contract; keeps
  // the DB free of no-op cost events).
  if (
    input_tokens <= 0 &&
    output_tokens <= 0 &&
    cache_creation_tokens <= 0 &&
    cache_read_tokens <= 0
  ) {
    return null;
  }

  // openclaw ships a pre-computed USD cost at the TOP LEVEL (`evt.costUsd`, not
  // nested under usage). Preserve it only when finite; omit (null) on absence so
  // the builder falls back to the pricing catalog.
  const costRaw = evt.costUsd;
  const native_cost_usd: number | null =
    typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;

  const model_id = typeof evt.model === "string" ? evt.model : "";

  return {
    model_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    native_cost_usd,
  };
}

/**
 * opencode per-turn usage parser.
 *
 * Ground truth: context-mode-platform/docs/prds/2026-06-paid-observability/
 * adapter-matrix/opencode.md. opencode tracks usage per *assistant message*; the
 * usage-bearing payload reaches a plugin via the `message.updated` bus event,
 * whose `event.properties.info` is the full Message. The assistant token shape
 * (refs platforms/opencode .../session/message.ts) is:
 *   info.tokens = { input, output, reasoning, cache: { read, write } }
 *   info.cost   = USD cost for this message
 *   info.modelID / info.providerID  (older refs may expose a single info.model)
 *
 * Field mapping (refs message.ts):
 *   tokens.input        -> input_tokens
 *   tokens.output       -> output_tokens
 *   tokens.cache.read   -> cache_read_tokens
 *   tokens.cache.write  -> cache_creation_tokens
 *   modelID/providerID  -> model_id (`${providerID}/${modelID}` when both present)
 *   cost                -> native_cost_usd
 *
 * LAST-STEP-SNAPSHOT CAVEAT (refs processor.ts:717-718): message-level
 * `.tokens` is OVERWRITTEN every step-finish, so it holds the LAST step's usage
 * — not the turn total. `.cost`, however, ACCUMULATES (`cost += usage.cost`) and
 * is the correct cumulative turn cost. We therefore pass `info.cost` through as
 * native_cost_usd so the billed $ is exact even though the token snapshot is
 * imprecise; the token columns remain best-effort (last-step) telemetry. A true
 * turn-total token sum would require summing per-step Step.Ended parts, which the
 * `message.updated` payload does not carry — out of scope for this snapshot-based
 * capture.
 *
 * Accepts either the bus event (`{ properties: { info } }`), the wrapped
 * `{ event: { properties: { info } } }`, or the bare Message (`info`) so the
 * caller can hand us whatever the SDK surfaces. NO regex — pure algorithmic,
 * null-safe traversal. Returns null when the payload is not an assistant
 * message, carries no tokens object, or every token bucket is zero/absent
 * (mirrors buildAgentUsageEvent's zero->null contract).
 */
export function parseOpencodeUsage(payload: unknown): AgentUsageCounts | null {
  if (!payload || typeof payload !== "object") return null;
  const root = payload as Record<string, unknown>;

  // Unwrap, most-specific first: { event: { properties: { info } } } →
  // { properties: { info } } → bare message. Each hop is guarded so a missing
  // layer simply falls through to treating the current object as the message.
  const eventLayer =
    root.event && typeof root.event === "object"
      ? (root.event as Record<string, unknown>)
      : root;
  const propsLayer =
    eventLayer.properties && typeof eventLayer.properties === "object"
      ? (eventLayer.properties as Record<string, unknown>)
      : eventLayer;
  const message: Record<string, unknown> =
    propsLayer.info && typeof propsLayer.info === "object"
      ? (propsLayer.info as Record<string, unknown>)
      : root;

  // Only assistant messages carry token usage. Tolerate a missing role but
  // reject an explicit non-assistant one.
  if (typeof message.role === "string" && message.role !== "assistant") {
    return null;
  }

  const tokensRaw = message.tokens;
  if (!tokensRaw || typeof tokensRaw !== "object") return null;
  const tokens = tokensRaw as Record<string, unknown>;

  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;

  const cacheRaw = tokens.cache;
  const cache =
    cacheRaw && typeof cacheRaw === "object"
      ? (cacheRaw as Record<string, unknown>)
      : {};

  const input_tokens = num(tokens.input);
  const output_tokens = num(tokens.output);
  const cache_read_tokens = num(cache.read);
  const cache_creation_tokens = num(cache.write);

  // Zero-everything turn → null (keeps the DB free of no-op cost events).
  if (
    input_tokens <= 0 &&
    output_tokens <= 0 &&
    cache_creation_tokens <= 0 &&
    cache_read_tokens <= 0
  ) {
    return null;
  }

  // Native cumulative USD cost (preferred — exact, immune to the last-step
  // token-snapshot imprecision). Omit (null) on absence so the builder falls
  // back to the pricing catalog over the last-step token columns.
  const costRaw = message.cost;
  const native_cost_usd =
    typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;

  // Billed model id. Prefer the `${providerID}/${modelID}` pair (how opencode
  // itself addresses the model); fall back to a bare modelID, then a single
  // `model` string (older refs shape). Empty when none present.
  const modelID = typeof message.modelID === "string" ? message.modelID : "";
  const providerID =
    typeof message.providerID === "string" ? message.providerID : "";
  let model_id = "";
  if (modelID.length > 0) {
    model_id = providerID.length > 0 ? `${providerID}/${modelID}` : modelID;
  } else if (typeof message.model === "string") {
    model_id = message.model;
  }

  return {
    model_id,
    input_tokens,
    output_tokens,
    cache_creation_tokens,
    cache_read_tokens,
    native_cost_usd,
  };
}

/**
 * Build a structured `agent_usage` event from summed per-model token counts.
 * Emits the colon-string `data` (human/debug + back-compat) AND the structured
 * top-level fields the forward envelope spreads to the platform. cost_usd via
 * the pricing catalog — omitted on a price miss. Returns null when every token
 * bucket is zero/absent (so an all-zero model emits no event).
 */
export function buildAgentUsageEvent(counts: {
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /**
   * Provider-supplied USD cost for this turn. When a finite number, it is
   * preferred over the catalog computation (openclaw / pi / omp / opencode
   * ship a native cost — trust the source over our price table). Omit/null to
   * derive cost_usd from the pricing catalog.
   */
  native_cost_usd?: number | null;
}): SessionEvent | null {
  const { model_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, native_cost_usd } = counts;
  if (input_tokens <= 0 && output_tokens <= 0 && cache_creation_tokens <= 0 && cache_read_tokens <= 0) {
    return null;
  }

  const parts: string[] = [`tokens_in:${input_tokens}`, `tokens_out:${output_tokens}`];
  if (cache_creation_tokens > 0) parts.push(`cache_create:${cache_creation_tokens}`);
  if (cache_read_tokens > 0) parts.push(`cache_read:${cache_read_tokens}`);

  const cost = (typeof native_cost_usd === "number" && Number.isFinite(native_cost_usd))
    ? native_cost_usd
    : computeTurnCostUsd(model_id, input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens);
  if (cost !== null) parts.push(`cost_usd:${formatCostUsd(cost)}`);

  const event: SessionEvent = {
    type: "agent_usage",
    category: "cost",
    data: safeString(parts.join(" ")),
    priority: 2,
  };
  if (model_id.length > 0) event.model_id = model_id;
  event.input_tokens = input_tokens;
  event.output_tokens = output_tokens;
  if (cache_read_tokens > 0) event.cache_read_tokens = cache_read_tokens;
  if (cache_creation_tokens > 0) event.cache_creation_tokens = cache_creation_tokens;
  if (cost !== null) event.cost_usd = cost;
  return event;
}

/**
 * gemini-cli AfterModel usage capture — parse ONE AfterModel hook payload into
 * a builder `agent_usage` event (or null). Pure, null-safe, struct-only — NO regex.
 *
 * Refs (docs/prds/2026-06-paid-observability/adapter-matrix/gemini-cli.md):
 *   - AfterModel fires per model call inside the gemini-cli stream loop
 *     (geminiChat.ts:1213); the hook input carries `llm_request` + `llm_response`
 *     (hooks/types.ts:692-695).
 *   - `llm_response.usageMetadata` exposes promptTokenCount / candidatesTokenCount
 *     / totalTokenCount (hookTranslator.ts:60-64).
 *   - model_id = `response.modelVersion || req.model` (loggingContentGenerator.ts:405,553).
 *
 * Mapping → builder shape:
 *   promptTokenCount        → input_tokens
 *   candidatesTokenCount    → output_tokens
 *   thoughtsTokenCount      → ADDED into output_tokens (Gemini bills reasoning as output)
 *   cachedContentTokenCount → cache_read_tokens (when present)
 *   model_id                → response.modelVersion || llm_request.model
 *
 * CAVEAT — the DECOUPLED AfterModel payload (hookTranslator.ts:60-64) forwards
 * only prompt/candidates/total and DROPS cachedContentTokenCount +
 * thoughtsTokenCount. We map those two defensively WHEN PRESENT (richer payload
 * variant / future fix / OTel-fed input) but never depend on them — the common
 * case is input+output only. For full cached/thoughts fidelity the OTel
 * `api_response` exporter or the chat-recording JSON is the source of record.
 *
 * MULTI-CALL TURNS — one user turn that triggers tool calls spans MULTIPLE
 * model calls, each AfterModel cumulative within itself. This fn emits ONE
 * priced event PER AfterModel call (each call is one billed round-trip).
 * Per-userPromptId summation into a single per-turn total is DEFERRED — emitting
 * per-call never double-counts, since each call's usageMetadata is the
 * authoritative total for that call.
 */
export function parseGeminiUsage(afterModelPayload: unknown): SessionEvent | null {
  if (!afterModelPayload || typeof afterModelPayload !== "object") return null;
  const payload = afterModelPayload as Record<string, unknown>;

  const resp = payload.llm_response;
  if (!resp || typeof resp !== "object") return null;
  const response = resp as Record<string, unknown>;

  const um = response.usageMetadata;
  if (!um || typeof um !== "object") return null;
  const usage = um as Record<string, unknown>;

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  const input = num(usage.promptTokenCount);
  const candidates = num(usage.candidatesTokenCount);
  const thoughts = num(usage.thoughtsTokenCount);
  const cached = num(usage.cachedContentTokenCount);
  // Gemini bills reasoning (thoughts) as output tokens — fold into output.
  const output = candidates + thoughts;

  // model_id = response.modelVersion (server-confirmed) || llm_request.model.
  const req = payload.llm_request;
  const reqModel =
    req && typeof req === "object" && typeof (req as Record<string, unknown>).model === "string"
      ? ((req as Record<string, unknown>).model as string)
      : "";
  const modelVersion = typeof response.modelVersion === "string" ? response.modelVersion : "";
  const modelId = modelVersion.length > 0 ? modelVersion : reqModel;

  // gemini exposes no native cost — cost_usd is derived from the pricing catalog
  // inside buildAgentUsageEvent (native_cost_usd omitted). All-zero ⇒ null.
  return buildAgentUsageEvent({
    model_id: modelId,
    input_tokens: input,
    output_tokens: output,
    cache_creation_tokens: 0,
    cache_read_tokens: cached,
  });
}

/**
 * claude-code MAIN-turn usage capture — the dominant-spend path the Task
 * subagent capture (extractAgentUsage) misses. Parses the session transcript
 * JSONL char-algorithmically (NO regex): each `type:"assistant"` line carries
 * `message.usage` + `message.model`, and usage is a per-turn DELTA, so summing
 * the assistant turns per model = the exact billed total. `isSidechain:true`
 * lines are Task-subagent sidechains written to a SEPARATE transcript (refs:
 * sessionStorage.ts:1042) — excluding them keeps the main-turn sum from
 * double-counting the separate Task-subagent capture. Emits one structured
 * `agent_usage` event per distinct model.
 */
export function extractTranscriptUsage(transcript: string): SessionEvent[] {
  if (typeof transcript !== "string" || transcript.length === 0) return [];
  const sums = new Map<string, { input: number; output: number; cacheCreate: number; cacheRead: number }>();
  let start = 0;
  for (let i = 0; i <= transcript.length; i++) {
    if (i !== transcript.length && transcript.charCodeAt(i) !== 10 /* \n */) continue;
    const line = transcript.slice(start, i).trim();
    start = i + 1;
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const p = JSON.parse(line);
      if (!p || typeof p !== "object") continue;
      obj = p as Record<string, unknown>;
    } catch { continue; }
    if (obj.type !== "assistant" || obj.isSidechain === true) continue;
    const msg = obj.message;
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const model = typeof m.model === "string" ? m.model : "";
    if (model.length === 0) continue;
    const u = m.usage;
    if (!u || typeof u !== "object") continue;
    const usage = u as Record<string, unknown>;
    const cur = sums.get(model) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    if (typeof usage.input_tokens === "number") cur.input += usage.input_tokens;
    if (typeof usage.output_tokens === "number") cur.output += usage.output_tokens;
    if (typeof usage.cache_creation_input_tokens === "number") cur.cacheCreate += usage.cache_creation_input_tokens;
    if (typeof usage.cache_read_input_tokens === "number") cur.cacheRead += usage.cache_read_input_tokens;
    sums.set(model, cur);
  }
  const events: SessionEvent[] = [];
  for (const [model, s] of sums) {
    const ev = buildAgentUsageEvent({
      model_id: model,
      input_tokens: s.input,
      output_tokens: s.output,
      cache_creation_tokens: s.cacheCreate,
      cache_read_tokens: s.cacheRead,
    });
    if (ev) events.push(ev);
  }
  return events;
}

/**
 * Cursor-aware variant of extractTranscriptUsage for the Stop hook.
 *
 * The transcript grows every turn and the forward loop forwards ALL passed
 * events unconditionally, so re-running extractTranscriptUsage on the whole
 * transcript each Stop would double-count every prior turn. This walks only
 * the turns NEW since the last Stop, keyed by a per-session high-water cursor
 * (the `uuid` of the last assistant turn seen).
 *
 *   - sinceUuid null/empty  → process ALL non-sidechain assistant turns.
 *   - sinceUuid found       → process only turns AFTER it (exclusive).
 *   - sinceUuid set but NOT found (transcript compaction dropped it) → process
 *     ONLY THE LAST non-sidechain assistant turn. Bounded by design: we never
 *     re-emit the whole history when the cursor falls off the front.
 *
 * `cursor` returns the uuid of the LAST non-sidechain assistant turn in the
 * transcript (whether or not it carried usage), so the next Stop resumes
 * exactly past it. When the transcript has no such turn, the input cursor is
 * returned unchanged. Same char-algorithmic JSONL parse (NO regex), same
 * sidechain exclusion, same buildAgentUsageEvent emission path.
 */
export function extractTranscriptUsageSince(
  transcript: string,
  sinceUuid: string | null,
): { events: SessionEvent[]; cursor: string | null } {
  const inputCursor = typeof sinceUuid === "string" && sinceUuid.length > 0 ? sinceUuid : null;
  if (typeof transcript !== "string" || transcript.length === 0) {
    return { events: [], cursor: inputCursor };
  }

  // Pass 1: materialize the ordered non-sidechain assistant turns (uuid + the
  // usage signal we need). One linear walk, JSON.parse per line, no regex.
  type Turn = {
    uuid: string | null;
    model: string;
    input: number;
    output: number;
    cacheCreate: number;
    cacheRead: number;
  };
  const turns: Turn[] = [];
  let start = 0;
  for (let i = 0; i <= transcript.length; i++) {
    if (i !== transcript.length && transcript.charCodeAt(i) !== 10 /* \n */) continue;
    const line = transcript.slice(start, i).trim();
    start = i + 1;
    if (line.length === 0) continue;
    let obj: Record<string, unknown>;
    try {
      const p = JSON.parse(line);
      if (!p || typeof p !== "object") continue;
      obj = p as Record<string, unknown>;
    } catch { continue; }
    if (obj.type !== "assistant" || obj.isSidechain === true) continue;
    const msg = obj.message;
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const model = typeof m.model === "string" ? m.model : "";
    if (model.length === 0) continue;
    const uuid = typeof obj.uuid === "string" && obj.uuid.length > 0 ? obj.uuid : null;
    const u = m.usage;
    const usage = u && typeof u === "object" ? (u as Record<string, unknown>) : {};
    turns.push({
      uuid,
      model,
      input: typeof usage.input_tokens === "number" ? usage.input_tokens : 0,
      output: typeof usage.output_tokens === "number" ? usage.output_tokens : 0,
      cacheCreate: typeof usage.cache_creation_input_tokens === "number" ? usage.cache_creation_input_tokens : 0,
      cacheRead: typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : 0,
    });
  }

  // No assistant turns at all → nothing to emit, cursor unchanged.
  if (turns.length === 0) return { events: [], cursor: inputCursor };

  // Cursor always advances to the last assistant turn's uuid (or stays as the
  // input cursor if that last turn has no uuid).
  const lastUuid = turns[turns.length - 1].uuid;
  const cursor = lastUuid !== null ? lastUuid : inputCursor;

  // Select the slice to process.
  let slice: Turn[];
  if (inputCursor === null) {
    slice = turns; // all turns
  } else {
    let foundAt = -1;
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].uuid === inputCursor) { foundAt = i; break; }
    }
    if (foundAt >= 0) {
      slice = turns.slice(foundAt + 1); // strictly after the cursor
    } else {
      // Compaction: cursor fell off the front. Bounded fallback — last turn only.
      slice = turns.slice(turns.length - 1);
    }
  }

  // Sum the selected turns per model and emit via the shared event builder.
  const sums = new Map<string, { input: number; output: number; cacheCreate: number; cacheRead: number }>();
  for (const t of slice) {
    const cur = sums.get(t.model) ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };
    cur.input += t.input;
    cur.output += t.output;
    cur.cacheCreate += t.cacheCreate;
    cur.cacheRead += t.cacheRead;
    sums.set(t.model, cur);
  }
  const events: SessionEvent[] = [];
  for (const [model, s] of sums) {
    const ev = buildAgentUsageEvent({
      model_id: model,
      input_tokens: s.input,
      output_tokens: s.output,
      cache_creation_tokens: s.cacheCreate,
      cache_read_tokens: s.cacheRead,
    });
    if (ev) events.push(ev);
  }
  return { events, cursor };
}
