/** Character budgets bound previews, never the indexed evidence or exit status. */
export function resolveResponseBudget(
  requested: number | undefined,
  _clientInfo?: { name: string; version?: string },
  defaultBudget = 12_000,
): number {
  if (requested !== undefined && Number.isFinite(requested)) {
    return Math.max(1000, Math.min(80 * 1024, Math.floor(requested)));
  }
  return defaultBudget;
}

export function boundResponse(
  text: string,
  maxChars: number,
  notice = "(output cap reached) Preview only; evidence remains indexed. Narrow ctx_search queries and source, or request a larger maxOutputChars.",
): string {
  if (text.length <= maxChars) return text;
  const suffix = `\n\n${notice}`;
  // Do not split a UTF-16 surrogate pair at the preview boundary.
  let end = Math.max(0, maxChars - suffix.length);
  if (end && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end) + suffix.slice(0, maxChars);
}
