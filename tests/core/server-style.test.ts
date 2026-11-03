/** Server regressions: style. */


import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test, expect } from "vitest";


import { readServerSource } from "../helpers/server-source.js";

const __dirname = dirname(fileURLToPath(import.meta.url));


// ═══════════════════════════════════════════════════════════════════════════
// Prose-style policy (issue #482)
// ═══════════════════════════════════════════════════════════════════════════
// Decision: context-mode keeps raw data out of context but does not dictate
// how the model writes its final answer. Aggressive brevity prompts have been
// shown to degrade coding/reasoning benchmarks (Moonshot AI on kimi-k2.5).
// Any caveman/terse-style language in shipped artifacts is a regression.

describe("prose-style policy (#482)", () => {
  const serverSrc = readServerSource();
  const routingBlock = readFileSync(
    resolve(__dirname, "../../hooks/routing-block.mjs"),
    "utf-8",
  );

  test("no caveman/terse directive lands in any MCP tool description", () => {
    expect(serverSrc).not.toMatch(/terse like caveman/i);
    expect(serverSrc).not.toMatch(/only fluff die/i);
  });

  test("routing-block has no <communication_style> or <response_format> blocks", () => {
    expect(routingBlock).not.toMatch(/<communication_style>/);
    expect(routingBlock).not.toMatch(/<response_format>/);
    expect(routingBlock).not.toMatch(/terse like caveman/i);
  });

  test("README does not advertise an Output Compression pillar", () => {
    const readme = readFileSync(
      resolve(__dirname, "../../README.md"),
      "utf-8",
    );
    expect(readme).not.toMatch(/\*\*Output Compression\*\*/);
    expect(readme).not.toMatch(/terse like caveman/i);
  });

  test("committed bundles (cli/server/hooks) carry no caveman strings", () => {
    // Defense-in-depth: src/* is stripped, but the npm-shipped bundles are
    // built artifacts that could lag if a future release rebuilds from a
    // dirty tree. Lock the deletion to the actually-published files too
    // (round-5 finding).
    const bundlePaths = [
      "../../server.bundle.mjs",
      "../../cli.bundle.mjs",
      "../../hooks/session-extract.bundle.mjs",
      "../../hooks/session-snapshot.bundle.mjs",
      "../../hooks/session-db.bundle.mjs",
    ];
    for (const rel of bundlePaths) {
      const p = resolve(__dirname, rel);
      try {
        const content = readFileSync(p, "utf-8");
        expect(content).not.toMatch(/terse like caveman/i);
        expect(content).not.toMatch(/only fluff die/i);
      } catch (err) {
        // Bundle missing on this checkout (e.g., fresh clone before
        // `npm run bundle`). That is fine — CI's Build step generates
        // them; this test only asserts negative when the file exists.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  });
});
