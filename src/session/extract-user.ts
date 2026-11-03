import type { SessionEvent } from "./extract-types.js";
import { safeString } from "./extract-common.js";

// ── User-message extractors ────────────────────────────────────────────────

/**
 * Category 6: decision
 * User corrections / approach selections.
 *
 * Universal-rule detector (Hybrid C, issue #535):
 *   A decision message typically takes the structural shape
 *     "{negation/rejection} X {separator} Y" — across every human language.
 *
 *   We treat the following as the structural shape:
 *     - contains a clause separator (ASCII `,` `;`, fullwidth `，` `；`,
 *       Japanese ideographic `、`, Arabic `،`), AND
 *     - codepoint length is in the corrective range (15..500), AND
 *     - the message is not a question (no cross-script `?`), AND
 *     - contains at least one alphabetic codepoint.
 *
 *   The renderer prints the raw message back to the next LLM, so the gate
 *   only needs to be a coarse "looks like a correction" filter — the LLM
 *   handles fine-grained interpretation. No per-language keyword list.
 */

const CLAUSE_SEPARATOR_PATTERN = /[,;，；、،]/u;
const DECISION_MIN_CHARS = 15;
const DECISION_MAX_CHARS = 500;

function looksLikeDecision(trimmed: string): boolean {
  if (QUESTION_MARK_PATTERN.test(trimmed)) return false;
  if (!ALPHABETIC_PATTERN.test(trimmed)) return false;
  if (!CLAUSE_SEPARATOR_PATTERN.test(trimmed)) return false;
  const codepointLength = [...trimmed].length;
  return codepointLength >= DECISION_MIN_CHARS && codepointLength <= DECISION_MAX_CHARS;
}

function extractUserDecision(message: string): SessionEvent[] {
  const trimmed = message.trim();
  if (!looksLikeDecision(trimmed)) return [];

  return [{
    type: "decision",
    category: "decision",
    data: safeString(message),
    priority: 2,
  }];
}

/**
 * Category 7: role
 * Persona / behavioral directive patterns.
 *
 * Universal-rule detector (Hybrid C, issue #535):
 *   A persona/role statement is structurally a single non-question clause
 *   of moderate length containing more than one lexical token — e.g.
 *     "You are a senior engineer", "Tu es développeur",
 *     "あなたは経験豊富なエンジニアです", "Sen kıdemli mühendisisin".
 *
 *   We treat the following as the structural shape:
 *     - codepoint length is in the persona range (12..120), AND
 *     - is not a question (no cross-script `?`), AND
 *     - is a single clause (no clause separator that would mark it as a
 *       decision), AND
 *     - carries enough lexical density: either two whitespace-separated
 *       runs of letters, OR a continuous Unicode-letter run of ≥6
 *       codepoints (a fallback for scripts without word spaces — Japanese,
 *       Chinese, Thai).
 *
 *   The renderer prints the raw message back to the next LLM verbatim,
 *   so the gate only needs a coarse "looks like a persona statement"
 *   filter — no per-language keyword list.
 */

// Lower bound accommodates information-dense scripts (Chinese, Japanese,
// Korean) where a complete persona sentence may use as few as 8 codepoints
// — e.g. "你是高级工程师" — while still excluding bare single-token noise.
const ROLE_MIN_CHARS = 8;
const ROLE_MAX_CHARS = 120;
const TWO_LEXICAL_TOKENS_PATTERN = /\p{L}+\s+\p{L}+/u;
const CONTINUOUS_LETTER_RUN_PATTERN = /\p{L}{6,}/u;

// Issue #856 — persona / standing-directive cue gate.
//
// The structural test below ("two lexical tokens OR a 6-codepoint letter run,
// 8..120 chars, no '?', no clause separator") is intentionally coarse and
// matches ANY short declarative sentence. That let casual conversational
// acknowledgements ("that's fine for now", "go with the second option") freeze
// as a priority-3 `role`, which the Pi adapter then re-injected as a standing
// behavioral_directive every turn → do-nothing loop.
//
// A genuine role/behavioral prompt always LEADS with a persona declaration
// ("You are X", "Tu es X", "あなたは…", "你是…") or a standing-directive verb
// ("always respond…", "act as…"). Casual phrases never do, so we require that
// cue as a NECESSARY condition. This preserves legitimate role persistence
// (issue #535 multilingual corpus) while killing the casual-phrase loop.
//
// ALGORITHMIC ONLY — pure lowercase + prefix membership, no regex (project
// hard rule). Multilingual openers are matched by `startsWith` on the
// normalized first clause; leading conversational filler tokens are stripped
// by array operations before the check.
const ROLE_FILLER_TOKENS = new Set([
  "ok", "okay", "sure", "yeah", "yep", "yup", "alright", "fine",
  "well", "so", "hmm", "right", "please",
]);

// Second-person persona openers across the supported-language corpus
// (issue #535 multilingual role test set) plus common English persona framings.
const ROLE_PERSONA_PREFIXES = [
  "you are", "you're", "your role", "you will be", "you act", "you will act",
  "act as", "act like", "behave as", "behave like", "imagine you", "pretend you",
  "assume the role", "take the role", "play the role", "respond as",
  "tu es", "tu est", "vous etes", "vous êtes", // French
  "sen ", "siz ", // Turkish (Sen kıdemli…)
  "eres ", "tú eres", "usted es", // Spanish (Eres…)
  "ты ", "вы ", // Russian (Ты опытный…)
  "あなたは", "君は", "お前は", "あなたが", // Japanese (あなたは…)
  "你是", "您是", // Chinese (你是…)
  "तुम ", "आप ", "तू ", // Hindi (तुम…)
  "أنت ", "انت ", "أنتَ ", // Arabic (أنت…)
];

// Standing-directive verb openers — imperative behavioral rules that should
// persist ("always respond in TypeScript", "never use emojis").
const ROLE_DIRECTIVE_PREFIXES = [
  "always ", "never ", "respond ", "reply ", "answer ", "speak ",
  "write ", "prefer ", "format ", "output ", "communicate ", "use only ",
];

function hasRoleCue(firstClause: string): boolean {
  const lower = firstClause.toLowerCase().trim();
  if (!lower) return false;
  // Strip leading conversational filler tokens via array ops (no regex).
  const tokens = lower.split(" ").filter((t) => t.length > 0);
  while (tokens.length > 0 && ROLE_FILLER_TOKENS.has(tokens[0])) {
    tokens.shift();
  }
  const normalized = tokens.join(" ");
  if (!normalized) return false;
  for (const prefix of ROLE_PERSONA_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  for (const prefix of ROLE_DIRECTIVE_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return false;
}

function looksLikeRole(trimmed: string): boolean {
  // Role prompts are persona-prefix shaped: the FIRST SENTENCE declares the
  // role (e.g. "You are a senior backend engineer. <long context...>").
  // Apply the structural test to the first clause only — real-world role
  // prompts often append context paragraphs that would blow the length cap
  // if we tested the whole message. First-clause shape is the load-bearing
  // signal across languages (English "You are X.", French "Tu es X.",
  // Japanese "あなたは X です。" all parse the same way under a period split).
  const firstClause = trimmed.split(/[.!\n。！]/u)[0].trim();
  if (QUESTION_MARK_PATTERN.test(firstClause)) return false;
  if (CLAUSE_SEPARATOR_PATTERN.test(firstClause)) return false;
  if (!ALPHABETIC_PATTERN.test(firstClause)) return false;
  const codepointLength = [...firstClause].length;
  if (codepointLength < ROLE_MIN_CHARS || codepointLength > ROLE_MAX_CHARS) return false;
  // Issue #856 — require a persona / standing-directive cue so casual
  // conversational acknowledgements do not freeze as a role directive.
  if (!hasRoleCue(firstClause)) return false;
  return (
    TWO_LEXICAL_TOKENS_PATTERN.test(firstClause) ||
    CONTINUOUS_LETTER_RUN_PATTERN.test(firstClause)
  );
}

function extractRole(message: string): SessionEvent[] {
  const trimmed = message.trim();
  if (!looksLikeRole(trimmed)) return [];

  return [{
    type: "role",
    category: "role",
    data: safeString(message),
    priority: 3,
  }];
}

/**
 * Category 13: intent
 * Session mode classification from user messages.
 *
 * Universal-rule detector (Hybrid C, issue #535):
 *   investigate — message contains a question mark from any script:
 *                 ASCII `?` U+003F, fullwidth `？` U+FF1F, Arabic `؟` U+061F,
 *                 Spanish opening `¿` U+00BF.
 *                 (Greek `;` U+037E and Armenian `՞` U+055E are excluded —
 *                  Greek shares its codepoint with ASCII semicolon, which
 *                  would produce false positives across the corpus.)
 *
 * Structural / Unicode-aware — no per-language keyword list.
 */

const QUESTION_MARK_PATTERN = /[?？؟¿]/u;

/**
 * "Imperative tone" structural heuristic for implement intent:
 *   - trimmed length < IMPERATIVE_MAX_CHARS codepoints (short directive,
 *     not a discursive paragraph)
 *   - contains no question mark from any script
 *   - contains at least one alphabetic codepoint (filters pure punctuation noise)
 *
 * `[...str]` walks Unicode codepoints so CJK / Indic scripts are measured
 * fairly against the budget rather than penalised by UTF-16 unit count.
 */
const ALPHABETIC_PATTERN = /\p{L}/u;
const IMPERATIVE_MAX_CHARS = 60;

function isImperativeTone(trimmed: string): boolean {
  if (QUESTION_MARK_PATTERN.test(trimmed)) return false;
  if (!ALPHABETIC_PATTERN.test(trimmed)) return false;
  const codepointLength = [...trimmed].length;
  return codepointLength > 0 && codepointLength < IMPERATIVE_MAX_CHARS;
}

function extractIntent(message: string): SessionEvent[] {
  const trimmed = message.trim();
  if (!trimmed) return [];

  let mode: string | undefined;

  if (QUESTION_MARK_PATTERN.test(trimmed)) {
    mode = "investigate";
  } else if (isImperativeTone(trimmed)) {
    mode = "implement";
  }

  if (!mode) return [];

  return [{
    type: "intent",
    category: "intent",
    data: safeString(mode),
    priority: 4,
  }];
}

/**
 * Category: session goal (objective).
 *
 * Captures the user's stated objective so it survives compaction and resume —
 * unlike `intent`, which stores only the coarse mode (investigate/implement)
 * and discards the goal text. Triggered by the `/goal <text>` command or an
 * explicit `goal:` / `objective:` marker, so the FULL goal text is preserved
 * (priority 4 = critical in the DB eviction contract) and restored at the top
 * of the resume snapshot.
 * Without this, a `/goal` directive is lost across compaction/resume.
 */
const GOAL_DIRECTIVE_PATTERN =
  /^(?:\/goal\s+|(?:goal|objective)\s*:\s*)(.+)$/is;

function extractGoal(message: string): SessionEvent[] {
  const trimmed = message.trim();
  if (!trimmed) return [];
  const match = trimmed.match(GOAL_DIRECTIVE_PATTERN);
  if (!match) return [];
  const goalText = match[1].trim();
  if (!goalText) return [];
  return [{
    type: "goal",
    category: "goal",
    data: safeString(goalText),
    priority: 4,
  }];
}

/**
 * Category 25: blocked-on
 * Detect when work is blocked on something, or when a blocker is resolved.
 *
 * Universal-rule detector (Hybrid C, issue #535):
 *   Programming-domain error markers are script-agnostic — they are
 *   emitted by tooling regardless of the user's spoken language. The
 *   words "Error", "Exception", "Traceback" stay in their original
 *   English form inside a Chinese / Arabic / Russian terminal log.
 *
 *   blocker matches:
 *     - the literal "Error:" / "Exception:" / "Traceback" tokens, OR
 *     - a Python-style frame line ("File ", `line:col`), OR
 *     - a JS / Java-style stack frame ("at <ident>(...)" with a
 *       `:line:col` suffix).
 *
 *   blocker_resolved matches:
 *     - a Unicode check-mark glyph (✓ U+2713, ✔ U+2714, ✅ U+2705,
 *       ☑ U+2611, 🎉 U+1F389), OR
 *     - the structural marker "fixed: …" / "resolved: …" — these are
 *       programming-domain conventions (git log, PR titles, CHANGELOG
 *       entries) rather than natural-language phrases.
 */

const BLOCKER_MARKERS_PATTERN = /(?:\bError\s*:|\bException\s*:|\bTraceback\b|\bat\s+\S+\s*\([^)]*:\d+:\d+\))/u;
const BLOCKER_RESOLVED_CHECKMARK_PATTERN = /[✓✔✅☑🎉]/u;
const BLOCKER_RESOLVED_MARKER_PATTERN = /^\s*(?:fixed|resolved)\s*:/iu;

function extractBlocker(message: string): SessionEvent[] {
  const events: SessionEvent[] = [];

  // Resolution takes precedence — if both shapes match, render the
  // happier signal so the snapshot reflects the latest state.
  const isResolved =
    BLOCKER_RESOLVED_CHECKMARK_PATTERN.test(message) ||
    BLOCKER_RESOLVED_MARKER_PATTERN.test(message);
  if (isResolved) {
    events.push({
      type: "blocker_resolved",
      category: "blocked-on",
      data: safeString(message),
      priority: 2,
    });
    return events;
  }

  if (BLOCKER_MARKERS_PATTERN.test(message)) {
    events.push({
      type: "blocker",
      category: "blocked-on",
      data: safeString(message),
      priority: 2,
    });
  }

  return events;
}

/**
 * Category 12: data
 * Large user-pasted data references (message > 1KB).
 */
function extractData(message: string): SessionEvent[] {
  if (message.length <= 1024) return [];

  return [{
    type: "data",
    category: "data",
    data: safeString(message),
    priority: 4,
  }];
}

/**
 * Extract session events from a UserPromptSubmit hook input (user message text).
 *
 * Handles: decision, role, intent, data categories.
 * Returns an array of zero or more SessionEvents. Never throws.
 */
export function extractUserEvents(message: string): SessionEvent[] {
  try {
    const events: SessionEvent[] = [];

    events.push(...extractUserPlan(message));
    events.push(...extractUserDecision(message));
    events.push(...extractRole(message));
    events.push(...extractIntent(message));
    events.push(...extractGoal(message));
    events.push(...extractBlocker(message));
    events.push(...extractData(message));

    return events;
  } catch {
    return [];
  }
}

/**
 * §11 Layer 1 + Layer 3 — multilingual prompt features.
 *
 * Reference: context-mode-platform/docs/prds/2026-06-insight-data-flow/
 *   11-multilingual-prompt-algorithm.md
 *
 * Script-agnostic via Unicode property regex (`\p{L}`, `\p{Lu}`,
 * `\p{Script=X}`). No per-language tables, no franc/fasttext deps.
 * Layer 1 returns 10 numeric/string features; Layer 3 appends a
 * `prompt_word_tokens: string[]` array for the platform's streaming
 * word-frequency UPSERT.
 *
 * Privacy: features carry no prose. Layer 3 tokens are deduped
 * letter-only words ≥3 chars; platform aggregates by (org_id, week,
 * word) so no individual token surfaces in UI.
 */
export interface PromptFeatures {
  prompt_length: number;
  prompt_word_count: number;
  prompt_uppercase_ratio: number;
  prompt_file_ref_count: number;
  prompt_path_ref_count: number;
  prompt_script_primary: string | null;
  prompt_script_count: number;
  prompt_question_glyph_count: number;
  prompt_code_block_count: number;
  prompt_url_count: number;
  prompt_word_tokens: string[];
}

const PROMPT_SCRIPT_NAMES = [
  "Latin", "Cyrillic", "Arabic", "Han", "Hangul",
  "Hiragana", "Katakana", "Devanagari", "Hebrew", "Thai", "Greek",
] as const;

const EMPTY_PROMPT_FEATURES: PromptFeatures = {
  prompt_length: 0,
  prompt_word_count: 0,
  prompt_uppercase_ratio: 0,
  prompt_file_ref_count: 0,
  prompt_path_ref_count: 0,
  prompt_script_primary: null,
  prompt_script_count: 0,
  prompt_question_glyph_count: 0,
  prompt_code_block_count: 0,
  prompt_url_count: 0,
  prompt_word_tokens: [],
};

/**
 * Verbatim mirror of §11 Layer 1 reference implementation + Layer 3
 * token extraction. Uses Unicode property regex per the spec — the
 * "no regex" project default does NOT apply here because the spec
 * explicitly mandates `\p{Script=X}` for script-agnostic classification.
 */
export function extractUserPromptFeatures(prompt: unknown): PromptFeatures {
  if (typeof prompt !== "string" || prompt.length === 0) {
    return { ...EMPTY_PROMPT_FEATURES, prompt_word_tokens: [] };
  }

  const letters = prompt.match(/\p{L}+/gu) ?? [];
  const upperCount = (prompt.match(/\p{Lu}/gu) ?? []).length;
  const totalLetters = letters.join("").length;
  const fences = (prompt.match(/```/g) ?? []).length;

  const scripts: Record<string, number> = {};
  for (const name of PROMPT_SCRIPT_NAMES) {
    const re = new RegExp(`\\p{Script=${name}}`, "gu");
    const n = (prompt.match(re) ?? []).length;
    if (n > 0) scripts[name] = n;
  }
  const primary =
    Object.entries(scripts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const word of letters) {
    if (word.length < 3) continue;
    const lower = word.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    tokens.push(lower);
  }

  return {
    prompt_length: prompt.length,
    prompt_word_count: letters.length,
    prompt_uppercase_ratio: totalLetters === 0 ? 0 : upperCount / totalLetters,
    prompt_file_ref_count: (prompt.match(/(\w+\/)+\w+\.\w+/g) ?? []).length,
    prompt_path_ref_count: (prompt.match(/\.{0,2}\/[\w\/.-]+/g) ?? []).length,
    prompt_script_primary: primary,
    prompt_script_count: Object.keys(scripts).length,
    prompt_question_glyph_count: (prompt.match(/[?？؟]/gu) ?? []).length,
    prompt_code_block_count: Math.floor(fences / 2),
    prompt_url_count: (prompt.match(/https?:\/\/[^\s]+/gu) ?? []).length,
    prompt_word_tokens: tokens,
  };
}

/**
 * UserPromptSubmit-driven `/plan` slash detector.
 *
 * Compensates for Claude Code Bug #15660: programmatic EnterPlanMode tool
 * calls fire PostToolUse, but the `/plan` slash command and Shift+Tab do
 * NOT. Shift+Tab is unrecoverable from the OSS bridge without an upstream
 * SDK change; this detector handles the slash case.
 *
 * Algorithmic (no regex): tolerate leading whitespace, require lowercase
 * "/plan", reject longer slashes like "/plans" via the next-char check.
 */
function extractUserPlan(message: string): SessionEvent[] {
  if (typeof message !== "string" || message.length === 0) return [];

  let i = 0;
  while (i < message.length) {
    const c = message.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }

  if (i + 5 > message.length) return [];
  if (message.slice(i, i + 5) !== "/plan") return [];

  if (i + 5 < message.length) {
    const next = message.charCodeAt(i + 5);
    const isWordBoundary =
      next === 32 || next === 9 || next === 10 || next === 13;
    if (!isWordBoundary) return [];
  }

  const arg = message.slice(i + 5).trim();
  const detail = arg.length > 0
    ? `plan via /plan slash: ${arg.slice(0, 120)}`
    : "plan via /plan slash";

  return [{
    type: "plan_enter",
    category: "plan",
    data: safeString(detail),
    priority: 2,
  }];
}
