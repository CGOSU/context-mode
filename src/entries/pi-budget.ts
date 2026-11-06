import { randomUUID } from "node:crypto";
import { CtxError } from "../core/contracts/errors.ts";
import type { ToolContext, ToolReply } from "../core/contracts/types.ts";
import { indexText } from "../core/index/text.ts";
import { closeDb, openDb } from "../core/store/db.ts";

export const PI_DEFAULT_OUTPUT_CHARS = 12_000;
const PI_MAX_OUTPUT_CHARS = 80 * 1024;
const budgetedTools = new Set(["ctx_execute", "ctx_batch", "ctx_search"]);

/** Pi presentation options never reach the upstream strict tool schemas. */
export function normalizePiCall(toolName: string, params: unknown): { params: unknown; maxOutputChars?: number } {
  if (!budgetedTools.has(toolName)) return { params };
  if (params === null || typeof params !== "object" || Array.isArray(params)) return { params, maxOutputChars: PI_DEFAULT_OUTPUT_CHARS };
  const { maxOutputChars: requested, ...input } = params as Record<string, unknown>;
  const value = requested === undefined ? PI_DEFAULT_OUTPUT_CHARS : requested;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1000 || value > PI_MAX_OUTPUT_CHARS) {
    throw new CtxError("INVALID_ARGS", { field: "maxOutputChars", action: "use an integer from 1000 to " + PI_MAX_OUTPUT_CHARS });
  }
  return { params: input, maxOutputChars: value };
}

export function withPiBudgetSchema(toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  if (!budgetedTools.has(toolName)) return schema;
  return { ...schema, properties: {
    ...(schema.properties as Record<string, unknown> | undefined),
    maxOutputChars: { type: "integer", minimum: 1000, maximum: PI_MAX_OUTPUT_CHARS,
      description: "Maximum characters in the complete preview; defaults to 12000. Omitted output stays searchable." },
  } };
}

function clip(text: string, length: number): string {
  let end = Math.max(0, length);
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end);
}

/** Store a whole reply before shortening it; status and exact source handles stay outside the preview. */
export async function applyPiResponseBudget(toolName: string, reply: ToolReply, ctx: ToolContext, maxOutputChars?: number): Promise<ToolReply> {
  if (maxOutputChars === undefined || reply.text.length <= maxOutputChars) return reply;
  const details = reply.details ?? {};
  const status = typeof details.status === "string" ? details.status : reply.isError ? "failed" : "completed";
  const statusLine = "Status: " + clip(status, 80) + (typeof details.exitCode === "number" ? "; exit " + details.exitCode : "");
  const originalSource = typeof details.source === "string" ? "Original source: " + clip(details.source, 160) + "\n" : "";
  // Keep the original diagnostic even if a caller supplied a large error body.
  const diagnostic = reply.isError ? clip(reply.text.split("\n", 1)[0], 300) + "\n" : "";
  let previewSource: string;
  let previewSourceId: number;
  try {
    const db = await openDb(ctx.project);
    try {
      // Labels take precedence over numeric handles during search. Return our unique
      // label so an existing user label such as "s2" cannot redirect this preview.
      previewSource = "pi-preview:" + toolName + ":" + randomUUID();
      const stored = indexText(db, ctx.project, ctx.sessionId, previewSource,
        "Saved tool reply; source timestamps, if present, describe the original evidence.\n\n" + reply.text, "text");
      previewSourceId = stored.sourceId;
    } finally { closeDb(db); }
  } catch {
    const head = statusLine + "\n" + diagnostic + originalSource + "Output storage failed; omitted reply text is not available from this preview.\n\n";
    return { ...reply, isError: true, text: head + clip(reply.text, maxOutputChars - head.length),
      details: { ...details, outputLimited: true, storageError: true, maxOutputChars } };
  }
  const head = statusLine + "\n" + diagnostic + originalSource +
    "Search saved reply: ctx_search({queries:[\"\"], source:" + JSON.stringify(previewSource) + "})\n" +
    "[indexed-content preview; verify original sources and dates]\n\n";
  return { ...reply, text: head + clip(reply.text, maxOutputChars - head.length),
    details: { ...details, previewSource, previewSourceId, outputLimited: true, maxOutputChars } };
}
