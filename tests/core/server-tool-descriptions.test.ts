/** Server regressions: tool-descriptions. */

import { readServerSource } from "../helpers/server-source.js";


import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";



const __dirname = dirname(fileURLToPath(import.meta.url));


// ─────────────────────────────────────────────────────────────────────────────
// Tool description style contract (#683 ADR-0002)
// ─────────────────────────────────────────────────────────────────────────────
//
// Static contract test that scans every server.registerTool() block in
// src/server.ts and asserts the tool description meets the style policy
// codified in docs/adr/0002-tool-description-style.md.
//
// Motivation: PR #654 surfaced that a single hortatory word ("blocked") in a
// routing deny reason was misread by Opus 4.6 as a network restriction,
// causing capitulation to training data instead of routing. The same drift
// has accumulated organically in tool descriptions (MANDATORY:, PREFER X
// OVER Y, NEVER, Do NOT, ✅/❌). This test is the regression guard.
//
// Per CONTRIBUTING.md "Test file organization", we fold the contract into
// tests/core/server.test.ts rather than creating tests/server/*.test.ts.
//
// Exemptions: ctx_stats, ctx_doctor, ctx_insight have minimal one-line
// descriptions by design — they are GUI/diagnostic affordances, not routing
// targets, so the WHEN: structural requirement does not apply.
describe("tool description style contract (#683 ADR-0002)", () => {
  const serverTsPath = resolve(__dirname, "../../src/server.ts");
  const serverTs = readServerSource();

  // Extract every registered tool with its description string.
  // Description is a template literal or "+"-concatenated string literal
  // sitting on the `description:` key inside the registerTool config object.
  function extractToolDescriptions(): Array<{ name: string; description: string; lineNo: number }> {
    const out: Array<{ name: string; description: string; lineNo: number }> = [];
    const lines = serverTs.split("\n");
    const RE_REGISTER = /server\.registerTool\(\s*$/;
    const RE_NAME = /^\s*"(ctx_[a-z_]+)"\s*,\s*$/;
    for (let i = 0; i < lines.length; i++) {
      if (!RE_REGISTER.test(lines[i])) continue;
      const nameMatch = lines[i + 1]?.match(RE_NAME);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      // Description block starts at first `description:` after the name.
      // Capture until the next `inputSchema:` line at the same indentation.
      let descStart = -1;
      let descEnd = -1;
      for (let j = i + 2; j < Math.min(i + 80, lines.length); j++) {
        if (descStart < 0 && /^\s*description:/.test(lines[j])) {
          descStart = j;
        } else if (descStart >= 0 && /^\s*(inputSchema|outputSchema|annotations):/.test(lines[j])) {
          descEnd = j;
          break;
        }
      }
      if (descStart < 0 || descEnd < 0) continue;
      const block = lines.slice(descStart, descEnd).join("\n");
      // Strip the leading `description: ` and trailing comma.
      // The literal text the LLM sees is just the string content — for the
      // contract we work on the source-form block (template-literal/concat
      // syntax), which is sufficient to detect forbidden tokens like
      // `MANDATORY:` or `PREFER`. We do NOT execute the template here.
      out.push({ name, description: block, lineNo: descStart + 1 });
    }
    return out;
  }

  const tools = extractToolDescriptions();

  // Tools exempt from the WHEN: structural requirement, with documented
  // rationale per the audit (see TOOL-DESCRIPTIONS-AUDIT.md §3 table).
  //
  // - ctx_stats / ctx_doctor / ctx_insight: minimal one-line descriptions by
  //   design — diagnostic/GUI affordances, not routing targets. Audit row:
  //   "NIT — Clean, minimal, no change."
  // - ctx_upgrade: MUST is appropriate here (post-call obligation on the
  //   agent to run the returned shell command). Audit row: "LOW — MUST is
  //   appropriate here (post-call obligation), good use case. No change."
  const EXEMPT_FROM_WHEN = new Set([
    "ctx_stats",
    "ctx_doctor",
    "ctx_insight",
    "ctx_upgrade",
  ]);

  // ctx_purge carve-out — the rewrite (PR #683 WS2) preserves the
  // user-facing DESTRUCTIVE signal because Probe 4 empirically showed that
  // soft framing regresses parameter fidelity on Haiku (5/5 → 3/5). The
  // word "DESTRUCTIVE" is therefore an accurate-signaling carve-out,
  // distinct from cross-LLM-bias negative framing the rubric forbids.
  // ADR-0002 §Exemptions documents this; the WHEN/WHEN NOT/SCOPES/
  // CONTRACT/RETURNS/EXAMPLE structure of the rewritten description still
  // meets the canonical contract enforced below.
  const EXEMPT_FROM_FORBIDDEN_TOKENS = new Set<string>([]);

  test("at least 11 ctx_* tools are registered", () => {
    // Sanity check that the extractor found the corpus.
    expect(tools.length).toBeGreaterThanOrEqual(11);
  });

  // Forbidden tokens per ADR-0002. Each pattern is documented inline so
  // a future contributor reading a failure understands the rationale, not
  // just the regex.
  type ForbiddenRule = { name: string; pattern: RegExp; rationale: string };
  const FORBIDDEN: ForbiddenRule[] = [
    {
      name: "SESSION STATE clause",
      // Rubric #3 + GRILL-Q1-VERDICT: tool descriptions are selection cues,
      // not in-context prompts. Skill/role/decision persistence belongs in
      // routing-block.mjs (which already covers it more thoroughly).
      pattern: /\bSESSION STATE\b/,
      rationale: "Move SESSION STATE guidance to routing-block.mjs (it already lives there).",
    },
    {
      name: "BLOCKED",
      // ADR-0003: 'blocked' is reserved for CASE B (real policy restriction)
      // in routing.mjs deny reasons. It MUST NOT appear in any ctx_* tool
      // description, where there is no security restriction to express.
      pattern: /\bBLOCKED\b/,
      rationale: "Reserve 'blocked' for routing CASE B (security policy denial) per ADR-0003.",
    },
    {
      name: "MANDATORY: opener",
      // Rubric #7: MANDATORY in a tool description reads as a developer
      // policy note rather than a tool-selection cue. Replace with WHEN:.
      pattern: /\bMANDATORY:/,
      rationale: "Replace 'MANDATORY:' opener with role definition + WHEN: section.",
    },
    {
      name: "PREFER X OVER Y",
      // Rubric #7: 'PREFER' is the wrong strength and frames the choice as
      // a tradeoff. WHEN:/WHEN NOT: sections give the agent positive cues.
      pattern: /\bPREFER\s+THIS\s+OVER\b/,
      rationale: "Replace 'PREFER THIS OVER X' with positive WHEN: clauses.",
    },
    {
      name: "Do NOT (descriptive)",
      // Rubric #2 + #7: affirmative beats negative. 'Do NOT' inside the
      // description is voice-of-trainer; routing-block.mjs is the right
      // layer for prohibitions.
      pattern: /\bDo NOT\s+(?:read|use|pull|call)\b/,
      rationale: "Rewrite 'Do NOT read/use/pull' as positive WHEN: / WHEN NOT: clauses.",
    },
    {
      name: "Never use (capitalised imperative)",
      // Rubric #7: 'Never' as a soft imperative inside a description is
      // a forbidding voice; sibling-tool selection should be expressed
      // through WHEN NOT: structure instead.
      pattern: /\bNever\s+use\b/,
      rationale: "Rewrite 'Never use' as positive WHEN NOT: clause.",
    },
    {
      name: "checkmark emoji ✅",
      // Rubric #4 + Probe 3 evidence: emoji tokenize inconsistently across
      // LLM families (Llama, Gemini) and ❌ bullets are precisely the
      // negative-example leakage pattern.
      pattern: /✅/,
      rationale: "Replace ✅ bullets with prose 'USE concurrency 4-8 for ...' (ADR-0002).",
    },
    {
      name: "cross emoji ❌",
      pattern: /❌/,
      rationale: "Replace ❌ bullets with prose 'KEEP concurrency 1 for ...' (ADR-0002).",
    },
  ];

  // ── Canonical structure (ADR-0002 amendment, PR #683 WS3) ────────────
  //
  // Every non-exempt ctx_* tool description MUST follow the canonical
  // structure documented in ADR-0002:
  //
  //   <1-line headline>
  //   WHEN:        (mandatory — positive selection cues, bulleted with `- `)
  //   WHEN NOT:    (optional — sibling-tool disambiguation, bulleted)
  //   RETURNS:     (mandatory — what the agent gets back)
  //   EXAMPLE:     (mandatory — one canonical call)
  //
  // Rules:
  //   1. Section order MUST be WHEN -> WHEN NOT -> RETURNS -> EXAMPLE
  //      (positive cues precede negative disambiguation, per audit rubric #2).
  //   2. Bullets MUST use markdown `- ` only. `1.`, `1-`, `* `, and `•` are
  //      rejected because they tokenize inconsistently across LLM families
  //      and break the audit's bullet-uniformity contract.
  //   3. Section headers MUST be UPPERCASE + colon at the start of a line
  //      (after the `\n` escape in source form).
  //   4. ctx_purge has an audit-approved carve-out for DESTRUCTIVE / SCOPES /
  //      CONTRACT headers (accurate-signaling and parameter-fidelity
  //      requirements that Probe 4 empirically validated). All four headers
  //      coexist with the canonical WHEN/WHEN NOT/RETURNS/EXAMPLE.
  //
  // Helper: flatten the source-form description into the literal text the
  // LLM eventually sees (collapse `\n` escapes, join `"..." + "..."` concat,
  // strip template-literal backticks). This is the same shape the host LLM
  // receives at tool-selection time.
  function flattenDescription(d: string): string {
    return d
      .replace(/^\s*description:\s*/, "")
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/"\s*\+\s*\n\s*"/g, "")
      .replace(/"\s*\+\s*"/g, "")
      .replace(/^"|"$/gm, "")
      .replace(/`/g, "");
  }

  // Per-tool carve-outs that allow non-canonical UPPERCASE: section headers.
  // Each entry is justified inline so a future contributor reading a failure
  // understands why the carve-out exists.
  const ALLOWED_EXTRA_SECTIONS: Record<string, string[]> = {
    // ctx_purge: heavy framing is empirically validated by Probe 4. The
    // DESTRUCTIVE prefix preserves accurate user-facing signaling and
    // SCOPES/CONTRACT preserve parameter-fidelity discipline on Haiku.
    ctx_purge: ["DESTRUCTIVE", "SCOPES", "CONTRACT"],
  };

  // Canonical mandatory + optional sections.
  const CANONICAL_ORDER = ["WHEN", "WHEN NOT", "RETURNS", "EXAMPLE"] as const;
  const MANDATORY = ["WHEN", "RETURNS", "EXAMPLE"] as const;

  // Bullet patterns the contract rejects in routing-target descriptions.
  const BAD_BULLETS = [
    { name: "numeric-dot bullet (e.g. '1.')", pattern: /^\s*\d+\.\s/m },
    { name: "numeric-dash bullet (e.g. '1-')", pattern: /^\s*\d+-\s/m },
    { name: "asterisk bullet (e.g. '* foo')", pattern: /^\s*\*\s/m },
    { name: "unicode bullet (e.g. '• foo')", pattern: /^\s*•\s/m },
  ];

  for (const tool of tools) {
    // Tools exempt from BOTH groups have no assertions to make — emit a
    // placeholder test so vitest doesn't error on empty describe blocks.
    const isFullyExempt =
      EXEMPT_FROM_FORBIDDEN_TOKENS.has(tool.name) && EXEMPT_FROM_WHEN.has(tool.name);
    describe(tool.name, () => {
      if (isFullyExempt) {
        test("deferred to follow-up PR (see EXEMPT_FROM_FORBIDDEN_TOKENS rationale)", () => {
          expect(EXEMPT_FROM_FORBIDDEN_TOKENS.has(tool.name)).toBe(true);
        });
        return;
      }
      if (!EXEMPT_FROM_FORBIDDEN_TOKENS.has(tool.name)) {
        for (const rule of FORBIDDEN) {
          test(`MUST NOT contain '${rule.name}'`, () => {
            const match = tool.description.match(rule.pattern);
            if (match) {
              throw new Error(
                `${tool.name} description (src/server.ts:${tool.lineNo}) contains forbidden token '${match[0]}' ` +
                `(rule: ${rule.name}). ${rule.rationale}`,
              );
            }
          });
        }
      }

      if (!EXEMPT_FROM_WHEN.has(tool.name)) {
        test("MUST contain a WHEN: section (or WHEN TO USE: legacy)", () => {
          // Per ADR-0002: every routing-target ctx_* tool MUST have a
          // positive selection cue. The legacy alias `WHEN TO USE:` is
          // accepted because ctx_index already uses it and rewriting that
          // header is out of scope for this PR (audit MEDIUM, separate work).
          //
          // We can't use `\bWHEN` because in source-form descriptions the
          // preceding token is often the literal two-char sequence `\n`
          // (from the JS escape) — `n` is a word character so `\b` fails.
          // Likewise, for `+ "WHEN:..."` concat style the preceding char is
          // `"`. Match any of those legitimate prefixes explicitly so both
          // template-literal and string-concat description shapes pass.
          const hasWhen = /(?:\\n|^|\s|")WHEN(?:\s+TO\s+USE)?:/.test(tool.description);
          expect(hasWhen, `${tool.name} description (src/server.ts:${tool.lineNo}) must contain a WHEN: section`).toBe(true);
        });

        // ── Canonical structure assertions (PR #683 WS3) ─────────────
        const flat = flattenDescription(tool.description);

        test("MUST contain RETURNS: and EXAMPLE: sections (canonical structure)", () => {
          for (const section of MANDATORY) {
            expect(
              flat.includes(section + ":"),
              `${tool.name} (src/server.ts:${tool.lineNo}) missing mandatory section '${section}:' per ADR-0002 canonical structure.`,
            ).toBe(true);
          }
        });

        test("section order MUST be WHEN -> WHEN NOT -> RETURNS -> EXAMPLE", () => {
          // For each canonical section present, its position in the flattened
          // description must be strictly greater than the previous canonical
          // section's position. Carve-out headers (DESTRUCTIVE, SCOPES,
          // CONTRACT for ctx_purge) are allowed between canonical sections
          // — only the relative order of the canonical four is enforced.
          let lastPos = -1;
          for (const section of CANONICAL_ORDER) {
            const pos = flat.indexOf(section + ":");
            if (pos < 0) continue;
            expect(
              pos,
              `${tool.name} (src/server.ts:${tool.lineNo}) section '${section}:' appears before a sibling that should follow it (positions: ${CANONICAL_ORDER.map(s => `${s}=${flat.indexOf(s + ":")}`).join(", ")}). Canonical order: WHEN -> WHEN NOT -> RETURNS -> EXAMPLE.`,
            ).toBeGreaterThan(lastPos);
            lastPos = pos;
          }
        });

        test("section headers MUST be UPPERCASE + colon (no off-spec UPPERCASE sections)", () => {
          // Extract every UPPERCASE-header occurrence (two or more uppercase
          // chars, optional space, then colon at line start). Reject any
          // that aren't in the canonical set or the per-tool carve-out.
          const headerMatches = [...flat.matchAll(/^([A-Z][A-Z _]+):/gm)].map(m => m[1]);
          const allowed = new Set<string>([...CANONICAL_ORDER, ...(ALLOWED_EXTRA_SECTIONS[tool.name] ?? [])]);
          const offSpec = [...new Set(headerMatches.filter(h => !allowed.has(h)))];
          expect(
            offSpec,
            `${tool.name} (src/server.ts:${tool.lineNo}) uses off-spec UPPERCASE sections [${offSpec.join(", ")}]. ` +
            `Allowed: [${[...allowed].join(", ")}]. Fold operational sub-guidance (CONCURRENCY, TIPS, ...) into WHEN: / RETURNS: prose.`,
          ).toEqual([]);
        });

        test("bullets MUST use '- ' markdown only (no '1.', '1-', '* ', or '•')", () => {
          // Scan the flattened description. The rubric requires uniform
          // markdown bullets so the host LLM tokenizes them consistently
          // across Claude / GPT / Gemini / Llama. Numbered ordering inside
          // a routing-target description is also discouraged because each
          // bullet should be independently true, not sequenced.
          const failures: string[] = [];
          for (const rule of BAD_BULLETS) {
            const m = flat.match(rule.pattern);
            if (m) {
              const lineNo = flat.slice(0, flat.indexOf(m[0])).split("\n").length;
              failures.push(`${rule.name} at description-line ${lineNo}: '${m[0].trim()}'`);
            }
          }
          expect(
            failures,
            `${tool.name} (src/server.ts:${tool.lineNo}) bullet uniformity violation: ${failures.join("; ")}. ` +
            `Use markdown '- ' bullets only (ADR-0002 §Canonical structure).`,
          ).toEqual([]);
        });

        // ── PR #683 second amendment (Mert flag): RETURNS form uniformity ──
        //
        // ADR-0002 L56-57 specifies RETURNS as a header on its own line with
        // the body on the next line indented (matching WHEN: / WHEN NOT:
        // shape). Three tools (ctx_execute, ctx_execute_file, ctx_purge)
        // historically used inline form ("RETURNS: only your printed output.")
        // while four tools (ctx_index, ctx_search, ctx_fetch_and_index,
        // ctx_batch_execute) used the canonical header+body form. Mert flagged
        // the visual inconsistency on review. This guard locks the canonical
        // form so the regression can't slip back.
        //
        // EXAMPLE: stays inline per ADR-0002 L59 ("EXAMPLE: <one canonical
        // call>"). The asymmetry is intentional — RETURNS prose is multi-line
        // capable, EXAMPLE values are one-call-per-line.
        test("RETURNS: header MUST be on its own line, body indented below (ADR-0002 L56-57)", () => {
          // Match RETURNS: followed by anything other than \n on the same
          // line (treating \\n source escape as the same boundary as a real
          // newline). Inline form like "RETURNS: only your printed output."
          // fails; header+body form like "RETURNS:\n  Only your printed
          // output." passes.
          //
          // Source descriptions live either as template literals with real
          // newlines OR as `+ "...\n"` concat strings with escape sequences.
          // Match both shapes via a non-newline-non-backslash assertion.
          const inlineRe = /RETURNS:[ \t]+[^\n\\]/;
          const m = tool.description.match(inlineRe);
          expect(
            m,
            m
              ? `${tool.name} (src/server.ts:${tool.lineNo}) uses inline RETURNS form: '${m[0]}…'. ` +
                `ADR-0002 L56-57 requires header on its own line with body indented below. ` +
                `Rewrite as 'RETURNS:\\n  <body>'.`
              : "RETURNS: header on own line.",
          ).toBeNull();
        });
      }
    });
  }
});


// ──────────────────────────────────────────────────────────────────────────
// PR #683 follow-up (Mert flag, 2026-05-24): tool description source-form
// uniformity — embedded `\n\n` escapes in template literals
//
// ctx_execute was the lone ctx_* tool whose description used a template
// literal with embedded `\n\n` escape sequences inline (compact but
// escape-heavy and harder to scan). Every other multi-section ctx_*
// description used `"..." + "...\n\n"` concat-form. Both render identically
// to the host LLM — the bytes are the same `\n\n` separators — but the
// source form was inconsistent.
//
// Canonical decision (ADR-0002 follow-up): template literal with REAL
// newlines. Source mirrors the rendered prompt. Zero escape sequences.
// Markdown-friendly when read in an editor. The contract test below locks
// the decision so a future contributor can't slip back to either of the
// rejected forms (embedded `\n\n` escapes OR multi-line string concat).
// ──────────────────────────────────────────────────────────────────────────
describe("tool description source form contract (#683 PR follow-up)", () => {
  const serverTsPath = resolve(__dirname, "../../src/server.ts");
  const serverTs = readServerSource();

  // Locate every `description: ...,` block under a server.registerTool() call
  // and capture its raw source text. Reuse the same anchor pattern as the
  // ADR-0002 contract test for consistency.
  function extractDescriptionBlocks(): Array<{ name: string; raw: string; lineNo: number }> {
    const out: Array<{ name: string; raw: string; lineNo: number }> = [];
    const lines = serverTs.split("\n");
    const RE_REGISTER = /server\.registerTool\(\s*$/;
    const RE_NAME = /^\s*"(ctx_[a-z_]+)"\s*,\s*$/;
    for (let i = 0; i < lines.length; i++) {
      if (!RE_REGISTER.test(lines[i])) continue;
      const nameMatch = lines[i + 1]?.match(RE_NAME);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      let descStart = -1;
      let descEnd = -1;
      for (let j = i + 2; j < Math.min(i + 80, lines.length); j++) {
        if (descStart < 0 && /^\s*description:/.test(lines[j])) {
          descStart = j;
        } else if (descStart >= 0 && /^\s*(inputSchema|outputSchema|annotations):/.test(lines[j])) {
          descEnd = j;
          break;
        }
      }
      if (descStart < 0 || descEnd < 0) continue;
      out.push({ name, raw: lines.slice(descStart, descEnd).join("\n"), lineNo: descStart + 1 });
    }
    return out;
  }

  const blocks = extractDescriptionBlocks();

  // Tools whose descriptions are intentionally one-line concats with no
  // section structure (diagnostic / GUI affordances per ADR-0002
  // §Exemptions). They carry no `\n` separators in the source at all, so
  // the embedded-escape rule is trivially satisfied and the concat-form
  // exemption applies. Future contributors can promote these to template
  // literals at will; they just aren't forced to.
  const SHORT_DESCRIPTION_EXEMPT = new Set([
    "ctx_stats",
    "ctx_doctor",
    "ctx_upgrade",
    "ctx_insight",
  ]);

  test("at least 11 ctx_* tools surfaced for source-form contract", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(11);
  });

  for (const block of blocks) {
    if (SHORT_DESCRIPTION_EXEMPT.has(block.name)) continue;

    describe(block.name, () => {
      test("source-form MUST NOT contain embedded '\\n\\n' escape (use real newlines in template literal)", () => {
        // The forbidden pattern is the literal four-character source-text
        // sequence: backslash, n, backslash, n. In source these appear inside
        // template literals (`...\n\n...`) or quoted strings ("...\n\n").
        // The canonical form is a template literal with REAL newlines so the
        // source mirrors the rendered prompt byte-for-byte without escapes.
        const hasEscapedDoubleNewline = /\\n\\n/.test(block.raw);
        expect(
          hasEscapedDoubleNewline,
          `${block.name} description (src/server.ts:${block.lineNo}) contains embedded '\\n\\n' escapes. ` +
            `Use a template literal with REAL newlines instead — source should mirror the rendered prompt. ` +
            `Diff: replace \`...\\n\\n...\` source spans with multi-line template literals.`,
        ).toBe(false);
      });

      test("source-form MUST NOT use multi-line string concat with '+' (use template literal)", () => {
        // Concat-form was the legacy alternative — `"...\n\n" + "WHEN:\n"`.
        // Once we ban `\n\n`, the only sensible multi-section shape is a
        // template literal. This second assertion makes that explicit so a
        // contributor doesn't switch one negative form for another (e.g.
        // splitting on a newline inside a `+ "\n"` chain).
        //
        // Heuristic: a `"\n" +` or `"+ \n"` chain inside the description
        // block. Single-line concats (e.g. `"a " + "b"`) are too loose to
        // ban without false positives, so we anchor on the embedded newline
        // form which is what multi-section descriptions actually used.
        const hasConcatNewline = /"[^"]*"\s*\+\s*\n\s*"/.test(block.raw) ||
          /\\n"\s*\+/.test(block.raw);
        expect(
          hasConcatNewline,
          `${block.name} description (src/server.ts:${block.lineNo}) uses multi-line string concat with '+'. ` +
            `Use a template literal with REAL newlines instead — single canonical source form for all multi-section descriptions.`,
        ).toBe(false);
      });
    });
  }
});
