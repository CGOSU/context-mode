/** Connection-free query normalization, edit distance and search scoring. */

import type { SearchResult } from "./types.js";

export const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "his", "how", "its", "may",
  "new", "now", "old", "see", "way", "who", "did", "get", "got", "let",
  "say", "she", "too", "use", "will", "with", "this", "that", "from",
  "they", "been", "have", "many", "some", "them", "than", "each", "make",
  "like", "just", "over", "such", "take", "into", "year", "your", "good",
  "could", "would", "about", "which", "their", "there", "other", "after",
  "should", "through", "also", "more", "most", "only", "very", "when",
  "what", "then", "these", "those", "being", "does", "done", "both",
  "same", "still", "while", "where", "here", "were", "much",
  // Common in code/changelogs
  "update", "updates", "updated", "deps", "dev", "tests", "test",
  "add", "added", "fix", "fixed", "run", "running", "using",
]);

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

/**
 * Remove case-insensitive duplicate tokens while preserving the first
 * occurrence's original casing. FTS5's unicode61 tokenizer lowercases on
 * both sides, so `"Error" OR "error"` produces no extra recall — just
 * redundant index lookups. Dedup keeps the compiled query minimal.
 */
function dedupeTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

export function sanitizeQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const words = dedupeTokens(
    query
      .replace(/['"(){}[\]*:^~]/g, " ")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 0 &&
          !["AND", "OR", "NOT", "NEAR"].includes(w.toUpperCase()),
      ),
  );

  if (words.length === 0) return '""';

  // Filter stopwords to improve BM25 ranking — common terms like "update",
  // "test", "fix" appear everywhere and dilute relevance scoring.
  // Fall back to unfiltered words if ALL terms are stopwords.
  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function sanitizeTrigramQuery(query: string, mode: "AND" | "OR" = "AND"): string {
  const cleaned = query.replace(/["'(){}[\]*:^~]/g, "").trim();
  if (cleaned.length < 3) return "";
  const words = dedupeTokens(
    cleaned.split(/\s+/).filter((w) => w.length >= 3),
  );
  if (words.length === 0) return "";

  const meaningful = words.filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const final = meaningful.length > 0 ? meaningful : words;

  return final.map((w) => `"${w}"`).join(mode === "OR" ? " OR " : " ");
}

export function levenshtein(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] =
        a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
    }
    prev = curr;
  }
  return prev[b.length];
}

export function maxEditDistance(wordLength: number): number {
  if (wordLength <= 4) return 1;
  if (wordLength <= 12) return 2;
  return 3;
}

// ── Proximity helpers (pure functions) ──

/** Find all positions of a term in text. */
function findAllPositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let idx = text.indexOf(term);
  while (idx !== -1) {
    positions.push(idx);
    idx = text.indexOf(term, idx + 1);
  }
  return positions;
}

/**
 * Count matched adjacent pairs across consecutive query terms.
 * For each pair (term[i], term[i+1]), pairs each left position with at most one
 * right position whose offset falls within `gap` chars of `p + len(term[i])`.
 * `positionLists` must be sorted ascending (output of `findAllPositions` is).
 * Each right position is consumed by at most one left, so `"foo foo bar"`
 * counts 1 pair, not 2 — matches IR phrase-occurrence intent and avoids
 * inflating boosts for repeated-token queries.
 * Used by reranker to layer a frequency signal on top of minSpan proximity:
 * 30-char gap covers natural prose without rewarding distant matches.
 */
function countAdjacentPairs(
  positionLists: number[][],
  terms: string[],
  gap: number = 30,
): number {
  if (positionLists.length < 2 || terms.length < 2) return 0;
  let total = 0;
  const pairs = Math.min(positionLists.length, terms.length) - 1;
  for (let i = 0; i < pairs; i++) {
    const left = positionLists[i];
    const right = positionLists[i + 1];
    const leftLen = terms[i].length;
    let j = 0;
    for (const p of left) {
      const minStart = p + leftLen;
      const maxStart = minStart + gap;
      while (j < right.length && right[j] < minStart) j++;
      if (j < right.length && right[j] <= maxStart) {
        total++;
        j++;
      }
    }
  }
  return total;
}

/**
 * Find minimum span (window) covering at least one position from each list.
 * Uses a sweep-line approach: advance the pointer at the current minimum.
 */
function findMinSpan(positionLists: number[][]): number {
  if (positionLists.length === 0) return Infinity;
  if (positionLists.length === 1) return 0;

  const sorted = positionLists;
  const ptrs = new Array(sorted.length).fill(0);
  let minSpan = Infinity;

  while (true) {
    let curMin = Infinity;
    let curMax = -Infinity;
    let minIdx = 0;

    for (let i = 0; i < sorted.length; i++) {
      const val = sorted[i][ptrs[i]];
      if (val < curMin) {
        curMin = val;
        minIdx = i;
      }
      if (val > curMax) {
        curMax = val;
      }
    }

    const span = curMax - curMin;
    if (span < minSpan) minSpan = span;

    ptrs[minIdx]++;
    if (ptrs[minIdx] >= sorted[minIdx].length) break;
  }

  return minSpan;
}

export function applyProximityReranking(
  results: SearchResult[],
  query: string,
): SearchResult[] {
  const allTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  // Exclude stopwords from proximity/title scoring — they match everywhere
  // and inflate boosts for irrelevant chunks. Keep all terms as fallback.
  const filtered = allTerms.filter((w) => !STOPWORDS.has(w));
  const terms = filtered.length > 0 ? filtered : allTerms;

  return results
    .map((r) => {
      // Title-match boost: query terms found in the chunk title get a boost.
      // Code chunks get a stronger title boost (function/class names are high
      // signal) while prose chunks get a moderate one (headings are useful but
      // body carries more weight).
      const titleLower = r.title.toLowerCase();
      const titleHits = terms.filter((t) => titleLower.includes(t)).length;
      const titleWeight = r.contentType === "code" ? 0.6 : 0.3;
      const titleBoost = titleHits > 0 ? titleWeight * (titleHits / terms.length) : 0;

      // Proximity boost for multi-term queries. minSpan picks the single
      // tightest window — frequency doesn't move it, so a long doc with one
      // tight occurrence outranks a short doc with several. Phrase-frequency
      // reward layers a saturating frequency signal on top: cap 0.5 (below
      // proximity max ≈1.0, in title-boost range), saturates at 4 hits.
      let proximityBoost = 0;
      let phraseBoost = 0;
      if (terms.length >= 2) {
        const content = r.content.toLowerCase();
        const positions = terms.map((t) => findAllPositions(content, t));

        if (!positions.some((p) => p.length === 0)) {
          const minSpan = findMinSpan(positions);
          proximityBoost = 1 / (1 + minSpan / Math.max(content.length, 1));

          const adjacentPairs = countAdjacentPairs(positions, terms);
          phraseBoost = 0.5 * Math.min(1, adjacentPairs / 4);
        }
      }

      return { result: r, boost: titleBoost + proximityBoost + phraseBoost };
    })
    .sort((a, b) => b.boost - a.boost || a.result.rank - b.result.rank)
    .map(({ result }) => result);
}


export function reciprocalRankFusion(
  porterResults: SearchResult[],
  trigramResults: SearchResult[],
  limit: number,
): SearchResult[] {
  const K = 60; // Standard RRF constant
  const scoreMap = new Map<string, { result: SearchResult; score: number }>();
  const key = (r: SearchResult) => `${r.source}::${r.title}`;

  for (const [i, r] of porterResults.entries()) {
    const k = key(r);
    const existing = scoreMap.get(k);
    if (existing) {
      existing.score += 1 / (K + i + 1);
    } else {
      scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
    }
  }

  for (const [i, r] of trigramResults.entries()) {
    const k = key(r);
    const existing = scoreMap.get(k);
    if (existing) {
      existing.score += 1 / (K + i + 1);
    } else {
      scoreMap.set(k, { result: r, score: 1 / (K + i + 1) });
    }
  }

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, rank: -score }));
}

/** Rank database-collected document frequencies without owning a connection. */
export function rankDistinctiveTerms(
  docFreq: ReadonlyMap<string, number>,
  totalChunks: number,
  maxTerms: number,
): string[] {
  const minAppearances = 2;
  const maxAppearances = Math.max(3, Math.ceil(totalChunks * 0.4));

  const filtered = Array.from(docFreq.entries())
    .filter(([, count]) => count >= minAppearances && count <= maxAppearances);

  // Score: IDF (rarity) + length bonus + identifier bonus (underscore/camelCase)
  const scored = filtered.map(([word, count]: [string, number]) => {
    const idf = Math.log(totalChunks / count);
    const lenBonus = Math.min(word.length / 20, 0.5);
    const hasSpecialChars = /[_]/.test(word);
    const isCamelOrLong = word.length >= 12;
    const identifierBonus = hasSpecialChars ? 1.5 : isCamelOrLong ? 0.8 : 0;
    return { word, score: idf + lenBonus + identifierBonus };
  });

  return scored
    .sort((a: { word: string; score: number }, b: { word: string; score: number }) => b.score - a.score)
    .slice(0, maxTerms)
    .map((s: { word: string; score: number }) => s.word);
}
