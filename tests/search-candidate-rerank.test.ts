import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ContentStore } from "../src/store.js";

// High term frequency wins initial recall; the exact code-symbol title and
// adjacent terms should win the existing title/proximity reranker instead.
function seed(store: ContentStore, sessionId = "") {
  for (let i = 0; i < 8; i++) {
    store.index({
      source: `noise-${i}`,
      content: `# General ${i}\n${("orbit " + "padding ".repeat(18) + "handshake ").repeat(6)}`,
      attribution: { sessionId },
    });
  }
  store.index({
    source: "answer",
    content: `# orbit handshake\n\`\`\`ts\nfunction orbit_handshake() { return 'orbit handshake'; }\n// ${"padding ".repeat(200)}\n\`\`\``,
    attribution: { sessionId },
  });
}

describe("candidate recall before final output limit", () => {
  let store: ContentStore;
  beforeEach(() => { store = new ContentStore(":memory:"); });
  afterEach(() => { store.close(); });

  it("lets a better title/proximity match enter a one-result response", () => {
    seed(store);
    expect(store.search("orbit handshake", 1, undefined, "OR")[0].source).not.toBe("answer");
    const results = store.searchWithFallback("orbit handshake", 1);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("answer");
  });

  it("reranks corrected queries before their output limit too", () => {
    seed(store);
    const results = store.searchWithFallback("oribt handshkae", 1);
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("answer");
    expect(results[0].matchLayer).toBe("rrf-fuzzy");
  });

  it("keeps final limits, source/content filters and empty results", () => {
    seed(store);
    for (const limit of [1, 3, 5]) {
      expect(store.searchWithFallback("orbit handshake", limit)).toHaveLength(limit);
    }
    expect(store.searchWithFallback("orbit handshake", 5, "noise-", "prose")
      .every(r => r.source.startsWith("noise-") && r.contentType === "prose")).toBe(true);
    const code = store.searchWithFallback("orbit handshake", 5, "answer", "code", "exact");
    expect(code.length).toBeGreaterThan(0);
    expect(code.every(r => r.source === "answer" && r.contentType === "code")).toBe(true);
    expect(store.searchWithFallback("zzzxxyyqqq", 3)).toEqual([]);
  });

  it("filters other projects before reranking the larger candidate pool", () => {
    seed(store, "other-project");
    store.index({ source: "allowed", content: "# General\norbit handshake", attribution: { sessionId: "this-project" } });
    store.index({ source: "legacy", content: "# General\norbit handshake" });
    const results = store.searchWithFallback("orbit handshake", 3, undefined, undefined, "like", new Set(["this-project"]));
    expect(results.map(r => r.source).sort()).toEqual(["allowed", "legacy"]);
    expect(store.searchWithFallback("orbit handshake", 3, undefined, undefined, "like", new Set())
      .map(r => r.source)).toEqual(["legacy"]);
  });

  it("batch and standalone searches select identical bounded results", () => {
    seed(store);
    const queries = ["orbit handshake", "oribt handshkae", "zzzxxyyqqq"];
    const standalone = queries.map(q => store.searchWithFallback(q, 3));
    const batched = store.withSearchBatch(search => queries.map(q => search(q, 3)));
    expect(batched).toEqual(standalone);
  });
});
