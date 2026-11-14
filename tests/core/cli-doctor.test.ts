import { readCliSource } from "../helpers/cli-source.js";
import { describe, it, test, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";







const ROOT = resolve(import.meta.dirname, "../..");

// ── PR #190 fix: getRuntimeSummary handles full bun path ──

describe("Runtime summary bun detection (#190)", () => {
  const RT_SOURCE = readFileSync(resolve(ROOT, "src", "runtime.ts"), "utf-8");

  test("getRuntimeSummary does not use exact === bun comparison", () => {
    // Full path like /home/user/.bun/bin/bun must be detected
    const summaryStart = RT_SOURCE.indexOf("getRuntimeSummary");
    const summaryBody = RT_SOURCE.slice(summaryStart, RT_SOURCE.indexOf("\nexport", summaryStart + 10));
    expect(summaryBody).not.toContain('=== "bun"');
  });
});

// ── Issue #564 — docs sync to hasModernSqlite() source of truth ────────
// README and docs/platform-support.md historically promised "Node 18+"
// (9 spots in README) and "Node >= 22.13" (platform-support), while the
// runtime gate (`hasModernSqlite()` in src/db-base.ts:226-244) uses 22.5.
// Three numbers, three contracts. v1.0.132 collapses them to one — the
// runtime gate is the canonical source.
describe("Issue #564 — docs match hasModernSqlite() source of truth", () => {
  const DB_BASE_SRC = readFileSync(resolve(ROOT, "src", "db-base.ts"), "utf-8");

  it("src/db-base.ts hasModernSqlite() uses the 22.5 floor (sanity / source of truth)", () => {
    // If this fails, the floor moved — the README + docs assertions
    // below need their threshold updated in lockstep. This test pins the
    // contract so the docs assertions can not silently drift.
    expect(DB_BASE_SRC).toContain("export function hasModernSqlite");
    // Inline major/minor compare must reference 22 and 5.
    expect(DB_BASE_SRC).toMatch(/major\s*===\s*22\s*&&\s*minor\s*>=\s*5/);
  });

  it("README.md does NOT promise Node.js 18+ on platforms where Linux is unsafe", () => {
    const readme = readFileSync(resolve(ROOT, "README.md"), "utf-8");
    // The literal string "Node.js 18+" must be gone from prerequisites
    // lines — it's a false promise on Linux.
    const nodeJs18PrereqLines = readme
      .split("\n")
      .filter((l) => /Node\.js\s+18\s*\+/.test(l));
    expect(nodeJs18PrereqLines).toEqual([]);
    // README must positively state the 22.5 (or Bun) floor somewhere.
    expect(readme).toMatch(/22\.5/);
  });

  it("docs/platform-support.md SQLite Backend Selection table uses 22.5, not 22.13", () => {
    const doc = readFileSync(resolve(ROOT, "docs", "platform-support.md"), "utf-8");
    // The literal "22.13" must be gone — it disagrees with hasModernSqlite().
    expect(doc).not.toMatch(/22\.13/);
    // The 22.5 floor must be present.
    expect(doc).toMatch(/22\.5/);
  });
});

// ── Issue #564 — doctor RED FAIL on Linux + Node < 22.5 + no Bun ──────
// Six prior fixes (#228, #331, #461, #540, #551, #556) silently assumed
// Node >= 22.5 on Linux. Reporter #564 hit SIGSEGV on Node 20 because
// engines.node was absent and doctor never flagged the unsafe config.
//
// Architect contract for v1.0.132: doctor MUST emit an explicit RED FAIL
// (not a warn / not a passing note) for the predicate
//   process.platform === "linux" && !hasModernSqlite() && globalThis.Bun === undefined
// linking to issue #564.
//
// Static-analysis assertion (same pattern as cli.test.ts:289, :820, :970):
// runtime spawning would need a fake-Linux fake-Node-20 environment that
// is not portable; asserting the gate exists in source catches the
// regression at PR time and is the precedent used elsewhere in this file.
describe("Issue #564 — doctor() flags Linux + Node < 22.5 + no Bun", () => {
  const CLI_SRC = readCliSource();

  function doctorBody(): string {
    const start = CLI_SRC.indexOf("async function doctor(");
    expect(start).toBeGreaterThan(-1);
    // doctor() spans ~300 lines; grab a generous window that ends before
    // the next top-level function declaration (`async function insight`).
    const end = CLI_SRC.indexOf("async function insight", start);
    expect(end).toBeGreaterThan(start);
    return CLI_SRC.slice(start, end);
  }

  it("doctor fails on Linux + Node < 22.5 + no bun (RED FAIL line)", () => {
    const body = doctorBody();
    // The Linux predicate must be in doctor().
    expect(body).toMatch(/process\.platform\s*===\s*["']linux["']/);
    // Must consult the 22.5 gate via hasModernSqlite (the source of truth
    // in src/db-base.ts:226-244) OR an equivalent inline major/minor check.
    const usesHelper = /hasModernSqlite/.test(body);
    const usesInlineGate =
      /process\.versions\.node/.test(body) && /22(?:\.5|[^0-9])/.test(body);
    expect(usesHelper || usesInlineGate).toBe(true);
    // Bun must be allowed through (Linux + Bun is fine).
    expect(body).toMatch(/globalThis\.Bun|hasBunRuntime|process\.versions\.bun/);
    // Must be a RED FAIL (architect mandate) — not a warn/info. Reuses
    // the existing FAIL surface: `p.log.error(color.red(... FAIL ...`.
    // We assert FAIL appears in the new block by matching against an
    // anchor unique to it (issue #564 reference).
    const issueIdx = body.indexOf("#564");
    expect(issueIdx).toBeGreaterThan(-1);
    // Look at a wide window around the #564 anchor — the comment block
    // sits above the predicate and the FAIL emission sits below, so we
    // grab text on both sides.
    const surrounding = body.slice(
      Math.max(0, issueIdx - 1500),
      issueIdx + 2000,
    );
    expect(surrounding).toMatch(/p\.log\.error/);
    expect(surrounding).toMatch(/FAIL/);
    // The block must increment criticalFails so the doctor exits non-zero.
    expect(surrounding).toMatch(/criticalFails\+\+/);
    // Remediation: must point users at 22.5+ (or Bun).
    expect(body).toMatch(/22\.5/);
  });
});
