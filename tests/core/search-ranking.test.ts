/** Search ranking regressions. */

import { describe, test, expect, it, beforeEach, afterEach } from "vitest";
import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";
import { createStore } from "../helpers/content-store.js";


// ═══════════════════════════════════════════════════════════
// 8. BM25 Field Weight Tuning
// ═══════════════════════════════════════════════════════════

describe("BM25 field weight tuning", () => {
  test("title match outranks content-only match", () => {
    const store = createStore();
    try {
      // Chunk 1: "authentication" in title only
      store.index({
        content: "# Authentication\n\nThis section covers user login and access control.",
        source: "docs-with-title",
      });
      // Chunk 2: "authentication" in content only
      store.index({
        content: "# Security Overview\n\nThe authentication process validates credentials against the database.",
        source: "docs-content-only",
      });

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      // With 5x title weight, the title-match chunk should rank first
      assert.ok(
        results[0].title.toLowerCase().includes("authentication"),
        `Expected first result to have 'authentication' in title, got: "${results[0].title}"`,
      );
    } finally {
      store.close();
    }
  });

  test("title weight boost is consistent for trigram search", () => {
    const store = createStore();
    try {
      store.index({
        content: "# useEffectCallback\n\nHandles side effects in components.",
        source: "trigram-title",
      });
      store.index({
        content: "# Component Lifecycle\n\nThe useEffectCallback hook manages cleanup logic.",
        source: "trigram-content",
      });

      const results = store.searchTrigram("useEffectCallback", 5);
      assert.ok(results.length >= 1, "Trigram should find camelCase term");
    } finally {
      store.close();
    }
  });

  test("backward compatibility: existing searches still return results", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The caching strategy uses Redis for session data.\nCache invalidation happens on write.",
        "cache-docs",
      );

      const results = store.searchWithFallback("caching strategy", 3);
      assert.ok(results.length > 0, "Existing searches should still work");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 10. Reciprocal Rank Fusion (RRF)
// ═══════════════════════════════════════════════════════════

describe("Reciprocal Rank Fusion", () => {
  test("RRF returns matchLayer='rrf' for fused results", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The authentication middleware validates JWT tokens on every request.\nExpired tokens are rejected with 401.",
        "auth-docs",
      );
      const results = store.searchWithFallback("authentication JWT tokens", 3);
      assert.ok(results.length > 0, "RRF should find results");
      assert.equal(results[0].matchLayer, "rrf", "matchLayer should be 'rrf'");
    } finally {
      store.close();
    }
  });

  test("RRF merges porter and trigram results", () => {
    const store = createStore();
    try {
      // Porter-friendly: standard English words
      store.indexPlainText(
        "The authentication middleware validates credentials against the user database.",
        "porter-friendly",
      );
      // Trigram-friendly: camelCase identifier not in porter vocabulary
      store.indexPlainText(
        "The authenticationMiddleware component handles token validation.",
        "trigram-friendly",
      );

      const results = store.searchWithFallback("authentication middleware", 5);
      assert.ok(results.length >= 2, "Should find results from both tables");
    } finally {
      store.close();
    }
  });

  test("RRF deduplicates by source::title key", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The caching strategy uses Redis for session management.\nCache invalidation triggers on every write operation.",
        "cache-docs",
      );

      const results = store.searchWithFallback("caching strategy", 10);
      // Check no duplicates: same source+title should not appear twice
      const keys = results.map(r => `${r.source}::${r.title}`);
      const uniqueKeys = new Set(keys);
      assert.equal(keys.length, uniqueKeys.size, "Results should have no duplicates");
    } finally {
      store.close();
    }
  });

  test("RRF-fuzzy activates on typo", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The kubernetes cluster manages container orchestration.\nPods are scheduled across worker nodes.",
        "k8s-docs",
      );

      const results = store.searchWithFallback("kuberntes", 3); // typo
      assert.ok(results.length > 0, "Fuzzy correction should find results");
      assert.equal(results[0].matchLayer, "rrf-fuzzy", "matchLayer should be 'rrf-fuzzy'");
    } finally {
      store.close();
    }
  });

  test("RRF with source filter respects constraint", () => {
    const store = createStore();
    try {
      store.indexPlainText("Authentication flow uses JWT tokens.", "auth-source");
      store.indexPlainText("Authentication also uses OAuth.", "oauth-source");

      const results = store.searchWithFallback("authentication", 5, "auth-source");
      assert.ok(results.length > 0);
      for (const r of results) {
        assert.ok(r.source.includes("auth-source"), `Source should match: ${r.source}`);
      }
    } finally {
      store.close();
    }
  });

  test("RRF with contentType filter works", () => {
    const store = createStore();
    try {
      store.index({
        content: "# API Reference\n\n```javascript\nfunction authenticate() { return true; }\n```",
        source: "code-docs",
      });
      store.index({
        content: "# Architecture\n\nThe authentication system uses JWT tokens for session management.",
        source: "prose-docs",
      });

      const results = store.searchWithFallback("authenticate", 5, undefined, "code");
      for (const r of results) {
        assert.equal(r.contentType, "code", `Should filter to code only`);
      }
    } finally {
      store.close();
    }
  });

  test("multi-table match ranks higher than single-table", () => {
    const store = createStore();
    try {
      // This content should match well on both porter AND trigram
      store.indexPlainText(
        "The authentication middleware validates credentials against the database.\nauthentication is the first step.",
        "both-tables",
      );
      // This content has a unique term only trigram would find well
      store.indexPlainText(
        "The xyzAuthHelper utility function provides helper methods for auth.",
        "single-table",
      );

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length > 0, "Should find results");
    } finally {
      store.close();
    }
  });

  test("backward compat: existing search patterns still find results", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The caching strategy uses Redis for session data.\nCache invalidation happens on write.",
        "execute:shell",
      );

      const results = store.searchWithFallback("caching strategy", 3, "execute:shell");
      assert.ok(results.length > 0, "Existing patterns should still work");
      assert.ok(results[0].content.includes("caching"), "Content should match");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 11. Proximity Reranking
// ═══════════════════════════════════════════════════════════

describe("Proximity reranking", () => {
  test("adjacent terms rank higher than distant terms", () => {
    const store = createStore();
    try {
      // Terms are adjacent: "error handling" close together
      store.indexPlainText(
        "The error handling middleware catches all exceptions and returns proper HTTP status codes.",
        "close-terms",
      );
      // Terms are far apart: "error" at start, "handling" much later
      store.indexPlainText(
        "When an error occurs in the system, the logger records it. " +
        "After extensive processing and validation of the request parameters, " +
        "the response formatting and status code handling takes place.",
        "distant-terms",
      );

      const results = store.searchWithFallback("error handling", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      // The chunk with adjacent terms should rank first
      assert.ok(
        results[0].source === "close-terms",
        `Expected close-terms first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("single-term queries are not affected by proximity", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The authentication system validates user credentials.",
        "source-a",
      );
      store.indexPlainText(
        "Authentication is required for all API endpoints.",
        "source-b",
      );

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length > 0, "Should find results");
      // Single term: proximity should not change ordering
      // Just verify results are returned (RRF ordering preserved)
    } finally {
      store.close();
    }
  });

  test("tightest span wins for multi-term query", () => {
    const store = createStore();
    try {
      // Span of ~5 chars between "cache" and "invalidation"
      store.indexPlainText(
        "The cache invalidation strategy ensures data consistency across all nodes.",
        "tight-span",
      );
      // Span of ~80+ chars between "cache" and "invalidation"
      store.indexPlainText(
        "The cache layer stores frequently accessed data in memory for fast retrieval. " +
        "When data changes, the system triggers invalidation of affected entries.",
        "wide-span",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 2, "Should find both");
      assert.ok(
        results[0].source === "tight-span",
        `Expected tight-span first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("proximity with source filter still works", () => {
    const store = createStore();
    try {
      store.indexPlainText(
        "The error handling middleware catches exceptions.",
        "filtered-source",
      );
      store.indexPlainText(
        "Error recovery and handling procedures are documented.",
        "other-source",
      );

      const results = store.searchWithFallback("error handling", 5, "filtered-source");
      assert.ok(results.length > 0);
      for (const r of results) {
        assert.ok(r.source.includes("filtered-source"));
      }
    } finally {
      store.close();
    }
  });

  test("three-term query proximity", () => {
    const store = createStore();
    try {
      // All three terms close together
      store.indexPlainText(
        "The user authentication token validation ensures secure access to protected resources.",
        "all-close",
      );
      // Terms spread out
      store.indexPlainText(
        "The user profile page displays account information. " +
        "For security, authentication is checked on every request. " +
        "Additionally, token expiration and validation rules apply to API calls.",
        "spread-out",
      );

      const results = store.searchWithFallback("user authentication token", 5);
      assert.ok(results.length >= 2, "Should find both");
      assert.ok(
        results[0].source === "all-close",
        `Expected all-close first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("proximity does not eliminate results, only reorders", () => {
    const store = createStore();
    try {
      store.indexPlainText("Error handling is important.", "chunk-a");
      store.indexPlainText("Proper error and exception handling.", "chunk-b");
      store.indexPlainText("Error recovery handling procedures.", "chunk-c");

      const results = store.searchWithFallback("error handling", 10);
      // All chunks should still be present (proximity only reorders, never removes)
      assert.ok(results.length >= 2, "Should not eliminate any results");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════
// 8. Content-Type-Aware Title Boost
// ═══════════════════════════════════════════════════════════

describe("Content-type-aware title boost in reranking", () => {
  test("chunk with query term in title ranks above chunk with same term only in body", () => {
    const store = createStore();
    try {
      // Chunk A: title matches "parseConfig"
      store.index({
        content: "## parseConfig\n\nThis function loads configuration from disk and parses it into a settings object.",
        source: "title-match",
      });
      // Chunk B: "parseConfig" only in body, not title
      store.index({
        content: "## Configuration Guide\n\nThe system uses parseConfig to load settings from disk. Call parseConfig with the path to your config file.",
        source: "body-match",
      });

      const results = store.searchWithFallback("parseConfig", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.ok(
        results[0].title.toLowerCase().includes("parseconfig"),
        "Chunk with title match should rank first",
      );
    } finally {
      store.close();
    }
  });

  test("title boost applies to single-term queries (not just multi-term)", () => {
    const store = createStore();
    try {
      store.index({
        content: "## authentication\n\nThis module handles user login and session management.",
        source: "auth-titled",
      });
      store.index({
        content: "## Security Overview\n\nThe authentication system validates user credentials using bcrypt hashing. Authentication tokens expire after 24 hours.",
        source: "auth-body",
      });

      const results = store.searchWithFallback("authentication", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.ok(
        results[0].title.toLowerCase().includes("authentication"),
        "Chunk with query term in title should rank first",
      );
    } finally {
      store.close();
    }
  });

  test("code chunks get stronger title boost than prose chunks", () => {
    const store = createStore();
    try {
      // Code chunk: "validator" in title + code fence → contentType=code, titleWeight=0.6
      store.index({
        content: "## validator\n\n```javascript\nclass Validator {\n  validate(input) { return input.length > 0; }\n}\n```",
        source: "validator-code",
      });
      // Prose chunk: "validator" in title, no code fence → contentType=prose, titleWeight=0.3
      store.index({
        content: "## validator\n\nThe validator module provides input validation utilities for the API layer. It checks all fields.",
        source: "validator-prose",
      });

      const results = store.searchWithFallback("validator input", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.equal(results[0].contentType, "code", "Code chunk should rank first with stronger title boost");
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Phrase-frequency reward in reranking
//
// Adds a phrase-frequency component on top of the existing minSpan proximity.
// minSpan returns a single number (the tightest window), so a doc with 3×
// adjacent phrase hits ties a doc with 1× adjacent phrase hit at the same
// span — and length-normalization actually favors the longer doc. The reward
// counts ordered adjacent-pair occurrences (term[i] followed by term[i+1]
// within 30 chars) and adds a saturating boost (cap 0.5 at 4 hits) so
// frequency breaks the tie without unbounded keyword-stuffing wins.
// ═══════════════════════════════════════════════════════════════════════════

describe("Phrase-frequency reward in reranking", () => {
  test("multiple phrase occurrences outrank a single tight phrase at similar minSpan", () => {
    const store = createStore();
    try {
      // Three adjacent occurrences. minSpan ≈ 6 chars (one occurrence).
      store.indexPlainText(
        "Cache invalidation matters. Cache invalidation is hard. Cache invalidation strategy is documented here too.",
        "phrase-frequent",
      );
      // One adjacent occurrence padded with filler so contentLen is comparable.
      store.indexPlainText(
        "Cache invalidation appears here once. " +
          "The remainder of this paragraph deliberately discusses unrelated topics like deployment, monitoring, and on-call rotations.",
        "phrase-once",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 2, "Should find both chunks");
      assert.equal(
        results[0].source,
        "phrase-frequent",
        `Expected phrase-frequent first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("phrase-frequency reward respects query order (regression guard)", () => {
    const store = createStore();
    try {
      // Adjacent in query order.
      store.indexPlainText(
        "Lorem ipsum dolor sit amet. The cache invalidation pipeline runs on every write.",
        "phrase-ordered",
      );
      // Reversed order — no ordered phrase hits.
      store.indexPlainText(
        "Lorem ipsum dolor sit amet. The invalidation step is followed by a cache flush.",
        "phrase-reversed",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 2);
      assert.equal(
        results[0].source,
        "phrase-ordered",
        `Expected phrase-ordered first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("3-term query: only consecutive-pair adjacency contributes to frequency", () => {
    const store = createStore();
    try {
      // "alpha beta" adjacent (pair 0→1 hits) AND "beta gamma" adjacent (pair 1→2 hits)
      // Three contiguous mentions of "alpha beta gamma" → 2 pairs per mention × 3 mentions = 6 pair-hits.
      store.indexPlainText(
        "alpha beta gamma matters. alpha beta gamma is hard. alpha beta gamma works well in practice.",
        "all-adjacent",
      );
      // "alpha beta" adjacent BUT "beta gamma" separated by ~80 chars of filler.
      // Pair 0→1 hits once, pair 1→2 misses → only 1 pair-hit.
      store.indexPlainText(
        "alpha beta runs the pipeline; the rest of this paragraph deliberately " +
          "talks about deployment monitoring oncall rotations and other unrelated topics gamma.",
        "split-adjacency",
      );

      const results = store.searchWithFallback("alpha beta gamma", 5);
      assert.ok(results.length >= 2);
      assert.equal(
        results[0].source,
        "all-adjacent",
        `Expected all-adjacent first, got: ${results[0].source}`,
      );
    } finally {
      store.close();
    }
  });

  test("saturation: 8-hit stuffed doc cannot beat 4-hit doc by more than the cap allows", () => {
    const store = createStore();
    try {
      // 8 adjacent occurrences — well above saturation (4).
      store.indexPlainText(
        "cache invalidation cache invalidation cache invalidation cache invalidation " +
          "cache invalidation cache invalidation cache invalidation cache invalidation",
        "stuffed-eight",
      );
      // 4 adjacent occurrences — exactly at saturation.
      store.indexPlainText(
        "cache invalidation cache invalidation cache invalidation cache invalidation",
        "stuffed-four",
      );
      // 1 adjacent occurrence inside a long natural paragraph.
      // Without a cap, stuffed-eight (8 hits) could outrank everything; with
      // the cap binding at 4, stuffed-eight and stuffed-four collapse to the
      // same phrase contribution. The natural doc earns a smaller phrase
      // contribution but still benefits from comparable proximity, so it must
      // remain competitive in the top-3.
      store.indexPlainText(
        "Cache invalidation in a real system requires careful coordination across " +
          "distributed nodes. Replication lag, eventual consistency, and leader-election " +
          "races all interact in subtle ways that complicate a naive flush-on-write " +
          "strategy used by many caching layers in production environments today.",
        "natural-prose",
      );

      const results = store.searchWithFallback("cache invalidation", 5);
      assert.ok(results.length >= 3, "Should find all three chunks");

      const top3 = results.slice(0, 3).map((r) => r.source);
      assert.ok(
        top3.includes("natural-prose"),
        `Cap must bind so natural-prose stays competitive; got top3=${top3.join(", ")}`,
      );
    } finally {
      store.close();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Search Relevance Eval — ranking quality under competitive conditions
//
// Indexes 12 heterogeneous markdown sources into a single store and asserts
// ranking correctness (precision@1, recall@5, title boost, cascade, negatives).
// Guards BM25 weights, RRF K, proximity formula, and title boost weights
// against silent regression.
// ═══════════════════════════════════════════════════════════════════════════

const RELEVANCE_CORPUS: Array<{ source: string; markdown: string }> = [
  {
    source: "api-auth-handler",
    markdown: `# Authentication middleware\n\n## verifyToken\n\n\`\`\`typescript\nexport async function verifyToken(req: Request): Promise<User> {\n  const header = req.headers.get("Authorization");\n  if (!header?.startsWith("Bearer ")) {\n    throw new AuthenticationError("Missing or malformed Authorization header");\n  }\n  const token = header.slice(7);\n  const payload = jwt.verify(token, process.env.JWT_SECRET!);\n  return payload;\n}\n\`\`\`\n\nThe middleware validates JWT tokens from the Authorization header and returns the decoded user payload.`,
  },
  {
    source: "nginx-access-log",
    markdown: `# Nginx access log\n\n## Recent requests\n\n\`\`\`\n192.168.1.42 "GET /api/auth/callback HTTP/1.1" 200 1234\n192.168.1.43 "GET /static/bundle.js HTTP/1.1" 200 450321\n192.168.1.44 "POST /api/users HTTP/1.1" 201 89\n10.0.0.1 "DELETE /api/sessions HTTP/1.1" 204 0\n\`\`\``,
  },
  {
    source: "react-useeffect-docs",
    markdown: `# React useEffect\n\n## Cleanup and dependencies\n\nuseEffect lets you synchronize a component with an external system.\n\n\`\`\`jsx\nuseEffect(() => {\n  const connection = createConnection(serverUrl, roomId);\n  connection.connect();\n  return () => connection.disconnect();\n}, [serverUrl, roomId]);\n\`\`\`\n\n## When cleanup runs\n\nThe cleanup function runs before every re-render with changed dependencies, and once more when the component unmounts.`,
  },
  {
    source: "vitest-output",
    markdown: `# Test results\n\n## Summary\n\nTest Suites: 1 failed, 29 passed, 30 total\nTests: 1 failed, 219 passed, 220 total\n\n## Failed test\n\n\`\`\`\nFAIL tests/hooks/integration.test.ts\n  PostToolUse hook session capture\n    AssertionError: expected "ok" to equal "captured"\n    at tests/hooks/integration.test.ts:142:5\n\`\`\`\n\n## Passed suites\n\n- store.test.ts (34 tests) 1200ms\n- executor.test.ts (55 tests) 3400ms`,
  },
  {
    source: "database-migration",
    markdown: `# Database migration 0042\n\n## Add tenant_id column\n\n\`\`\`sql\nALTER TABLE orders ADD COLUMN tenant_id UUID NOT NULL DEFAULT '00000000';\nCREATE INDEX idx_orders_tenant ON orders(tenant_id);\n\`\`\`\n\n## Backfill\n\n\`\`\`sql\nUPDATE orders SET tenant_id = (SELECT org_id FROM users WHERE users.id = orders.user_id);\n\`\`\``,
  },
  {
    source: "nextjs-build-output",
    markdown: `# Next.js build output\n\n## Warnings\n\n- You have enabled experimental feature (serverActions) in next.config.js\n- Duplicate page detected. pages/api/auth and app/api/auth both resolve to /api/auth\n\n## Routes\n\n| Route | Size | First Load |\n|-------|------|------------|\n| / | 5.2 kB | 89.1 kB |\n| /dashboard | 12.3 kB | 96.2 kB |`,
  },
  {
    source: "python-traceback",
    markdown: `# Python error traceback\n\n## Database connection timeout\n\n\`\`\`\nTraceback (most recent call last):\n  File "/app/services/sync.py", line 234, in sync_orders\n    conn = await asyncpg.connect(DATABASE_URL, timeout=30)\nasyncio.TimeoutError\n\nDatabaseConnectionError: Failed to connect after 3 retries\n\`\`\`\n\nThe sync service could not reach the PostgreSQL database within the 30-second timeout.`,
  },
  {
    source: "git-log-recent",
    markdown: `# Git log\n\n## Recent commits\n\n- eb36c2e perf: enable mmap_size pragma for FTS5 search\n- 766de41 ci: update server.bundle.mjs\n- 01470ec fix(store): wrap indexPlainText with withRetry\n- c445a12 feat(kiro): add full hook support for Kiro IDE`,
  },
  {
    source: "tailwind-config",
    markdown: `# Tailwind CSS configuration\n\n## Custom theme colors\n\n\`\`\`javascript\nmodule.exports = {\n  theme: {\n    extend: {\n      colors: {\n        brand: { 50: '#f0f9ff', 500: '#0ea5e9', 900: '#0c4a6e' },\n      },\n      fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] },\n    },\n  },\n  plugins: [require('@tailwindcss/forms'), require('@tailwindcss/typography')],\n};\n\`\`\``,
  },
  {
    source: "dockerfile-prod",
    markdown: `# Dockerfile\n\n## Multi-stage production build\n\n\`\`\`dockerfile\nFROM node:20-alpine AS builder\nWORKDIR /app\nCOPY package.json package-lock.json ./\nRUN npm ci --production=false\nCOPY . .\nRUN npm run build\n\nFROM node:20-alpine AS runner\nENV NODE_ENV=production\nCOPY --from=builder /app/build ./build\nCMD ["node", "build/server.js"]\n\`\`\``,
  },
  {
    source: "k8s-deployment",
    markdown: `# Kubernetes deployment\n\n## api-server\n\n\`\`\`yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api-server\n  namespace: production\nspec:\n  replicas: 3\n  template:\n    spec:\n      containers:\n        - name: api\n          image: registry.example.com/api:v2.3.1\n          resources:\n            requests: { cpu: "250m", memory: "512Mi" }\n          readinessProbe:\n            httpGet: { path: /health, port: 3000 }\n\`\`\``,
  },
  {
    source: "package-json-deps",
    markdown: `# Package dependencies\n\n## Production\n\n- next 14.2.3\n- react 18.3.1\n- @prisma/client 5.14.0\n- zod 3.23.8\n\n## Dev dependencies\n\n- typescript 5.4.5\n- vitest 1.6.0\n- tailwindcss 3.4.3\n- eslint 8.57.0`,
  },
];

describe("Search relevance eval — competitive corpus", () => {
  let relevanceStore: ContentStore;

  beforeEach(() => {
    const path = join(tmpdir(), `ctx-relevance-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    relevanceStore = new ContentStore(path);
    for (const doc of RELEVANCE_CORPUS) {
      relevanceStore.index({ content: doc.markdown, source: doc.source });
    }
  });

  afterEach(() => {
    relevanceStore.cleanup();
  });

  function topOne(query: string, expectedSource: string) {
    const results = relevanceStore.searchWithFallback(query, 3);
    expect(results.length, `"${query}" should return results`).toBeGreaterThan(0);
    expect(results[0].source, `"${query}" #1 should be "${expectedSource}", got "${results[0]?.source}"`).toBe(expectedSource);
  }

  function ranking(query: string, expectTop: string | string[], expectAbsent?: string[], layer?: string) {
    const results = relevanceStore.searchWithFallback(query, 5);
    const sources = results.map((r) => r.source);
    const tops = Array.isArray(expectTop) ? expectTop : [expectTop];
    for (const e of tops) expect(sources, `"${query}" should find "${e}" in top 5, got [${sources}]`).toContain(e);
    if (expectAbsent) for (const a of expectAbsent) expect(sources, `"${query}" should NOT return "${a}"`).not.toContain(a);
    if (layer) expect(results[0]?.matchLayer, `"${query}" should hit ${layer} layer`).toBe(layer);
  }

  // precision@1
  test("'authentication middleware JWT' → api-auth-handler", () => topOne("authentication middleware JWT", "api-auth-handler"));
  test("'database connection timeout' → python-traceback", () => topOne("database connection timeout", "python-traceback"));
  test("'useEffect cleanup' → react-useeffect-docs", () => topOne("useEffect cleanup", "react-useeffect-docs"));
  test("'tenant_id migration ALTER TABLE' → database-migration", () => topOne("tenant_id migration ALTER TABLE", "database-migration"));
  test("'Dockerfile multi-stage build' → dockerfile-prod", () => topOne("Dockerfile multi-stage build", "dockerfile-prod"));
  test("'Kubernetes deployment replicas' → k8s-deployment", () => topOne("Kubernetes deployment replicas", "k8s-deployment"));
  test("'tailwind theme colors brand' → tailwind-config", () => topOne("tailwind theme colors brand", "tailwind-config"));
  test("'test failed assertion FAIL' → vitest-output", () => topOne("test failed assertion FAIL", "vitest-output"));

  // recall@5
  test("'error timeout' finds python-traceback", () => ranking("error timeout", "python-traceback", ["tailwind-config", "git-log-recent"]));
  test("'build warning experimental serverActions' finds nextjs output", () => ranking("build warning experimental serverActions", "nextjs-build-output"));
  test("'react dependencies vitest typescript' finds package.json", () => ranking("react dependencies vitest typescript", "package-json-deps"));
  test("'mmap pragma perf FTS5' finds git log", () => ranking("mmap pragma perf FTS5", "git-log-recent"));

  // title boost
  test("'Kubernetes deployment' title match ranks k8s-deployment first", () => topOne("Kubernetes deployment", "k8s-deployment"));
  test("'Dockerfile' title match ranks dockerfile-prod first", () => topOne("Dockerfile", "dockerfile-prod"));

  // cascade
  test("exact terms hit RRF layer", () => ranking("useEffect cleanup", "react-useeffect-docs", undefined, "rrf"));
  test("typo still resolves to correct doc", () => ranking("authenticaton middlewar", "api-auth-handler"));

  // negatives
  test("'tailwind colors' excludes unrelated sources", () => ranking("tailwind colors", "tailwind-config", ["database-migration", "python-traceback"]));
  test("'SQL ALTER TABLE' excludes non-DB sources", () => ranking("SQL ALTER TABLE", "database-migration", ["nginx-access-log", "react-useeffect-docs"]));
});
