/** Server regressions: routing. */


import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";



const __dirname = dirname(fileURLToPath(import.meta.url));


// ──────────────────────────────────────────────────────────────────────────
// Hook routing prompt-surface contract (#683 ADR-0002 + ADR-0003 extension)
//
// `src/server.ts` carries the MCP tool-description surface (read by host
// LLMs at tool-selection time). The hook routing layer carries TWO MORE
// agent-facing prompt surfaces that share the same cross-LLM safety bias
// concerns (rubric #9):
//
//   1. `hooks/routing-block.mjs` — system-prompt injection text shipped on
//      every SessionStart and every routing redirect. Lives in 100% of
//      sessions; higher blast radius than any single tool description.
//   2. `hooks/core/routing.mjs` — runtime deny-reason strings shown to the
//      agent when a Bash / Read / Grep / WebFetch call is intercepted.
//      ADR-0003 distinguishes:
//        - CASE A (routing redirect — alternative tool exists for
//          context-window or efficiency reasons) → MUST use "redirected"
//          opener, MUST NOT use bare "BLOCKED".
//        - CASE B (true security / policy restriction) → "blocked by
//          security policy" + matched pattern is correct and expected.
//
// This block extends the ADR-0002 forbidden-token contract above to both
// surfaces, plus enforces ADR-0003 CASE A wording requirements on every
// `action: "deny"` / redirect-emitting branch in `routing.mjs`.
//
// One contract test, three prompt surfaces. Single regression guard.
// ──────────────────────────────────────────────────────────────────────────
describe("hook routing prompt-surface contract (#683 ADR-0002 + ADR-0003)", () => {
  const routingMjsPath = resolve(__dirname, "../../hooks/core/routing.mjs");
  const routingBlockMjsPath = resolve(__dirname, "../../hooks/routing-block.mjs");
  const routingMjs = readFileSync(routingMjsPath, "utf-8");
  const routingBlockMjs = readFileSync(routingBlockMjsPath, "utf-8");

  // Forbidden tokens that apply to BOTH hook prompt surfaces. These are
  // a strict superset of the ADR-0002 ctx_* description rules above
  // because routing.mjs deny reasons and routing-block.mjs guidance run
  // as system-prompt injection — exactly the layer where Constitutional AI
  // safety priors fire most aggressively (rubric #9).
  //
  // Each pattern is documented inline so a future contributor reading a
  // failure understands the rationale, not just the regex.
  type SurfaceRule = { name: string; pattern: RegExp; rationale: string };
  const SURFACE_FORBIDDEN: SurfaceRule[] = [
    {
      name: "<forbidden_actions> XML container",
      // Rubric #9: the container name itself is a Constitutional AI
      // trigger. Anthropic-tier models are RLHF'd to handle anything
      // tagged "forbidden" with extra caution, which inverts the intent
      // (the agent should follow the directive, not refuse it).
      // Reframe positively as <when_not_to_use> or fold into the
      // affirmative hierarchy.
      pattern: /<forbidden_actions>/,
      rationale: "Rename to <when_not_to_use> or fold into positive hierarchy (rubric #2 + #9).",
    },
    {
      name: "NEVER (uppercase imperative)",
      // Rubric #2 + #7: smaller / cross-family models fixate on the
      // forbidden token (ironic process theory). Use ALWAYS / WHEN NOT
      // structure instead.
      pattern: /\bNEVER\b/,
      rationale: "Rewrite uppercase NEVER as ALWAYS / WHEN NOT / positive directive.",
    },
    {
      name: "FORBIDDEN (capital banner)",
      // Same rubric. Pure negative banner with no positive counterpart
      // is the highest-risk framing under Constitutional AI priors.
      pattern: /\bFORBIDDEN\b/,
      rationale: "Avoid 'FORBIDDEN' banner; express as positive WHEN: cues.",
    },
    {
      name: "NO X for Y bullet",
      // Rubric #2: bullet-list negatives anchor the agent's attention
      // on the prohibited action. Convert each bullet to "Use Y for X"
      // (affirmative redirect).
      pattern: /^\s*-\s*NO\s+(Bash|Read|Grep|WebFetch|ctx_)/m,
      rationale: "Convert 'NO X for Y' bullets to positive 'Use Y for X' redirects.",
    },
  ];

  test("hooks/routing-block.mjs MUST NOT contain forbidden tokens", () => {
    const failures: string[] = [];
    for (const rule of SURFACE_FORBIDDEN) {
      const m = routingBlockMjs.match(rule.pattern);
      if (m) {
        const lineNo = routingBlockMjs.slice(0, m.index ?? 0).split("\n").length;
        failures.push(
          `hooks/routing-block.mjs:${lineNo} contains forbidden token '${m[0]}' ` +
            `(rule: ${rule.name}). ${rule.rationale}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  test("hooks/core/routing.mjs MUST NOT contain forbidden tokens", () => {
    const failures: string[] = [];
    for (const rule of SURFACE_FORBIDDEN) {
      const m = routingMjs.match(rule.pattern);
      if (m) {
        const lineNo = routingMjs.slice(0, m.index ?? 0).split("\n").length;
        failures.push(
          `hooks/core/routing.mjs:${lineNo} contains forbidden token '${m[0]}' ` +
            `(rule: ${rule.name}). ${rule.rationale}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  // ── ADR-0003 enforcement on routing.mjs deny / redirect strings ──
  //
  // Mechanically: any string literal that the agent sees as a redirect
  // explanation (curl/wget, inline HTTP, build tools, WebFetch) is CASE A.
  // ADR-0003 CASE A REQUIRES:
  //   - Opens with the verb "redirected"
  //   - MUST NOT contain the bare uppercase token "BLOCKED" (reserved for
  //     CASE B — see `Blocked by security policy: …` form)
  //   - MUST name the alternative ctx_* tool the agent should use
  //
  // CASE B (security policy) strings live in the same file and use the
  // form `Blocked by security policy: matches deny pattern <pat>`. Those
  // are correct AS-IS — the test only enforces CASE A on CASE A strings.
  //
  // Detection heuristic: a string-literal segment that contains "redirected"
  // is CASE A. A string segment that contains "Blocked by security policy"
  // is CASE B (exempt). String segments are extracted naively from the
  // source by walking forward from each return statement and capturing the
  // template-literal payload up to the closing backtick — sufficient for
  // the four current call sites (L707, L738, L751, L804) and any future
  // ones a contributor adds.
  describe("ADR-0003 CASE A: routing.mjs redirect deny reasons", () => {
    type CaseAString = { lineNo: number; payload: string };

    function extractCaseAStrings(src: string): CaseAString[] {
      const lines = src.split("\n");
      const out: CaseAString[] = [];
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        // Skip comments — both single-line // and JSDoc * lines that mention
        // 'redirected' as documentation of the routing case, not as a deny
        // payload. The real CASE A payloads live inside template literals
        // assigned to `command:` or `reason:` object keys.
        const trimmed = ln.replace(/^\s+/, "");
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
        // Require BOTH "redirected" AND a template-literal backtick
        // (current shape for L707/738/751/804). CASE B strings use the
        // `Blocked by security policy: …` form and are excluded.
        if (
          /redirected/i.test(ln) &&
          /`/.test(ln) &&
          !/Blocked by security policy/.test(ln)
        ) {
          out.push({ lineNo: i + 1, payload: ln });
        }
      }
      return out;
    }

    const caseAs = extractCaseAStrings(routingMjs);

    test("at least 4 CASE A redirect strings present (sanity check on extractor)", () => {
      // Current corpus: L707 curl/wget, L738 inline HTTP, L751 build tools,
      // L804 WebFetch. If a contributor removes one, the count drops and
      // this sanity check forces the test author to revisit the extractor.
      expect(caseAs.length).toBeGreaterThanOrEqual(4);
    });

    for (const cs of caseAs) {
      describe(`hooks/core/routing.mjs:${cs.lineNo}`, () => {
        test("MUST open with the verb 'redirected' (CASE A wording — ADR-0003)", () => {
          expect(cs.payload).toMatch(/redirected/i);
        });

        test("MUST NOT contain bare uppercase BLOCKED (reserved for CASE B)", () => {
          // ADR-0003: CASE A strings MUST NOT borrow CASE B vocabulary.
          // Lowercase `block` (e.g. `blockchain`) is fine; uppercase BLOCKED
          // is the Constitutional AI trigger.
          expect(cs.payload).not.toMatch(/\bBLOCKED\b/);
        });

        test("MUST name at least one ctx_* alternative tool", () => {
          // ADR-0003 §CASE A: "MUST specify the alternative tool to use."
          // The current four sites all name ctx_execute and/or
          // ctx_fetch_and_index — we just enforce that SOMETHING ctx_*
          // is mentioned so the agent has a concrete next call.
          expect(cs.payload).toMatch(/ctx_(execute|fetch_and_index|search|batch_execute)/);
        });

        // ── PR #683 follow-up (Mert flag): negation-pattern eradication ──
        //
        // The original PR #654 fix replaced the single word "blocked" with
        // "redirected", which removed the Constitutional-AI safety trigger but
        // kept a sibling rubric #2 violation in the very next clause:
        //
        //   "(context-window optimization, NOT a network restriction)"
        //
        // The audit (TOOL-DESCRIPTIONS-AUDIT.md §2 Probe 3) measured this
        // parenthetical regressing Haiku capitulation from 0/6 → 2/6 — the
        // bare-NOT construct primes the very frame it tries to deny (ironic
        // process theory). Per ADR-0002 rubric #2 (affirmative beats negative),
        // CASE A strings MUST avoid bare-NOT negations entirely. Reframe with
        // affirmative "X has full network access" + imperative retry hint.
        test("MUST NOT contain the 'NOT a network' negation (PR #683 follow-up)", () => {
          // Matches "NOT a network restriction", "NOT a network/security
          // restriction", "is NOT a network ...", etc. Affirmative-only voice.
          expect(cs.payload).not.toMatch(/\bNOT\s+a\s+network\b/i);
        });

        test("MUST NOT contain 'Do NOT retry' negation (PR #683 follow-up)", () => {
          // Same rubric: "Do NOT retry with curl/wget" anchors attention on
          // the disallowed action. Express as the positive next step — the
          // ctx_execute / ctx_fetch_and_index call IS the next step.
          expect(cs.payload).not.toMatch(/\bDo\s+NOT\s+retry\b/i);
        });

        // ── PR #683 second amendment (Mert flag): no org-rationale preface ──
        //
        // The first amendment replaced the bare-NOT parenthetical
        // "(context-window optimization, NOT a network restriction)" with the
        // affirmative-voice opening "redirected to <ctx_tool> for context-window
        // efficiency". Mert's second-pass flag: the "for X reason" preface is
        // org-rationale, not action input. The agent's job is to (a) make the
        // correct next call, (b) know it has the capability, (c) know when to
        // retry — not to audit policy. The capability affirmation
        // "<ctx_tool> has full network access" already carries the substantive
        // signal the rationale was double-encoding. ADR-0003 §Second amendment.
        //
        // Compare HTTP 301: the response carries "Location: <new-url>" and the
        // client uses it. The server never appends "for SEO efficiency".
        test("MUST NOT contain 'for context-window efficiency' org-rationale (PR #683 second amendment)", () => {
          expect(cs.payload).not.toMatch(/\bfor\s+context-window\s+(efficiency|optimization)\b/i);
        });
      });
    }
  });
});
