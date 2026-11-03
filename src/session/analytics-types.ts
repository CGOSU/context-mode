/** Explicit statistics shared by collection and report rendering. */

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

/** Database adapter — anything with a prepare() method (better-sqlite3, bun:sqlite, etc.) */
export interface DatabaseAdapter {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Context savings result (#1) */
export interface ContextSavings {
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
  savedPercent: number;
}

/** Think in code comparison result (#2) */
export interface ThinkInCodeComparison {
  fileBytes: number;
  outputBytes: number;
  ratio: number;
}

/** Tool-level savings result (#3) */
export interface ToolSavingsRow {
  tool: string;
  rawBytes: number;
  contextBytes: number;
  savedBytes: number;
}

/** Sandbox I/O result (#19) */
export interface SandboxIO {
  inputBytes: number;
  outputBytes: number;
}

/** MCP tool usage row — concurrency stats for batch-style tools. */
export interface McpToolUsageRow {
  tool_name: string;
  calls: number;
  median_concurrency: number | null;
  max_concurrency: number | null;
}

/**
 * Conversation-scoped stats — aggregated from `session_events` for a single
 * `session_id` across every worktree DB plus the compact-rescue snapshot from
 * `session_resume`. Replaces the broken in-memory `tool_call_counter` that
 * only saw `ctx_*` MCP calls and reset to 0 every time the MCP server PID
 * changed (which is what made hours-of-work conversations show "1 call · 5 KB").
 */
export interface ConversationStats {
  /** session_id this aggregate covers (the current Claude Code conversation). */
  sessionId: string;
  /** Total event count for this session_id, summed across all DBs. */
  events: number;
  /** Distinct DB files this session_id appeared in (a rotation indicator). */
  dbCount: number;
  /** Wall-clock days from first to last event. Captures real activity length. */
  daysAlive: number;
  /** Bytes restored from the compact snapshot for this session_id. 0 if no compact. */
  snapshotBytes: number;
  /** Number of compact snapshots consumed for this session_id. */
  snapshotsConsumed: number;
  /** Category breakdown for this session_id. */
  byCategory: Array<{ category: string; count: number; label: string }>;
  /**
   * Earliest event timestamp (ms epoch) for this session_id across every DB.
   * Used by the section-1 "started X" line in the narrative renderer. 0 when
   * the session has no events yet. Optional for back-compat with older
   * callers / fixtures that pre-date the narrative layout.
   */
  firstEventMs?: number;
  /** Latest event timestamp (ms epoch) — pairs with firstEventMs. */
  lastEventMs?: number;
  /**
   * Wall-clock timestamp of the most recent /compact rescue for this session.
   * Drives the "On <datetime>, /compact fired" line in section 1. Undefined
   * when the conversation has never been compacted.
   */
  lastRescueMs?: number;
  /**
   * Per-day capture breakdown for the section-1 horizontal timeline. Each
   * entry is one calendar day (UTC midnight ms) with that day's event count
   * + optional rescueBytes when /compact fired on that day. Empty array
   * when no events recorded yet.
   */
  byDay?: Array<{ ms: number; count: number; rescueBytes?: number }>;
}

// ─────────────────────────────────────────────────────────
// Runtime stats — passed in from server.ts (can't come from DB)
// ─────────────────────────────────────────────────────────

/** Runtime stats tracked by server.ts during a live session. */
export interface RuntimeStats {
  bytesReturned: Record<string, number>;
  bytesIndexed: number;
  bytesSandboxed: number;
  calls: Record<string, number>;
  sessionStart: number;
  cacheHits: number;
  cacheMisses?: number;
  cacheBytesSaved: number;
}

/**
 * Index observability snapshot — point-in-time view of the persistent
 * content store. Optional input to `formatReport` so callers that don't
 * have store access (or don't want the extra DB hit) can omit it.
 */
export interface IndexState {
  totalChunks: number;
  totalSources: number;
  lastIndexedAt?: string; // ISO-8601 when available
}

// ─────────────────────────────────────────────────────────
// FullReport — single unified object returned by queryAll()
// ─────────────────────────────────────────────────────────

/** Unified report combining runtime stats, DB analytics, and continuity data. */
export interface FullReport {
  /** Runtime context savings (passed in, not from DB) */
  savings: {
    processed_kb: number;
    entered_kb: number;
    saved_kb: number;
    pct: number;
    savings_ratio: number;
    by_tool: Array<{ tool: string; calls: number; context_kb: number; tokens: number }>;
    total_calls: number;
    total_bytes_returned: number;
    kept_out: number;
    total_processed: number;
  };
  cache?: {
    hits: number;
    misses: number;
    hit_rate: number; // hits / (hits + misses); 0 when both are zero
    bytes_saved: number;
    ttl_hours_left: number;
    total_with_cache: number;
    total_savings_ratio: number;
  };
  /** Session metadata from SessionDB */
  session: {
    id: string;
    uptime_min: string;
  };
  /** Session continuity data */
  continuity: {
    total_events: number;
    by_category: Array<{
      category: string;
      count: number;
      label: string;
      preview: string;
      why: string;
    }>;
    compact_count: number;
    resume_ready: boolean;
  };
  /** Persistent project memory — all events across all sessions */
  projectMemory: {
    total_events: number;
    session_count: number;
    by_category: Array<{ category: string; count: number; label: string }>;
  };
}

// ─────────────────────────────────────────────────────────
// Adapter dir enumeration (B3a multi-adapter aggregation)
// ─────────────────────────────────────────────────────────

/**
 * Where one adapter stores its context-mode sidecars on disk. Mirrors the
 * map in `src/adapters/detect.ts:92-111` (`getSessionDirSegments`) so we
 * never go out of sync as a single source of truth.
 *
 * `sessionsDir` = `<home>/<segments>/context-mode/sessions`
 * `contentDir`  = `<home>/<segments>/context-mode/content`
 *
 * Why duplicated here: `getSessionDirSegments` returns segments relative to
 * `homedir()`; analytics needs the absolute joined paths for both `sessions`
 * and `content` siblings. Keeping a parallel hard-coded list avoids importing
 * detect.ts (which pulls in adapter loaders) into the stats path.
 */
export interface AdapterDirEntry {
  /** Adapter id matching `src/adapters/detect.ts` PlatformId. */
  name: string;
  /** Absolute path to `<home>/<segments>/context-mode/sessions`. */
  sessionsDir: string;
  /** Absolute path to `<home>/<segments>/context-mode/content`. */
  contentDir: string;
}

// ─────────────────────────────────────────────────────────
// Lifetime stats (Bug #3 + #4)
// ─────────────────────────────────────────────────────────

/** Aggregated stats spanning every SessionDB + auto-memory under the user's profile. */
export interface LifetimeStats {
  totalEvents: number;
  totalSessions: number;
  autoMemoryCount: number;
  autoMemoryProjects: number;
  /** Per-prefix breakdown of auto-memory files (user/feedback/project/...). */
  autoMemoryByPrefix: Record<string, number>;
  /**
   * Per-category event counts aggregated across every SessionDB on disk.
   * Keys are the raw category strings (file/cwd/rule/...) — the renderer
   * looks them up against `categoryLabels` for display. Empty `{}` when no
   * sidecar has any events. Optional for back-compat with older fixtures.
   */
  categoryCounts: Record<string, number>;
  /**
   * Total bytes restored from compact-rescue snapshots across every DB on
   * disk. Adds the rescue benefit to lifetime $ so the headline isn't
   * silently undercounting the killer feature. 0 when no compact has fired
   * or older fixtures don't pass this. Optional for back-compat with tests.
   */
  rescueBytes?: number;
  /**
   * Earliest event timestamp (ms epoch) across every DB. Used for the
   * "since 2026-04-14" lifetime narrative. 0 when unknown. Optional.
   */
  firstEventMs?: number;
  /**
   * Distinct project_dir count across every DB. Different from
   * `autoMemoryProjects` (which only counts dirs with auto-memory files).
   * Captures every cwd context-mode has ever seen events for. Optional.
   */
  distinctProjects?: number;
}

// ─────────────────────────────────────────────────────────
// getRealBytesStats — Phase 8 of D2 PRD (stats-event-driven-architecture)
// ─────────────────────────────────────────────────────────

/**
 * Real-bytes counter the renderer uses to replace the conservative
 * `events × 256` token estimate. Reads four sources from disk and
 * returns the sum the renderer divides by 4 to get tokens.
 *
 * - `eventDataBytes`  = SUM(LENGTH(data))      FROM session_events
 * - `bytesAvoided`    = SUM(bytes_avoided)     FROM session_events
 * - `bytesReturned`   = SUM(bytes_returned)    FROM session_events
 * - `snapshotBytes`   = SUM(LENGTH(snapshot))  FROM session_resume
 * - `totalSavedTokens` = (eventDataBytes + bytesAvoided + snapshotBytes) / 4
 *
 * `bytesReturned` is reported but NOT folded into `totalSavedTokens`
 * because it represents bytes the model already paid for — adding it
 * would double-count what's already on the user's invoice.
 */
export interface RealBytesStats {
  eventDataBytes: number;
  bytesAvoided: number;
  bytesReturned: number;
  snapshotBytes: number;
  /**
   * v1.0.133 Slice 3: bytes attributed to this session in the FTS5 content
   * DB — `SUM(LENGTH(title) + LENGTH(content)) FROM chunks WHERE session_id = ?`.
   *
   * Read-only, render-time computation. Populated only when
   * `getRealBytesStats` is called with both `sessionId` AND `contentDbPath`
   * (i.e. the conversation tier from ctx_stats). Lifetime / project tiers
   * leave this at 0 — aggregating across every adapter's content DB is a
   * separate concern.
   *
   * Legacy chunks with empty `session_id` (pre-Slice-1) are NOT backfilled:
   * the architect rejected the time-window join as unsafe. Old conversations
   * stay low; new conversations populate honestly.
   */
  contentBytes: number;
  totalSavedTokens: number;
}

// ─────────────────────────────────────────────────────────
// Multi-adapter aggregation (B3a — "your work everywhere")
// ─────────────────────────────────────────────────────────

/**
 * Real-usage filter thresholds. Decided in the B3a /diagnose conversation
 * to suppress fixture-noise dirs (test runs that touched ~/.X but never
 * carried real user work).
 *
 * An adapter is `isReal=true` iff ALL four hold:
 *   eventCount     >= 100
 *   distinctProjects >= 5
 *   lastActivity within 30 days
 *   avgEventBytes  >= 50
 *
 * Tuneable via `getMultiAdapterLifetimeStats({ filter })` for testing.
 */
export interface RealUsageFilter {
  minEvents?: number;
  minProjects?: number;
  recencyMs?: number;
  minAvgBytes?: number;
  /** Fixed "now" timestamp for deterministic testing. Defaults to Date.now(). */
  nowMs?: number;
}

/** Per-adapter scan result returned by {@link scanOneAdapter}. */
export interface AdapterScanResult {
  /** Adapter id (matches `enumerateAdapterDirs().name`). */
  name: string;
  /** Total event rows across every `*.db` in this adapter's sessions dir. */
  eventCount: number;
  /** Total distinct session_meta rows across every db. */
  sessionCount: number;
  /** Sum of LENGTH(data) across every session_event row. */
  dataBytes: number;
  /** Sum of LENGTH(snapshot) across consumed compact-rescue snapshots. */
  rescueBytes: number;
  /** Reserved for future content/ scan (B3b). 0 today. */
  contentBytes: number;
  /** Distinct session_id count across all dbs (alias of sessionCount). */
  uuidConvs: number;
  /** Distinct project_dir values across all session_events. */
  projectDirs: string[];
  /** Earliest event ms epoch (Number.POSITIVE_INFINITY when no events). */
  firstMs: number;
  /** Latest event ms epoch (0 when no events). */
  lastMs: number;
  /** Real-usage flag — see {@link RealUsageFilter}. */
  isReal: boolean;
}

/** Aggregated multi-adapter lifetime stats. */
export interface MultiAdapterLifetimeStats {
  /** Sum of eventCount across every adapter that exists on disk. */
  totalEvents: number;
  /** Sum of sessionCount across every adapter. */
  totalSessions: number;
  /** Sum of dataBytes + rescueBytes across every adapter. */
  totalBytes: number;
  /** Per-adapter rows for adapters that have >= one .db file. */
  perAdapter: AdapterScanResult[];
}

/** Aggregated multi-adapter real-bytes stats. */
export interface MultiAdapterRealBytesStats extends RealBytesStats {
  /** Per-adapter row in the same shape as {@link RealBytesStats}, keyed by name. */
  perAdapter: Array<RealBytesStats & { name: string }>;
}

/**
 * One day on the horizontal narrative timeline. `ms` is midnight-UTC of
 * the day (caller is responsible for normalising); `count` is captures
 * for that day; `rescueBytes` (when >0) overlays the ◆ /compact glyph.
 */
export interface TimelineDay {
  ms: number;
  count: number;
  rescueBytes?: number;
}
