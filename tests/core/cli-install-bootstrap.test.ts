import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";






import { setupPartialInstallFixture } from "../helpers/partial-install.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("hooks/heal-partial-install.mjs (bootstrap)", () => {
const { makeTmp, buildFakeLayout, readJson } = setupPartialInstallFixture();
// ── Wiring assertions ──

    it("start.mjs invokes the heal before the Algo-D4 integrity check", () => {
      const src = readFileSync(resolve(ROOT, "start.mjs"), "utf-8");
      // Anchor on the literal import + call shape, not the bare filename
      // substring. A DELETED- prefix or comment mention would otherwise
      // pass the test even when the wiring is gone.
      const importIdx = src.indexOf('"./hooks/heal-partial-install.mjs"');
      const callIdx = src.indexOf("healPartialInstallFromMarketplace({");
      const integrityIdx = src.indexOf('"./scripts/plugin-cache-integrity.mjs"');
      expect(importIdx, "heal-partial-install import missing in start.mjs").toBeGreaterThan(-1);
      expect(callIdx, "healPartialInstallFromMarketplace call missing in start.mjs").toBeGreaterThan(-1);
      expect(integrityIdx, "plugin-cache-integrity import missing in start.mjs").toBeGreaterThan(-1);
      // Order: heal runs first so a fixable install is repaired, then
      // the integrity gate decides whether boot proceeds.
      expect(importIdx).toBeLessThan(integrityIdx);
      expect(callIdx).toBeLessThan(integrityIdx);
    });

it("hooks/sessionstart.mjs invokes the heal early in the runHook callback", () => {
      const src = readFileSync(
        resolve(ROOT, "hooks", "sessionstart.mjs"),
        "utf-8",
      );
      const importIdx = src.indexOf('"./heal-partial-install.mjs"');
      const callIdx = src.indexOf("healPartialInstallFromMarketplace()");
      expect(importIdx, "heal-partial-install import missing in sessionstart.mjs").toBeGreaterThan(-1);
      expect(callIdx, "healPartialInstallFromMarketplace call missing in sessionstart.mjs").toBeGreaterThan(-1);
      // Heal must fire before the age-gated cleanup that wipes sibling
      // cache version dirs, since the cleanup would otherwise erase a
      // healthy previous version while the new one is still partial.
      const cleanupIdx = src.indexOf("Age-gated lazy cleanup");
      expect(cleanupIdx, "age-gated cleanup comment missing").toBeGreaterThan(-1);
      expect(callIdx).toBeLessThan(cleanupIdx);
    });
});
