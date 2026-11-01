/** Retained Windows toolchain detection regressions for explicit CLI upgrades. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HEAL_SRC = readFileSync(
  resolve(import.meta.dirname, "../../scripts/heal-better-sqlite3.mjs"),
  "utf-8",
);

describe("heal-better-sqlite3.mjs — Windows VS year detection (VS 2026+)", () => {
  // ── Slice 1: detectWindowsVsYear() unit tests ──────────────────────

  it("exports detectWindowsVsYear() as a function", async () => {
    const mod = await import("../../scripts/heal-better-sqlite3.mjs");
    expect(typeof mod.detectWindowsVsYear).toBe("function");
  });

  it("returns null on non-Windows platforms", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const platform of ["darwin", "linux", "freebsd"]) {
      expect(detectWindowsVsYear({ platform })).toBeNull();
    }
  });

  it("returns null when vswhere.exe is absent", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => false,
    })).toBeNull();
  });

  it("extracts year from vswhere displayName for VS 2026", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => "Visual Studio Community 2026",
    })).toBe("2026");
  });

  it("works for all VS editions (Community, Professional, Enterprise)", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const displayName of [
      "Visual Studio Community 2026",
      "Visual Studio Professional 2026",
      "Visual Studio Enterprise 2026",
    ]) {
      expect(detectWindowsVsYear({
        platform: "win32",
        existsSync: () => true,
        exec: () => displayName,
      })).toBe("2026");
    }
  });

  it("works for older VS versions (2017, 2019, 2022)", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const [displayName, year] of [
      ["Visual Studio Community 2017", "2017"],
      ["Visual Studio Community 2019", "2019"],
      ["Visual Studio Community 2022", "2022"],
    ]) {
      expect(detectWindowsVsYear({
        platform: "win32",
        existsSync: () => true,
        exec: () => displayName,
      })).toBe(year);
    }
  });

  it("trims whitespace and CRLF from vswhere output before matching", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => "  Visual Studio Community 2026\r\n",
    })).toBe("2026");
  });

  it("returns null when vswhere throws", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => { throw new Error("vswhere failed"); },
    })).toBeNull();
  });

  it("returns null when vswhere returns a string with no 4-digit year", async () => {
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    for (const bad of ["", "18", "unknown"]) {
      expect(detectWindowsVsYear({
        platform: "win32",
        existsSync: () => true,
        exec: () => bad,
      })).toBeNull();
    }
  });

  // ── Slice 2: source-code assertions on buildSafeEnv ───────────────

  it("uses displayName to get the year and extracts it with a regex", () => {
    expect(HEAL_SRC).toMatch(/-property displayName/);
    expect(HEAL_SRC).toMatch(/20\\d\{2\}/);
  });

  // ── Follow-up (ARCH-REVIEW Part B #2 + #3): timeout 15s + year sanity cap ──
  // 1. Slow Windows CI/HDD vswhere queries can exceed 5s — bump to 15s.
  // 2. Any year > currentYear+5 indicates corrupted vswhere output or future
  //    MS rebrand; fail loud (return null + stderr) instead of silently
  //    poisoning npm_config_msvs_version with bogus "2099".
  it("uses a 15s vswhere timeout and rejects years beyond currentYear+5", async () => {
    // (a) Source contract: timeout literal must be 15000ms, not 5000.
    expect(HEAL_SRC).toMatch(/timeout:\s*15000/);
    expect(HEAL_SRC).not.toMatch(/timeout:\s*5000/);

    // (b) Behavioral contract: years > currentYear+5 are rejected → null.
    const { detectWindowsVsYear } = await import(
      "../../scripts/heal-better-sqlite3.mjs"
    );
    const bogusYear = String(new Date().getFullYear() + 10);
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => `Visual Studio Community ${bogusYear}`,
    })).toBeNull();

    // Sanity: a year within the +5 envelope is still accepted (this is what
    // distinguishes a real cap from a hardcoded current-year reject).
    const futureOkYear = String(new Date().getFullYear() + 3);
    expect(detectWindowsVsYear({
      platform: "win32",
      existsSync: () => true,
      exec: () => `Visual Studio Community ${futureOkYear}`,
    })).toBe(futureOkYear);
  });
});
