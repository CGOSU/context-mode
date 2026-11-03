/** SQLite and filesystem collection, runtime metrics, and adapter aggregation. */

import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadDatabase as loadDatabaseImpl } from "../db-base.js";
import { ensureSessionEventsSchema } from "./db.js";
import { resolveClaudeConfigDir } from "../util/claude-config.js";
import { categoryLabels, categoryHints } from "./analytics-labels.js";
import type {
  DatabaseAdapter,
  ContextSavings,
  ThinkInCodeComparison,
  ToolSavingsRow,
  SandboxIO,
  McpToolUsageRow,
  ConversationStats,
  RuntimeStats,
  FullReport,
  AdapterDirEntry,
  LifetimeStats,
  RealBytesStats,
  RealUsageFilter,
  AdapterScanResult,
  MultiAdapterLifetimeStats,
  MultiAdapterRealBytesStats,
} from "./analytics-types.js";

// ─────────────────────────────────────────────────────────
// AnalyticsEngine
// ─────────────────────────────────────────────────────────

export class AnalyticsEngine {
  private readonly db: DatabaseAdapter;

  /**
   * Create an AnalyticsEngine.
   *
   * Accepts either a SessionDB instance (extracts internal db via
   * the protected getter — use the static fromDB helper for raw adapters)
   * or any object with a prepare() method for direct usage.
   */
  constructor(db: DatabaseAdapter) {
    this.db = db;
  }

  // ═══════════════════════════════════════════════════════
  // GROUP 3 — Runtime (4 metrics, stubs)
  // ═══════════════════════════════════════════════════════

  /**
   * #1 Context Savings Total — bytes kept out of context window.
   *
   * Stub: requires server.ts to accumulate rawBytes and contextBytes
   * during a live session. Call with tracked values.
   */
  static contextSavingsTotal(rawBytes: number, contextBytes: number): ContextSavings {
    const savedBytes = rawBytes - contextBytes;
    const savedPercent = rawBytes > 0
      ? Math.round((savedBytes / rawBytes) * 1000) / 10
      : 0;
    return { rawBytes, contextBytes, savedBytes, savedPercent };
  }

  /**
   * #2 Think in Code Comparison — ratio of file size to sandbox output size.
   *
   * Stub: requires server.ts tracking of execute/execute_file calls.
   */
  static thinkInCodeComparison(fileBytes: number, outputBytes: number): ThinkInCodeComparison {
    const ratio = outputBytes > 0
      ? Math.round((fileBytes / outputBytes) * 10) / 10
      : 0;
    return { fileBytes, outputBytes, ratio };
  }

  /**
   * #3 Tool Savings — per-tool breakdown of context savings.
   *
   * Stub: requires per-tool accumulators in server.ts.
   */
  static toolSavings(
    tools: Array<{ tool: string; rawBytes: number; contextBytes: number }>,
  ): ToolSavingsRow[] {
    return tools.map((t) => ({
      ...t,
      savedBytes: t.rawBytes - t.contextBytes,
    }));
  }

  /**
   * #19 Sandbox I/O — total input/output bytes processed by the sandbox.
   *
   * Stub: requires PolyglotExecutor byte counters.
   */
  static sandboxIO(inputBytes: number, outputBytes: number): SandboxIO {
    return { inputBytes, outputBytes };
  }

  /**
   * MCP tool usage — call counts and concurrency stats per MCP tool.
   *
   * Reads `mcp_tool_call` events, parses the JSON payload, and aggregates:
   *  - call count per tool_name
   *  - median + max of `params.concurrency` (only for tools that take it,
   *    e.g. ctx_batch_execute, ctx_fetch_and_index). Returns null when the
   *    tool doesn't carry a concurrency param so callers can render N/A.
   *
   * Best-effort: malformed rows or truncated payloads are skipped silently.
   */
  getMcpToolUsage(): McpToolUsageRow[] {
    let rows: Array<{ data: string }>;
    try {
      rows = this.db.prepare(
        "SELECT data FROM session_events WHERE category = 'mcp_tool_call'",
      ).all() as Array<{ data: string }>;
    } catch {
      return [];
    }

    // toolName -> { calls, concurrencies }
    const agg = new Map<string, { calls: number; concurrencies: number[] }>();

    for (const row of rows) {
      let parsed: { tool_name?: unknown; params?: unknown; truncated?: unknown };
      try {
        parsed = JSON.parse(row.data);
      } catch {
        continue;
      }
      const toolName = typeof parsed.tool_name === "string" ? parsed.tool_name : null;
      if (!toolName) continue;

      const bucket = agg.get(toolName) ?? { calls: 0, concurrencies: [] };
      bucket.calls += 1;

      // Skip concurrency extraction when the row was truncated — the params
      // blob is a substring of JSON that may not parse cleanly.
      if (parsed.truncated !== true && parsed.params && typeof parsed.params === "object") {
        const c = (parsed.params as Record<string, unknown>).concurrency;
        if (typeof c === "number" && Number.isFinite(c) && c > 0) {
          bucket.concurrencies.push(c);
        }
      }

      agg.set(toolName, bucket);
    }

    const out: McpToolUsageRow[] = [];
    for (const [tool_name, b] of agg) {
      let median: number | null = null;
      let max: number | null = null;
      if (b.concurrencies.length > 0) {
        b.concurrencies.sort((a, c) => a - c);
        const sorted = b.concurrencies;
        const mid = Math.floor(sorted.length / 2);
        median = sorted.length % 2 === 0
          ? (sorted[mid - 1] + sorted[mid]) / 2
          : sorted[mid];
        max = sorted[sorted.length - 1];
      }
      out.push({
        tool_name,
        calls: b.calls,
        median_concurrency: median,
        max_concurrency: max,
      });
    }

    // Stable sort: most-called first, then alphabetical
    out.sort((a, c) => c.calls - a.calls || a.tool_name.localeCompare(c.tool_name));
    return out;
  }

  // ═══════════════════════════════════════════════════════
  // queryAll — single unified report from ONE source
  // ═══════════════════════════════════════════════════════

  /**
   * Build a FullReport by merging runtime stats (passed in)
   * with continuity data from the DB.
   *
   * This is the ONE call that ctx_stats should use.
   */
  queryAll(runtimeStats: RuntimeStats): FullReport {
    // ── Resolve latest session ID ──
    const latestSession = this.db.prepare(
      "SELECT session_id FROM session_meta ORDER BY started_at DESC LIMIT 1",
    ).get() as { session_id: string } | undefined;
    const sid = latestSession?.session_id ?? "";

    // ── Runtime savings ──
    const totalBytesReturned = Object.values(runtimeStats.bytesReturned).reduce(
      (sum, b) => sum + b, 0,
    );
    const totalCalls = Object.values(runtimeStats.calls).reduce(
      (sum, c) => sum + c, 0,
    );
    const keptOut = runtimeStats.bytesIndexed + runtimeStats.bytesSandboxed;
    const totalProcessed = keptOut + totalBytesReturned;
    const savingsRatio = totalProcessed / Math.max(totalBytesReturned, 1);
    const reductionPct = totalProcessed > 0
      ? Math.round((1 - totalBytesReturned / totalProcessed) * 100)
      : 0;

    const toolNames = new Set([
      ...Object.keys(runtimeStats.calls),
      ...Object.keys(runtimeStats.bytesReturned),
    ]);
    const byTool = Array.from(toolNames).sort().map((tool) => ({
      tool,
      calls: runtimeStats.calls[tool] || 0,
      context_kb: Math.round((runtimeStats.bytesReturned[tool] || 0) / 1024 * 10) / 10,
      tokens: Math.round((runtimeStats.bytesReturned[tool] || 0) / 4),
    }));

    const uptimeMs = Date.now() - runtimeStats.sessionStart;
    const uptimeMin = (uptimeMs / 60_000).toFixed(1);

    // ── Cache ──
    let cache: FullReport["cache"];
    const cacheMisses = runtimeStats.cacheMisses ?? 0;
    if (runtimeStats.cacheHits > 0 || runtimeStats.cacheBytesSaved > 0 || cacheMisses > 0) {
      const totalWithCache = totalProcessed + runtimeStats.cacheBytesSaved;
      const totalSavingsRatio = totalWithCache / Math.max(totalBytesReturned, 1);
      const ttlHoursLeft = Math.max(0, 24 - Math.floor((Date.now() - runtimeStats.sessionStart) / (60 * 60 * 1000)));
      // hit_rate is the nominal cache effectiveness — the metric ctx_stats
      // historically inferred-only by diffing tokens_saved snapshots. When
      // there is no activity we report 0 instead of NaN/undefined so the
      // renderer stays JSON-safe.
      const totalLookups = runtimeStats.cacheHits + cacheMisses;
      const hitRate = totalLookups > 0 ? runtimeStats.cacheHits / totalLookups : 0;
      cache = {
        hits: runtimeStats.cacheHits,
        misses: cacheMisses,
        hit_rate: hitRate,
        bytes_saved: runtimeStats.cacheBytesSaved,
        ttl_hours_left: ttlHoursLeft,
        total_with_cache: totalWithCache,
        total_savings_ratio: totalSavingsRatio,
      };
    }

    // ── Continuity data (scoped to current session) ──
    const eventTotal = (this.db.prepare(
      "SELECT COUNT(*) as cnt FROM session_events WHERE session_id = ?",
    ).get(sid) as { cnt: number }).cnt;

    const byCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events WHERE session_id = ? GROUP BY category ORDER BY cnt DESC",
    ).all(sid) as Array<{ category: string; cnt: number }>;

    const meta = this.db.prepare(
      "SELECT compact_count FROM session_meta WHERE session_id = ?",
    ).get(sid) as { compact_count: number } | undefined;
    const compactCount = meta?.compact_count ?? 0;

    const resume = this.db.prepare(
      "SELECT event_count, consumed FROM session_resume WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(sid) as { event_count: number; consumed: number } | undefined;
    const resumeReady = resume ? !resume.consumed : false;

    // Build category previews (current session only)
    const previewRows = this.db.prepare(
      "SELECT category, type, data FROM session_events WHERE session_id = ? ORDER BY id DESC",
    ).all(sid) as Array<{ category: string; type: string; data: string }>;

    const previews = new Map<string, Set<string>>();
    for (const row of previewRows) {
      if (!previews.has(row.category)) previews.set(row.category, new Set());
      const set = previews.get(row.category)!;
      if (set.size < 5) {
        let display = row.data;
        if (row.category === "file") {
          display = row.data.split("/").pop() || row.data;
        } else if (row.category === "prompt" || row.category === "user-prompt") {
          display = display.length > 50 ? display.slice(0, 47) + "..." : display;
        }
        if (display.length > 40) display = display.slice(0, 37) + "...";
        set.add(display);
      }
    }

    const continuityByCategory = byCategory.map((row) => ({
      category: row.category,
      count: row.cnt,
      label: categoryLabels[row.category] || row.category,
      preview: previews.get(row.category)
        ? Array.from(previews.get(row.category)!).join(", ")
        : "",
      why: categoryHints[row.category] || "Survives context resets",
    }));

    // ── Project-wide persistent memory (all sessions, no session_id filter) ──
    const projectTotals = this.db.prepare(
      "SELECT COUNT(*) as cnt, COUNT(DISTINCT session_id) as sessions FROM session_events",
    ).get() as { cnt: number; sessions: number };

    const projectByCategory = this.db.prepare(
      "SELECT category, COUNT(*) as cnt FROM session_events GROUP BY category ORDER BY cnt DESC",
    ).all() as Array<{ category: string; cnt: number }>;

    const projectMemoryByCategory = projectByCategory
      .filter((row) => row.cnt > 0)
      .map((row) => ({
        category: row.category,
        count: row.cnt,
        label: categoryLabels[row.category] || row.category,
      }));

    return {
      savings: {
        processed_kb: Math.round(totalProcessed / 1024 * 10) / 10,
        entered_kb: Math.round(totalBytesReturned / 1024 * 10) / 10,
        saved_kb: Math.round(keptOut / 1024 * 10) / 10,
        pct: reductionPct,
        savings_ratio: Math.round(savingsRatio * 10) / 10,
        by_tool: byTool,
        total_calls: totalCalls,
        total_bytes_returned: totalBytesReturned,
        kept_out: keptOut,
        total_processed: totalProcessed,
      },
      cache,
      session: {
        id: sid,
        uptime_min: uptimeMin,
      },
      continuity: {
        total_events: eventTotal,
        by_category: continuityByCategory,
        compact_count: compactCount,
        resume_ready: resumeReady,
      },
      projectMemory: {
        total_events: projectTotals.cnt,
        session_count: projectTotals.sessions,
        by_category: projectMemoryByCategory,
      },
    };
  }
}

/**
 * Enumerate every known adapter's sessions + content dirs under `home`.
 * Used by `getMultiAdapterLifetimeStats` and `getMultiAdapterRealBytesStats`
 * so a single call surfaces "your work everywhere on this machine across
 * all AI tools" (the marketing line).
 *
 * Returns ALL 17 adapters even when the dir doesn't exist on disk — the
 * scanner functions filter to existing dirs. That keeps the enumeration
 * pure / testable without filesystem dependencies.
 */
export function enumerateAdapterDirs(opts?: { home?: string }): AdapterDirEntry[] {
  const home = opts?.home ?? homedir();
  // Mirrors `getSessionDirSegments` in src/adapters/detect.ts:92-111.
  const map: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["claude-code",      [".claude"]],
    ["gemini-cli",       [".gemini"]],
    ["antigravity",      [".gemini"]],
    ["antigravity-cli",  [".gemini"]],
    ["openclaw",         [".openclaw"]],
    ["codex",            [".codex"]],
    ["cursor",           [".cursor"]],
    ["vscode-copilot",   [".vscode"]],
    ["copilot-cli",      [".copilot"]],
    ["kiro",             [".kiro"]],
    ["pi",               [".pi"]],
    ["omp",              [".omp"]],
    ["qwen-code",        [".qwen"]],
    ["kilo",             [".config", "kilo"]],
    ["opencode",         [".config", "opencode"]],
    ["zed",              [".config", "zed"]],
    ["jetbrains-copilot", [".config", "JetBrains"]],
  ];
  return map.map(([name, segments]) => {
    const base = join(home, ...segments, "context-mode");
    return {
      name,
      sessionsDir: join(base, "sessions"),
      contentDir: join(base, "content"),
    };
  });
}

/** Extract leading prefix from auto-memory filename: `feedback_push.md` → `feedback`. */
function autoMemoryPrefix(filename: string): string {
  const base = filename.replace(/\.md$/i, "");
  const m = base.match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : "other";
}

/**
 * Aggregate lifetime stats from all SessionDB files in `sessionsDir` and
 * all auto-memory markdown files under `memoryRoot/<project>/memory/`.
 *
 * Best-effort: silently ignores missing/unreadable files so ctx_stats
 * can never be broken by a corrupt sidecar.
 */
export function getLifetimeStats(opts?: {
  sessionsDir?: string;
  memoryRoot?: string;
  /** Override for tests — defaults to db-base loadDatabase(). */
  loadDatabase?: () => unknown;
}): LifetimeStats {
  // Issue #460 round-3: route through resolveClaudeConfigDir so lifetime
  // stats aggregation tracks $CLAUDE_CONFIG_DIR instead of the literal
  // ~/.claude tree. Otherwise users who relocate config see "no sessions"
  // even though the SessionDB sidecars exist under the override.
  const claudeRoot = resolveClaudeConfigDir();
  const sessionsDir = opts?.sessionsDir
    ?? join(claudeRoot, "context-mode", "sessions");
  const memoryRoot = opts?.memoryRoot
    ?? join(claudeRoot, "projects");

  let totalEvents = 0;
  let totalSessions = 0;
  let rescueBytes = 0;
  let firstEventMs = Number.POSITIVE_INFINITY;
  const distinctProjectsSet = new Set<string>();
  const categoryCounts: Record<string, number> = {};

  // ── SessionDB aggregation ──
  if (existsSync(sessionsDir)) {
    let dbFiles: string[] = [];
    try {
      dbFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".db"));
    } catch { /* unreadable */ }

    if (dbFiles.length > 0) {
      // Lazy-load better-sqlite3 / bun-sqlite via the same path the runtime uses.
      let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
      try {
        DatabaseCtor = opts?.loadDatabase
          ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
          : loadDatabaseImpl();
      } catch { /* sqlite unavailable */ }

      if (DatabaseCtor) {
        for (const file of dbFiles) {
          const dbPath = join(sessionsDir, file);
          try {
            const sdb = new DatabaseCtor(dbPath, { readonly: true });
            try {
              const ev = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_events").get() as { cnt: number } | undefined;
              const ss = sdb.prepare("SELECT COUNT(*) AS cnt FROM session_meta").get() as { cnt: number } | undefined;
              totalEvents += ev?.cnt ?? 0;
              totalSessions += ss?.cnt ?? 0;
              // Per-category aggregation across every sidecar so the
              // Persistent memory bars stay populated even when the
              // current project's local DB is fresh / empty.
              try {
                const catRows = sdb.prepare(
                  "SELECT category, COUNT(*) AS cnt FROM session_events GROUP BY category",
                ).all() as Array<{ category: string; cnt: number }>;
                for (const row of catRows) {
                  if (!row.category) continue;
                  categoryCounts[row.category] = (categoryCounts[row.category] ?? 0) + (row.cnt ?? 0);
                }
              } catch {
                // older schema / no category column — ignore
              }
              // Lifetime rescue: compact-snapshot bytes restored across every DB.
              // Without this, the lifetime $ silently undercounts the killer
              // continuity-after-/compact feature.
              try {
                const snap = sdb.prepare(
                  "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1",
                ).get() as { bytes: number } | undefined;
                if (snap?.bytes) rescueBytes += snap.bytes;
              } catch { /* old schema */ }
              // Earliest event timestamp + distinct project_dirs for the
              // "since X · Y projects" lifetime narrative.
              try {
                const mn = sdb.prepare(
                  "SELECT MIN(created_at) AS t FROM session_events",
                ).get() as { t: string | null } | undefined;
                if (mn?.t) {
                  const stamp = mn.t.endsWith("Z") ? mn.t : mn.t + "Z";
                  const ms = Date.parse(stamp);
                  if (Number.isFinite(ms) && ms < firstEventMs) firstEventMs = ms;
                }
              } catch { /* old schema */ }
              try {
                const projRows = sdb.prepare(
                  "SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''",
                ).all() as Array<{ p: string }>;
                for (const row of projRows) if (row.p) distinctProjectsSet.add(row.p);
              } catch { /* old schema */ }
            } finally {
              sdb.close();
            }
          } catch {
            // missing tables / corrupt file — skip
          }
        }
      }
    }
  }

  // ── Auto-memory file scan ──
  let autoMemoryCount = 0;
  let autoMemoryProjects = 0;
  const autoMemoryByPrefix: Record<string, number> = {};

  if (existsSync(memoryRoot)) {
    let projectDirs: string[] = [];
    try {
      projectDirs = readdirSync(memoryRoot).filter((entry) => {
        try {
          return statSync(join(memoryRoot, entry)).isDirectory();
        } catch { return false; }
      });
    } catch { /* unreadable */ }

    for (const proj of projectDirs) {
      const memDir = join(memoryRoot, proj, "memory");
      if (!existsSync(memDir)) continue;
      let mdFiles: string[] = [];
      try {
        mdFiles = readdirSync(memDir).filter((f) => f.endsWith(".md"));
      } catch { continue; }
      if (mdFiles.length === 0) continue;
      autoMemoryProjects++;
      autoMemoryCount += mdFiles.length;
      for (const f of mdFiles) {
        const prefix = autoMemoryPrefix(f);
        autoMemoryByPrefix[prefix] = (autoMemoryByPrefix[prefix] ?? 0) + 1;
      }
    }
  }

  return {
    totalEvents,
    totalSessions,
    autoMemoryCount,
    autoMemoryProjects,
    autoMemoryByPrefix,
    categoryCounts,
    rescueBytes,
    firstEventMs: Number.isFinite(firstEventMs) ? firstEventMs : 0,
    distinctProjects: distinctProjectsSet.size,
  };
}

/**
 * Aggregate every event for one `session_id` across all SessionDB files in
 * `sessionsDir` plus the compact-rescue snapshot bytes from `session_resume`.
 *
 * Why this exists: the Claude Code session_id can persist across days while
 * the underlying DB file rotates (size cap), and a compact-rescue snapshot
 * carries hundreds of KB of context that would otherwise have been lost. The
 * old in-memory `tool_call_counter` saw none of this — it counted only `ctx_*`
 * MCP calls against the current MCP server PID and reset on every restart.
 * Reading from `session_events` + `session_resume` is the source-of-truth
 * version that matches what users actually experienced.
 */
export function getConversationStats(opts: {
  sessionId: string;
  sessionsDir?: string;
  /** Optional worktree filename prefix (sha256(cwd)[:16]). When omitted, scans every DB. */
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): ConversationStats {
  const sessionsDir = opts.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  const sessionId = opts.sessionId;

  const empty: ConversationStats = {
    sessionId,
    events: 0,
    dbCount: 0,
    daysAlive: 0,
    snapshotBytes: 0,
    snapshotsConsumed: 0,
    byCategory: [],
  };
  if (!sessionId || !existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch { return empty; }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return empty; }
  if (!DatabaseCtor) return empty;

  const catCounts: Record<string, number> = {};
  let events = 0;
  let dbCount = 0;
  let snapshotBytes = 0;
  let snapshotsConsumed = 0;
  let firstMs = Number.POSITIVE_INFINITY;
  let lastMs = 0;
  let lastRescueMs = 0;
  // Per-day captures aggregated across every DB. Key is the UTC midnight ms
  // of the day; value tracks both the event count and any rescueBytes (latter
  // overlays the ◆ /compact glyph in the section-1 horizontal timeline).
  const byDayMap = new Map<number, { count: number; rescueBytes: number }>();
  const dayKey = (ms: number): number => Math.floor(ms / 86_400_000) * 86_400_000;

  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    let touched = false;
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const cats = sdb.prepare(
          "SELECT category, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY category",
        ).all(sessionId) as Array<{ category: string; cnt: number }>;
        for (const row of cats) {
          if (!row.category) continue;
          catCounts[row.category] = (catCounts[row.category] ?? 0) + (row.cnt ?? 0);
          events += row.cnt ?? 0;
          touched = true;
        }
        const range = sdb.prepare(
          "SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events WHERE session_id = ?",
        ).get(sessionId) as { mn: string | null; mx: string | null } | undefined;
        if (range?.mn) {
          const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
          if (Number.isFinite(t) && t < firstMs) firstMs = t;
        }
        if (range?.mx) {
          const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
          if (Number.isFinite(t) && t > lastMs) lastMs = t;
        }
        // Per-day captures + per-day rescue overlay for the narrative timeline.
        // Best-effort: silently skip when the schema lacks created_at.
        try {
          const dayRows = sdb.prepare(
            "SELECT strftime('%s', created_at) AS sec, COUNT(*) AS cnt FROM session_events WHERE session_id = ? GROUP BY date(created_at)",
          ).all(sessionId) as Array<{ sec: string | null; cnt: number }>;
          for (const row of dayRows) {
            if (!row.sec) continue;
            const ms = parseInt(row.sec, 10) * 1000;
            if (!Number.isFinite(ms)) continue;
            const k = dayKey(ms);
            const cur = byDayMap.get(k) ?? { count: 0, rescueBytes: 0 };
            cur.count += row.cnt ?? 0;
            byDayMap.set(k, cur);
          }
        } catch { /* old schema */ }
        try {
          const snap = sdb.prepare(
            "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes, COUNT(*) AS n, MAX(strftime('%s', created_at)) AS lastSec FROM session_resume WHERE session_id = ? AND consumed = 1",
          ).get(sessionId) as { bytes: number; n: number; lastSec: string | null } | undefined;
          if (snap?.bytes) snapshotBytes += snap.bytes;
          if (snap?.n) snapshotsConsumed += snap.n;
          if (snap?.lastSec) {
            const t = parseInt(snap.lastSec, 10) * 1000;
            if (Number.isFinite(t) && t > lastRescueMs) lastRescueMs = t;
            // Overlay the rescue bytes onto the day bucket for the timeline.
            if (Number.isFinite(t) && (snap?.bytes ?? 0) > 0) {
              const k = dayKey(t);
              const cur = byDayMap.get(k) ?? { count: 0, rescueBytes: 0 };
              cur.rescueBytes = Math.max(cur.rescueBytes, snap.bytes);
              byDayMap.set(k, cur);
            }
          }
        } catch { /* old schema */ }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt */ }
    if (touched) dbCount++;
  }

  const daysAlive = firstMs < lastMs ? (lastMs - firstMs) / 86_400_000 : 0;
  const byCategory = Object.entries(catCounts)
    .filter(([, n]) => n > 0)
    .map(([category, count]) => ({
      category,
      count,
      label: categoryLabels[category] || category,
    }))
    .sort((a, b) => b.count - a.count);
  const byDay = [...byDayMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, v]) => ({
      ms,
      count: v.count,
      ...(v.rescueBytes > 0 ? { rescueBytes: v.rescueBytes } : {}),
    }));

  return {
    sessionId,
    events,
    dbCount,
    daysAlive,
    snapshotBytes,
    snapshotsConsumed,
    byCategory,
    firstEventMs: Number.isFinite(firstMs) ? firstMs : 0,
    lastEventMs:  lastMs > 0 ? lastMs : 0,
    lastRescueMs: lastRescueMs > 0 ? lastRescueMs : undefined,
    byDay,
  };
}

/**
 * v1.0.133 Slice 3: Sum the bytes attributed to one session in the FTS5
 * content DB.
 *
 * Returns `LENGTH(title) + LENGTH(content)` summed across every chunk
 * whose `session_id` column matches `sessionId`. Best-effort — returns 0
 * when the DB file is missing, the schema lacks the `session_id` column
 * (pre-Slice-1 content DBs), or the query fails. Never throws.
 *
 * Render-time only. Does NOT mutate the content DB. Architect-approved
 * because the read-only join carries no risk of cross-session attribution
 * (the FK was set at chunk insert time by Slice 1).
 */
export function getContentBytesForSession(
  sessionId: string,
  contentDbPath: string,
  opts?: { loadDatabase?: () => unknown },
): number {
  if (!sessionId || !contentDbPath) return 0;
  if (!existsSync(contentDbPath)) return 0;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts?.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return 0; }
  if (!DatabaseCtor) return 0;

  try {
    const db = new DatabaseCtor(contentDbPath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(content) + LENGTH(title)), 0) AS bytes
         FROM chunks WHERE session_id = ?`,
      ).get(sessionId) as { bytes: number } | undefined;
      return Number(row?.bytes ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * v1.0.134 SLICE C — lifetime tier all-chunks aggregate.
 *
 * Sibling of {@link getContentBytesForSession} that omits the session_id
 * filter so the lifetime tier sees every chunk in the content store —
 * including legacy unattributed rows (sessionId === '') and chunks
 * attributed to other adapters' sessions. Without this, the lifetime
 * "kept out" headline only counts session_events.bytes_avoided and
 * misses the bulk of indexed payload.
 *
 * Best-effort: returns 0 when the DB file is missing, the schema lacks
 * the `chunks` table, or the query fails. Never throws — same contract
 * as the rest of the analytics module so a corrupt content DB cannot
 * crash ctx_stats.
 */
export function getContentBytesAllSessions(
  contentDbPath: string,
  opts?: { loadDatabase?: () => unknown },
): number {
  if (!contentDbPath) return 0;
  if (!existsSync(contentDbPath)) return 0;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts?.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return 0; }
  if (!DatabaseCtor) return 0;

  try {
    const db = new DatabaseCtor(contentDbPath, { readonly: true });
    try {
      const row = db.prepare(
        `SELECT COALESCE(SUM(LENGTH(content) + LENGTH(title)), 0) AS bytes
         FROM chunks`,
      ).get() as { bytes: number } | undefined;
      return Number(row?.bytes ?? 0);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/**
 * Compute real-bytes stats across one session, one project (worktree
 * filter), or every session on disk (lifetime).
 *
 * - Pass `sessionId` for the conversation tier.
 * - Pass `worktreeHash` to filter `*.db` files by name prefix
 *   (per-project lifetime — `sha256(cwd).slice(0, 16)`).
 * - Pass neither — full lifetime aggregate.
 *
 * Best-effort: returns zeroes when the dir is missing, the DB is
 * corrupt, or the session has no events. Never throws — same
 * contract as `getConversationStats` / `getLifetimeStats` so the
 * stats-render path can never crash on a bad sidecar.
 */
export function getRealBytesStats(opts: {
  sessionId?: string;
  sessionsDir?: string;
  worktreeHash?: string;
  /**
   * v1.0.148 follow-up (Bug E+F): when set, the function aggregates across
   * EVERY session whose `session_meta.project_dir` matches this value, not
   * just one session_id. Resolves the per-conversation under-attribution:
   * one Claude Code conversation typically spans many session_ids (resume
   * cycles, /compact rebirths, PID sub-process sessions spawned by
   * ctx_execute), so a single-session_id filter loses the sandbox-burst
   * bytes_avoided that all live under the conversation's cwd.
   *
   * Uses a META subquery (`session_id IN (SELECT session_id FROM
   * session_meta WHERE project_dir = ?)`), then sums ALL events for
   * matching sessions regardless of their event-level project_dir
   * (sandbox-burst events write `project_dir = ''` even when the
   * META row carries the parent cwd — see Bug F).
   *
   * Mutually exclusive with `sessionId`. When both are set, `sessionId`
   * wins for back-compat.
   */
  projectDir?: string;
  /**
   * v1.0.133 Slice 3: when set alongside `sessionId`, the function joins
   * the FTS5 content DB at this path and folds chunk bytes into
   * `bytesAvoided` + `totalSavedTokens` + `contentBytes`. Render-time
   * only — no DB writes.
   */
  contentDbPath?: string;
  loadDatabase?: () => unknown;
}): RealBytesStats {
  const empty: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    contentBytes: 0,
    totalSavedTokens: 0,
  };

  const sessionsDir = opts.sessionsDir
    ?? join(homedir(), ".claude", "context-mode", "sessions");
  if (!existsSync(sessionsDir)) return empty;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(sessionsDir).filter((f) => {
      if (!f.endsWith(".db")) return false;
      if (opts.worktreeHash && !f.startsWith(opts.worktreeHash)) return false;
      return true;
    });
  } catch { return empty; }
  if (dbFiles.length === 0) return empty;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = opts.loadDatabase
      ? (opts.loadDatabase() as ReturnType<typeof loadDatabaseImpl>)
      : loadDatabaseImpl();
  } catch { return empty; }
  if (!DatabaseCtor) return empty;

  let eventDataBytes = 0;
  let bytesAvoided = 0;
  let bytesReturned = 0;
  let snapshotBytes = 0;

  // Each branch returns the tuple in the SAME column order so callers
  // don't need to type-narrow per row.
  for (const file of dbFiles) {
    const dbPath = join(sessionsDir, file);
    // v1.0.148 hotfix: historical DBs were created with pre-v1.0.130
    // schema (no bytes_avoided / bytes_returned / project_dir columns).
    // The SELECT below references those columns, so without an in-place
    // migration the prepare() throws and the surrounding catch silently
    // skips the WHOLE DB — losing even the LENGTH(data) signal. Run the
    // shared migration helper before opening readonly. Idempotent: a
    // PRAGMA check inside the helper short-circuits when the DB is
    // already current, so post-first-read calls are cheap.
    ensureSessionEventsSchema(dbPath, DatabaseCtor as unknown as new (path: string, opts?: { readonly?: boolean }) => {
      pragma: (q: string) => Array<{ name: string }>;
      exec: (sql: string) => void;
      close: () => void;
    });
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        if (opts.sessionId) {
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events WHERE session_id = ?`,
          ).get(opts.sessionId) as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume WHERE session_id = ?",
            ).get(opts.sessionId) as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
          try {
            // "With context-mode" = the bytes the model paid to ACCESS the
            // kept-out content: ctx_search (query the index) + ctx_fetch_and_index
            // (fetch + index a URL). Sandbox compute (ctx_execute/batch/file) is
            // work-output the model would see regardless — NOT redirect savings —
            // so it is excluded; folding it crushed the bar to a false ~43%.
            const tc = sdb.prepare(
              `SELECT COALESCE(SUM(bytes_returned), 0) AS bytes FROM tool_calls
               WHERE session_id = ? AND tool IN ('ctx_search', 'ctx_fetch_and_index')`,
            ).get(opts.sessionId) as { bytes: number } | undefined;
            if (tc?.bytes) bytesReturned += Number(tc.bytes);
          } catch { /* old schema: no tool_calls table */ }
        } else if (opts.projectDir) {
          // Bug E+F: META-scoped aggregation. Take every session_id whose
          // session_meta.project_dir matches, then sum ALL of those
          // sessions' events regardless of the events' own project_dir
          // (sandbox-burst PID sessions write empty event-level project_dir
          // even when their META carries the parent cwd).
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events
             WHERE session_id IN (
               SELECT session_id FROM session_meta WHERE project_dir = ?
             )`,
          ).get(opts.projectDir) as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              `SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes
               FROM session_resume
               WHERE session_id IN (
                 SELECT session_id FROM session_meta WHERE project_dir = ?
               )`,
            ).get(opts.projectDir) as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
          try {
            const tc = sdb.prepare(
              `SELECT COALESCE(SUM(bytes_returned), 0) AS bytes
               FROM tool_calls
               WHERE session_id IN (
                 SELECT session_id FROM session_meta WHERE project_dir = ?
               )
               AND tool IN ('ctx_search', 'ctx_fetch_and_index')`,
            ).get(opts.projectDir) as { bytes: number } | undefined;
            if (tc?.bytes) bytesReturned += Number(tc.bytes);
          } catch { /* old schema: no tool_calls table */ }
        } else {
          const row = sdb.prepare(
            `SELECT
               COALESCE(SUM(LENGTH(data)), 0)   AS data_bytes,
               COALESCE(SUM(bytes_avoided), 0)  AS bytes_avoided,
               COALESCE(SUM(bytes_returned), 0) AS bytes_returned
             FROM session_events`,
          ).get() as
            | { data_bytes: number; bytes_avoided: number; bytes_returned: number }
            | undefined;
          if (row) {
            eventDataBytes += Number(row.data_bytes ?? 0);
            bytesAvoided   += Number(row.bytes_avoided ?? 0);
            bytesReturned  += Number(row.bytes_returned ?? 0);
          }
          try {
            const snap = sdb.prepare(
              "SELECT COALESCE(SUM(LENGTH(snapshot)), 0) AS bytes FROM session_resume",
            ).get() as { bytes: number } | undefined;
            if (snap?.bytes) snapshotBytes += Number(snap.bytes);
          } catch { /* old schema */ }
          try {
            const tc = sdb.prepare(
              `SELECT COALESCE(SUM(bytes_returned), 0) AS bytes FROM tool_calls
               WHERE tool IN ('ctx_search', 'ctx_fetch_and_index')`,
            ).get() as { bytes: number } | undefined;
            if (tc?.bytes) bytesReturned += Number(tc.bytes);
          } catch { /* old schema: no tool_calls table */ }
        }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt — skip */ }
  }

  // v1.0.133 Slice 3: fold content DB chunk bytes for this session into
  // bytesAvoided. Skipped silently when caller didn't pass contentDbPath
  // (lifetime / project tiers, or pre-Slice-3 callers). Treated as
  // "avoided" because indexed chunks are bytes that would have been
  // re-inflated into context on every search if the model had to
  // re-read raw files.
  let contentBytes = 0;
  if (opts.sessionId && opts.contentDbPath) {
    contentBytes = getContentBytesForSession(
      opts.sessionId,
      opts.contentDbPath,
      { loadDatabase: opts.loadDatabase },
    );
    bytesAvoided += contentBytes;
  }

  const totalSavedTokens = Math.floor(
    (eventDataBytes + bytesAvoided + snapshotBytes) / 4,
  );

  return { eventDataBytes, bytesAvoided, bytesReturned, snapshotBytes, contentBytes, totalSavedTokens };
}

/**
 * v1.0.169 — Section 1 "Where you are now" = the LIVE conversation window.
 *
 * A single live conversation fans out into sub-agents and ctx_execute
 * sub-process sessions. Each runs in its OWN, disposable context window (its
 * own session_id) — but all under the SAME worktree DB, because the worktree
 * hash is sha256(cwd) and they share the cwd. Their retrieval (ctx_search /
 * ctx_fetch_and_index returns) entered THOSE windows and was thrown away when
 * each returned its short summary; it never touched the window the user is
 * reading now. So the live-window savings bar must split the worktree by
 * which retrieval actually landed in the user's window:
 *
 *   bytesReturned ("With context-mode")  = THIS session's retrieval only —
 *       what genuinely entered the live window.
 *   bytesAvoided  ("kept out")           = everything the whole worktree moved
 *       (avoided + every session's retrieval) MINUS what landed in your window.
 *
 * Scoping by `worktreeHash` (not project-root + time) means the user's OTHER
 * parallel worktrees never bleed in — a different worktree is a different
 * cwd-hash, hence a different DB file the prefix filter excludes — while the
 * sub-agent fan-out this conversation actually spawned is fully credited.
 */
export function getConversationWindowStats(opts: {
  sessionId: string;
  worktreeHash: string;
  sessionsDir?: string;
  contentDbPath?: string;
}): RealBytesStats {
  // Whole current worktree: every session that shares this cwd-hash DB.
  const pool = getRealBytesStats({
    worktreeHash: opts.worktreeHash,
    sessionsDir: opts.sessionsDir,
  });
  // Just the live window: this session_id (folds its own ctx_search/ctx_fetch
  // retrieval + content chunks).
  const mine = getRealBytesStats({
    sessionId: opts.sessionId,
    worktreeHash: opts.worktreeHash,
    sessionsDir: opts.sessionsDir,
    contentDbPath: opts.contentDbPath,
  });

  const windowReturned = mine.bytesReturned;
  const movedTotal = pool.bytesAvoided + pool.bytesReturned;
  // What context-mode kept OUT of the live window = everything moved across the
  // worktree minus the slice that actually entered this window. Clamp at 0 so a
  // stale/edge DB can never produce a negative bar.
  const keptOut = Math.max(0, movedTotal - windowReturned);

  return {
    eventDataBytes: pool.eventDataBytes,
    bytesAvoided: keptOut,
    bytesReturned: windowReturned,
    snapshotBytes: pool.snapshotBytes,
    contentBytes: mine.contentBytes,
    totalSavedTokens: Math.floor(
      (pool.eventDataBytes + keptOut + pool.snapshotBytes) / 4,
    ),
  };
}

const DEFAULT_REAL_USAGE_FILTER: Required<Omit<RealUsageFilter, "nowMs">> = {
  minEvents: 100,
  minProjects: 5,
  recencyMs: 30 * 86_400_000,
  minAvgBytes: 50,
};

/**
 * Scan one adapter's sessions dir. Always returns a result — never throws.
 * When the dir is missing, the result has zeroed counts and `isReal=false`.
 *
 * Mirrors the inner SessionDB-walk inside `getLifetimeStats`
 * (analytics.ts:677-752) so the new multi-adapter path stays in lock-step
 * with the per-DB queries the single-dir path already trusts.
 */
function scanOneAdapter(
  entry: AdapterDirEntry,
  loadDb: () => unknown,
  filter: Required<Omit<RealUsageFilter, "nowMs">> & { nowMs: number },
): AdapterScanResult {
  const result: AdapterScanResult = {
    name: entry.name,
    eventCount: 0,
    sessionCount: 0,
    dataBytes: 0,
    rescueBytes: 0,
    contentBytes: 0,
    uuidConvs: 0,
    projectDirs: [],
    firstMs: Number.POSITIVE_INFINITY,
    lastMs: 0,
    isReal: false,
  };
  if (!existsSync(entry.sessionsDir)) return result;

  let dbFiles: string[] = [];
  try {
    dbFiles = readdirSync(entry.sessionsDir).filter((f) => f.endsWith(".db"));
  } catch { return result; }
  if (dbFiles.length === 0) return result;

  let DatabaseCtor: ReturnType<typeof loadDatabaseImpl> | null = null;
  try {
    DatabaseCtor = loadDb() as ReturnType<typeof loadDatabaseImpl>;
  } catch { return result; }
  if (!DatabaseCtor) return result;

  const projectsSet = new Set<string>();
  const sessionsSet = new Set<string>();

  for (const file of dbFiles) {
    const dbPath = join(entry.sessionsDir, file);
    try {
      const sdb = new DatabaseCtor(dbPath, { readonly: true });
      try {
        const ev = sdb.prepare(
          "SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM session_events",
        ).get() as { cnt: number; bytes: number } | undefined;
        if (ev) {
          result.eventCount += Number(ev.cnt ?? 0);
          result.dataBytes  += Number(ev.bytes ?? 0);
        }
        try {
          const ss = sdb.prepare(
            "SELECT COUNT(*) AS cnt FROM session_meta",
          ).get() as { cnt: number } | undefined;
          result.sessionCount += Number(ss?.cnt ?? 0);
        } catch { /* old schema */ }
        try {
          const snap = sdb.prepare(
            "SELECT COALESCE(SUM(length(snapshot)), 0) AS bytes FROM session_resume WHERE consumed = 1",
          ).get() as { bytes: number } | undefined;
          if (snap?.bytes) result.rescueBytes += Number(snap.bytes);
        } catch { /* old schema */ }
        try {
          const range = sdb.prepare(
            "SELECT MIN(created_at) AS mn, MAX(created_at) AS mx FROM session_events",
          ).get() as { mn: string | null; mx: string | null } | undefined;
          if (range?.mn) {
            const t = Date.parse(range.mn + (range.mn.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t < result.firstMs) result.firstMs = t;
          }
          if (range?.mx) {
            const t = Date.parse(range.mx + (range.mx.endsWith("Z") ? "" : "Z"));
            if (Number.isFinite(t) && t > result.lastMs) result.lastMs = t;
          }
        } catch { /* old schema */ }
        try {
          const projRows = sdb.prepare(
            "SELECT DISTINCT project_dir AS p FROM session_events WHERE project_dir != ''",
          ).all() as Array<{ p: string }>;
          for (const row of projRows) if (row.p) projectsSet.add(row.p);
        } catch { /* old schema */ }
        try {
          const sidRows = sdb.prepare(
            "SELECT DISTINCT session_id AS s FROM session_events",
          ).all() as Array<{ s: string }>;
          for (const row of sidRows) if (row.s) sessionsSet.add(row.s);
        } catch { /* old schema */ }
      } finally {
        sdb.close();
      }
    } catch { /* missing tables / corrupt — skip */ }
  }

  result.projectDirs = Array.from(projectsSet);
  result.uuidConvs = sessionsSet.size;

  // Real-usage filter — see RealUsageFilter docstring.
  const avgBytes = result.eventCount > 0 ? result.dataBytes / result.eventCount : 0;
  const recentEnough =
    result.lastMs > 0 && (filter.nowMs - result.lastMs) <= filter.recencyMs;
  result.isReal =
    result.eventCount  >= filter.minEvents &&
    projectsSet.size   >= filter.minProjects &&
    recentEnough &&
    avgBytes           >= filter.minAvgBytes;

  return result;
}

/**
 * Aggregate lifetime stats across every adapter dir under `home`.
 * The marketing line — "your work everywhere on this machine across all
 * AI tools" — depends on this. Existing `getLifetimeStats` (single dir)
 * is untouched; this is purely additive.
 */
export function getMultiAdapterLifetimeStats(opts?: {
  home?: string;
  loadDatabase?: () => unknown;
  filter?: RealUsageFilter;
}): MultiAdapterLifetimeStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });
  const loadDb = opts?.loadDatabase ?? loadDatabaseImpl;
  const filter = {
    ...DEFAULT_REAL_USAGE_FILTER,
    ...(opts?.filter ?? {}),
    nowMs: opts?.filter?.nowMs ?? Date.now(),
  };

  const perAdapter: AdapterScanResult[] = [];
  let totalEvents = 0;
  let totalSessions = 0;
  let totalBytes = 0;

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue; // only surface adapters with a sessions dir
    const r = scanOneAdapter(entry, loadDb, filter);
    perAdapter.push(r);
    totalEvents   += r.eventCount;
    totalSessions += r.sessionCount;
    totalBytes    += r.dataBytes + r.rescueBytes;
  }

  return { totalEvents, totalSessions, totalBytes, perAdapter };
}

/**
 * Aggregate real-bytes stats across every adapter dir under `home`.
 * Mirrors `getRealBytesStats` (single dir, analytics.ts:887-989) but
 * iterates {@link enumerateAdapterDirs}. Optional `sessionId` /
 * `worktreeHash` filters apply uniformly to every dir.
 */
export function getMultiAdapterRealBytesStats(opts?: {
  home?: string;
  sessionId?: string;
  worktreeHash?: string;
  loadDatabase?: () => unknown;
}): MultiAdapterRealBytesStats {
  const dirs = enumerateAdapterDirs({ home: opts?.home });

  const sum: RealBytesStats = {
    eventDataBytes: 0,
    bytesAvoided: 0,
    bytesReturned: 0,
    snapshotBytes: 0,
    contentBytes: 0,
    totalSavedTokens: 0,
  };
  const perAdapter: MultiAdapterRealBytesStats["perAdapter"] = [];

  for (const entry of dirs) {
    if (!existsSync(entry.sessionsDir)) continue;
    const one = getRealBytesStats({
      sessionsDir: entry.sessionsDir,
      sessionId: opts?.sessionId,
      worktreeHash: opts?.worktreeHash,
      loadDatabase: opts?.loadDatabase,
    });
    // ARCH-REVIEW-V134-ABC SLICE C: aggregate this adapter's content DB
    // bytes into the lifetime sum. `getRealBytesStats` operates on
    // session events only and never touches the sibling content/ tree —
    // without this step the lifetime tier in ctx_stats reports 0 for
    // every adapter except whichever one happens to share the
    // sessionsDir of the caller. Lifetime tier ignores sessionId so
    // the all-sessions aggregator is the right helper here.
    if (!opts?.sessionId) {
      const contentDbPath = join(entry.contentDir, "content.db");
      const adapterContentBytes = getContentBytesAllSessions(contentDbPath, {
        loadDatabase: opts?.loadDatabase as (() => unknown) | undefined,
      });
      one.contentBytes += adapterContentBytes;
      sum.contentBytes += adapterContentBytes;
    }
    perAdapter.push({ name: entry.name, ...one });
    sum.eventDataBytes += one.eventDataBytes;
    sum.bytesAvoided   += one.bytesAvoided;
    sum.bytesReturned  += one.bytesReturned;
    sum.snapshotBytes  += one.snapshotBytes;
  }
  sum.totalSavedTokens = Math.floor(
    (sum.eventDataBytes + sum.bytesAvoided + sum.snapshotBytes) / 4,
  );

  return { ...sum, perAdapter };
}
