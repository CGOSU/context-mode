


/**
 * Defensive coercion: parse stringified JSON arrays, AND lift a bare
 * non-empty string into a single-element array.
 *
 * Two shapes show up from the wild:
 *   1. `"[\"a\",\"b\"]"` — Claude Code double-serialization bug
 *      (https://github.com/anthropics/claude-code/issues/34520).
 *   2. `"single query"` — some LLM providers / OpenCode's native plugin
 *      bridge deliver a single string when the schema expects `string[]`
 *      (issue #627). v1.0.139 (#621) made the bridge run the Zod schema,
 *      so this now surfaces as `Expected array, received string`. The
 *      ergonomic recovery is to treat it as `["single query"]`.
 *
 * An empty string is intentionally NOT lifted — empty input should still
 * fail Zod's `.min(1)` check rather than masquerade as `[""]`.
 */
export function coerceJsonArray(val: unknown): unknown {
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (trimmed.length === 0) return val; // let zod produce "non-empty" error
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* fall through — not JSON, treat as bare-string lift */ }
    // Bare-string lift (#627): single query delivered as a plain string.
    return [val];
  }
  return val;
}


/**
 * Defensive coercion: accept the string literals "true"/"false" as
 * booleans. The OpenCode native plugin bridge (and several LLM providers'
 * tool-call JSON) stringifies primitives — `background:"false"` instead
 * of `background:false`, `confirm:"true"` instead of `confirm:true`.
 *
 * We deliberately do NOT use `z.coerce.boolean()` for boolean fields:
 * `Boolean("false")` is `true`, so Zod's coerce path silently flips the
 * meaning. This helper recognises only the documented literal forms and
 * passes anything else through untouched so Zod surfaces the right error.
 *
 * Fixes #627.
 */
export function coerceBoolean(val: unknown): unknown {
  if (typeof val === "string") {
    const t = val.trim().toLowerCase();
    if (t === "true") return true;
    if (t === "false") return false;
  }
  return val;
}


/**
 * Coerce commands array: handles double-serialization AND the case where
 * the model passes plain command strings instead of {label, command} objects.
 */
export function coerceCommandsArray(val: unknown): unknown {
  const arr = coerceJsonArray(val);
  if (Array.isArray(arr)) {
    return arr.map((item, i) =>
      typeof item === "string" ? { label: `cmd_${i + 1}`, command: item } : item
    );
  }
  return arr;
}
