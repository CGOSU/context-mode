/** One source for the Pi routing hint and its request-local duplicate check. */
export const PI_ROUTING_ANCHOR =
  "context-mode active. Choose tools by task; there is no fixed tool hierarchy. " +
  "Locate unfamiliar code → graph_locate/graph_inspect when available. " +
  "Read files before editing → read; modify files → edit/write. " +
  "Analyze large files without editing → ctx_execute_file. " +
  "Large logs/test output → ctx_execute. Multi-command research with large output → ctx_batch_execute. " +
  "Simple reads and short commands → native tools; context-mode is optional. " +
  "Web pages → ctx_fetch_and_index then ctx_search. Index docs → ctx_index. " +
  "Stats → ctx_stats. Doctor → ctx_doctor. Upgrade → ctx_upgrade. Purge → ctx_purge.";

function startsWithRouting(value: unknown): value is string {
  return typeof value === "string" &&
    (value === PI_ROUTING_ANCHOR || value.startsWith(PI_ROUTING_ANCHOR + "\n\n"));
}

/**
 * Remove only our exact routing prefix when another injection already supplies
 * it. Do not rewrite existing messages or deduplicate dynamic memory/resumes.
 */
export function omitRepeatedRouting(
  pending: string,
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string {
  if (!startsWithRouting(pending)) return pending;
  const alreadyPresent = messages.some(message => {
    if (message.role !== "user") return false;
    if (startsWithRouting(message.content)) return true;
    return Array.isArray(message.content) && message.content.some(block =>
      block?.type === "text" && startsWithRouting(block.text),
    );
  });
  if (!alreadyPresent) return pending;
  return pending === PI_ROUTING_ANCHOR ? "" : pending.slice(PI_ROUTING_ANCHOR.length + 2);
}
