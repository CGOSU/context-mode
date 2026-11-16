import { existsSync } from "node:fs";
import { z } from "zod";
import { hashProjectDirCanonical, resolveSessionDbPath } from "./session/db.js";
import { loadDatabase } from "./db-base.js";
import { AnalyticsEngine, formatReport, getConversationStats, getContentBytesAllSessions, getConversationWindowStats, getLifetimeStats, getRealBytesStats } from "./session/analytics.js";
import type { ServerToolContext } from "./server.js";

export function registerStatsTool(context: ServerToolContext): void {
  const { server, getProjectDir, getSessionDir, sessionStats, getStorePath, VERSION, trackResponse } = context;

// ─────────────────────────────────────────────────────────
// Tool: stats
// ─────────────────────────────────────────────────────────

/**
 * Create a minimal in-memory DB adapter for when the session DB is unavailable.
 * All queries return empty results so AnalyticsEngine.queryAll() still works.
 */
function createMinimalDb(): import("./session/analytics.js").DatabaseAdapter {
  return {
    prepare: () => ({
      run: () => undefined,
      get: (..._args: unknown[]) => ({ cnt: 0, compact_count: 0, minutes: null, rate: 0, avg: 0, outcome: "exploratory" }),
      all: () => [],
    }),
  };
}


server.registerTool(
  "ctx_stats",
  {
    title: "Session Statistics",
    // #846: read-only diagnostics. Was cancelled by Codex when unannotated.
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    description:
      "Returns context consumption statistics for the current session. " +
      "Shows total bytes returned to context, breakdown by tool, call counts, " +
      "estimated token usage, and context savings ratio.",
    inputSchema: z.object({}),
  },
  async () => {
    // ONE call, ONE source — AnalyticsEngine.queryAll()
    let text: string;
    try {
      const projectDir = getProjectDir();
      // Canonical hash + migration-aware path. The downstream
      // getConversationStats / getRealBytesStats reconstruct the DB
      // filename from worktreeHash; pass the SAME canonical hash that
      // resolveSessionDbPath used so they hit the same file.
      const dbHash = hashProjectDirCanonical(projectDir);
      const sessionDbPath = resolveSessionDbPath({
        projectDir,
        sessionsDir: getSessionDir(),
      });

      if (existsSync(sessionDbPath)) {
        const Database = loadDatabase();
        const sdb = new Database(sessionDbPath, { readonly: true });
        try {
          const engine = new AnalyticsEngine(sdb);
          const report = engine.queryAll(sessionStats);
          const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
          let conversation;
          let realBytes;
          try {
            let sid = process.env.CLAUDE_SESSION_ID;
            if (!sid) {
              const row = sdb.prepare(
                "SELECT session_id FROM session_events WHERE session_id LIKE '________-____-____-____-____________' ORDER BY created_at DESC LIMIT 1"
              ).get() as { session_id: string } | undefined;
              sid = row?.session_id;
            }
            if (sid) {
              conversation = getConversationStats({ sessionId: sid, sessionsDir: getSessionDir(), worktreeHash: dbHash });
              const contentDbPath = getStorePath();
              const convReal = getConversationWindowStats({ sessionId: sid, worktreeHash: dbHash, sessionsDir: getSessionDir(), contentDbPath });
              const lifeRealBase = getRealBytesStats({ sessionsDir: getSessionDir() });
              const lifeContentBytes = getContentBytesAllSessions(contentDbPath);
              const lifeReal = {
                ...lifeRealBase,
                contentBytes: lifeRealBase.contentBytes + lifeContentBytes,
                bytesAvoided: lifeRealBase.bytesAvoided + lifeContentBytes,
                totalSavedTokens: Math.floor(
                  (lifeRealBase.eventDataBytes
                    + lifeRealBase.bytesAvoided
                    + lifeContentBytes
                    + lifeRealBase.snapshotBytes) / 4,
                ),
              };
              realBytes = { conversation: convReal, lifetime: lifeReal };
            }
          } catch { /* never block ctx_stats */ }
          // Only query MCP tool usage when falling back to the legacy report (narrative early-returns without it).
          const mcpUsage = (conversation && conversation.events > 0) ? undefined : engine.getMcpToolUsage();
          text = formatReport(report, VERSION, null, { lifetime, mcpUsage, conversation, realBytes, cwd: projectDir });
        } finally {
          sdb.close();
        }
      } else {
        // No session DB — build a minimal report from runtime stats only.
        const engine = new AnalyticsEngine(createMinimalDb());
        const report = engine.queryAll(sessionStats);
        const lifetime = getLifetimeStats({ sessionsDir: getSessionDir() });
        text = formatReport(report, VERSION, null, { lifetime });
      }
    } catch {
      // Session DB not available or incompatible — build minimal report from runtime stats
      const engine = new AnalyticsEngine(createMinimalDb());
      const report = engine.queryAll(sessionStats);
      let lifetime;
      try { lifetime = getLifetimeStats({ sessionsDir: getSessionDir() }); } catch { /* never block ctx_stats */ }
      text = formatReport(report, VERSION, null, lifetime ? { lifetime } : undefined);
    }

    return trackResponse("ctx_stats", {
      content: [{ type: "text" as const, text }],
    });
  },
);
}
