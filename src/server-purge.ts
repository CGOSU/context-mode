import { existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { hashProjectDirLegacy } from "./session/db.js";
import { purgeSession } from "./session/purge.js";
import { coerceBoolean } from "./server-input.js";
import type { ServerToolContext } from "./server.js";

export function registerPurgeTool(context: ServerToolContext): void {
  const { server, trackResponse, getStorePath, getProjectDir, getSessionDir, sessionStats, getStatsFilePath } = context;


// ── ctx-purge: explicit knowledge base wipe ─────────────────────────────────
//
// Issue #520 — scoped purge.
// The schema is ADDITIVE: bare {confirm:true} preserves the legacy
// project-wide wipe verbatim (with a stderr deprecation warning so
// future callers migrate to explicit scope). When sessionId is given,
// only that session's rows + FTS5 chunks are removed; project-wide
// files (events.md, FTS5 store file, stats file) are preserved.
// Passing both sessionId AND scope:"project" is ambiguous (does the
// caller want a per-session wipe or a project-wide one?) and is
// rejected by an explicit check in the handler body — NOT a schema-level
// .refine(). MCP SDK's normalizeObjectSchema() reads `.shape` to project
// inputSchema → JSON Schema for tools/list; a ZodEffects (refine wrapper)
// has no `.shape`, so the SDK silently emits `properties: {}`, and Claude
// Code's strict-input-validation gate then rejects EVERY call to this
// tool with "input_schema does not support fields". Issue #563.
server.registerTool(
  "ctx_purge",
  {
    title: "Purge Knowledge Base",
    // #846: permanently deletes indexed content — destructive. Purging an
    // already-purged scope has no further effect (idempotent). No network.
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    description: `DESTRUCTIVE: permanently delete indexed content. Cannot be undone. Requires confirm:true and exactly one scope.

WHEN:
  - User explicitly asks to clear a specific session ('purge this session', 'wipe this conversation')
  - User explicitly asks to reset the whole project ('reset everything', 'wipe the knowledge base')

WHEN NOT:
  - User says 'reset', 'clear', or 'wipe' without naming a scope -> ask which scope before calling
  - User wants to free memory or improve performance -> recommend ctx_stats first, do not purge

SCOPES (pass exactly one):
  - Per-session: ctx_purge(confirm: true, sessionId: "<uuid>") deletes that session's events (auto-captured decisions, errors, plans, user prompts, rejected approaches, etc.) and per-session FTS5 chunks; sibling sessions and stats file are preserved.
  - Per-project: ctx_purge(confirm: true, scope: "project") wipes FTS5 knowledge base, every session DB row, events markdown, and resets the stats file. Use ctx_stats first to preview category counts before purging.

CONTRACT:
  - confirm:true is required; confirm:false returns 'purge cancelled'.
  - sessionId and scope:'project' together return 'ambiguous - pick one'.
  - scope:'session' without sessionId throws (sessionId required).
  - Bare {confirm:true} is deprecated: maps to scope:'project' with a stderr warning; will hard-error in a future major.

RETURNS:
  A summary of removed rows + the resolved scope.

EXAMPLE: ctx_purge(confirm: true, sessionId: "7c8a-1234-5678-9abc-def012345678")
EXAMPLE: ctx_purge(confirm: true, scope: "project")`,
    // NOTE: schema MUST be a plain z.object — no .refine()/.transform()/
    // .superRefine() wrapper. See block comment above & issue #563. The
    // cross-field ambiguity check lives in the handler body below.
    inputSchema: z.object({
      // confirm: wrapped in coerceBoolean preprocessor — OpenCode's native
      // plugin bridge can deliver `confirm:"true"` / `confirm:"false"` as
      // string literals. Without this, v1.0.139's inputSchema.parse() path
      // rejects valid intent as "Expected boolean, received string" (#627).
      confirm: z.preprocess(coerceBoolean, z.boolean()).describe(
        "MUST be true. Destructive operation; false returns 'purge cancelled'."
      ),
      sessionId: z.string().optional().describe(
        "UUID of a single session. Pairs with confirm:true to wipe only that " +
        "session's events + per-session FTS5 chunks. Sibling sessions and the " +
        "stats file are preserved. MUST NOT be combined with scope:'project'."
      ),
      scope: z.enum(["session", "project"]).optional().describe(
        "Explicit scope selector. 'session' REQUIRES sessionId. 'project' wipes " +
        "the entire project (FTS5 + every session + stats). Omit only for the " +
        "deprecated bare-{confirm:true} back-compat path."
      ),
    }),
  },
  async ({ confirm, sessionId, scope }) => {
    // Cross-field ambiguity check — formerly a schema .refine(), moved
    // into the handler so the inputSchema stays a plain ZodObject and
    // the MCP SDK can serialize `.shape` into JSON Schema (issue #563).
    // Same human-readable message as the original refine() preserved.
    if (sessionId && scope === "project") {
      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text:
            "Ambiguous purge: sessionId implies scope:'session', cannot combine with scope:'project'. " +
            "Use scope:'project' WITHOUT sessionId for the legacy whole-project wipe.",
        }],
        isError: true,
      });
    }
    if (!confirm) {
      return trackResponse("ctx_purge", {
        content: [{
          type: "text" as const,
          text: "Purge cancelled. Pass confirm: true to proceed.",
        }],
      });
    }

    // Effective scope resolution:
    //   - explicit scope wins
    //   - else "session" iff sessionId is given
    //   - else "project" (back-compat — emit deprecation warning so
    //     callers migrate to the explicit form before a future major).
    const effectiveScope: "session" | "project" =
      scope ?? (sessionId ? "session" : "project");
    if (!scope && !sessionId) {
      console.warn(
        "[context-mode] ctx_purge: bare {confirm:true} is deprecated. " +
        "Pass scope:'project' for the whole-project wipe, or scope:'session' + sessionId " +
        "for a scoped wipe. See issue #520."
      );
    }

    // Close the persistent FTS5 content store handle BEFORE delegating to
    // purgeSession so the store's lock is released on Windows. The handle
    // is recreated lazily on the next getStore() call.
    let storePathForPurge: string | undefined;
    try {
      storePathForPurge = getStorePath();
    } catch { /* best effort — store path may be unresolvable on fresh install */ }
    if (context._store) {
      try { context._store.cleanup(); } catch { /* best effort */ }
      context._store = null;
    }

    // FTS5 store: pass contentDir so purgeSession sweeps BOTH canonical
    // and legacy raw-casing variants (dual-hash, mirrors session events).
    // storePath is also passed for the rare case where the resolver picked
    // an absolute path that differs from the dual-hash pair (e.g. caller
    // pre-migrated). Both paths are de-duped during unlink.
    const contentDir = storePathForPurge ? dirname(storePathForPurge) : undefined;
    const { deleted } = purgeSession({
      projectDir: getProjectDir(),
      sessionsDir: getSessionDir(),
      storePath: storePathForPurge,
      contentDir,
      legacyContentDir: join(homedir(), ".context-mode", "content"),
      // hashProjectDirLegacy mirrors the deployed (≤ v1.0.111) raw-casing
      // hash that named files under ~/.context-mode/content/. Using the
      // legacy hash here is correct: that pre-pre-legacy directory was
      // never migrated and still uses raw casing.
      contentHash: hashProjectDirLegacy(getProjectDir()),
      scope: effectiveScope,
      sessionId,
    });

    // Stats are PROJECT-scoped (one stats file per project, summing all
    // sessions). A scoped per-session purge MUST leave stats alone — they
    // still belong to other sessions in the same project. Stats reset
    // happens ONLY when scope === "project".
    if (effectiveScope === "project") {
      // Reset in-memory session stats
      sessionStats.calls = {};
      sessionStats.bytesReturned = {};
      sessionStats.bytesIndexed = 0;
      sessionStats.bytesSandboxed = 0;
      sessionStats.cacheHits = 0;
      sessionStats.cacheBytesSaved = 0;
      sessionStats.sessionStart = Date.now();
      deleted.push("session stats");

      // Also drop the persisted stats file so external readers see a fresh state
      try {
        const statsFile = getStatsFilePath();
        if (existsSync(statsFile)) unlinkSync(statsFile);
      } catch { /* best effort */ }
    }

    const message = effectiveScope === "session"
      ? `Purged session ${sessionId}: ${deleted.length ? deleted.join(", ") : "no matching rows"}. ` +
        `Other sessions and project-wide stats preserved.`
      : `Purged: ${deleted.join(", ")}. All session data for this project has been permanently deleted.`;
    return trackResponse("ctx_purge", {
      content: [{
        type: "text" as const,
        text: message,
      }],
    });
  },
);
}
