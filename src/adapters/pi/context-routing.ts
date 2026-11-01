/** One source for the Pi routing hint and its request-local duplicate check. */
export const PI_ROUTING_ANCHOR =
  "context-mode active. Use native tools for ordinary code work and short commands; " +
  "use ctx_* for large output and indexed knowledge. See the context-mode Skill for tool selection.";

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
