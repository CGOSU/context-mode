import { describe, it, expect } from "vitest";

import { mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { resolve, join } from "node:path";






import { setupPartialInstallFixture } from "../helpers/partial-install.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("hooks/heal-partial-install.mjs (detection)", () => {
const { makeTmp, buildFakeLayout, readJson } = setupPartialInstallFixture();
// ── isPartialInstall cheap probe ──

    it("isPartialInstall returns false for a healthy install", async () => {
      const { isPartialInstall } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

it("isPartialInstall returns true when start.mjs is missing", async () => {
      const { isPartialInstall } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "start.mjs"));
      expect(isPartialInstall(pluginRoot)).toBe(true);
    });

it("isPartialInstall returns true when package.json is missing", async () => {
      const { isPartialInstall } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "package.json"));
      expect(isPartialInstall(pluginRoot)).toBe(true);
    });

it("isPartialInstall returns true when both cli.bundle.mjs and build/cli.js are missing", async () => {
      const { isPartialInstall } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "cli.bundle.mjs"));
      expect(isPartialInstall(pluginRoot)).toBe(true);
    });

it("isPartialInstall accepts build/cli.js as the cli fallback", async () => {
      const { isPartialInstall } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();
      cpSync(marketplaceClonePath, pluginRoot, { recursive: true, force: true });
      rmSync(join(pluginRoot, "cli.bundle.mjs"));
      rmSync(join(pluginRoot, "server.bundle.mjs"));
      mkdirSync(join(pluginRoot, "build"), { recursive: true });
      writeFileSync(join(pluginRoot, "build", "cli.js"), "// tsc output\n");
      writeFileSync(join(pluginRoot, "build", "server.js"), "// tsc output\n");
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

it("isPartialInstall returns false on falsy pluginRoot", async () => {
      const { isPartialInstall } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      expect(isPartialInstall(undefined)).toBe(false);
      expect(isPartialInstall(null)).toBe(false);
      expect(isPartialInstall("")).toBe(false);
    });

// ── deriveMarketplaceClonePath layout helper ──

    it("deriveMarketplaceClonePath derives the marketplace path from a CC cache layout", async () => {
      const { deriveMarketplaceClonePath } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const cache = "/home/u/.claude/plugins/cache/context-mode/context-mode/1.0.150";
      expect(deriveMarketplaceClonePath(cache)).toBe(
        resolve("/home/u/.claude/plugins/marketplaces/context-mode"),
      );
    });

it("deriveMarketplaceClonePath tolerates a trailing slash", async () => {
      const { deriveMarketplaceClonePath } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const cache = "/home/u/.claude/plugins/cache/context-mode/context-mode/1.0.150/";
      expect(deriveMarketplaceClonePath(cache)).toBe(
        resolve("/home/u/.claude/plugins/marketplaces/context-mode"),
      );
    });

it("deriveMarketplaceClonePath handles Windows-style backslashes", async () => {
      const { deriveMarketplaceClonePath } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const cache = "C:\\Users\\u\\.claude\\plugins\\cache\\context-mode\\context-mode\\1.0.150";
      const got = deriveMarketplaceClonePath(cache);
      // resolve() leaves the leading drive letter intact as a relative
      // segment on POSIX; the important assertion is the suffix.
      expect(String(got).replace(/\\/g, "/")).toMatch(
        /plugins\/marketplaces\/context-mode$/,
      );
    });

it("deriveMarketplaceClonePath returns null for non-CC layouts", async () => {
      const { deriveMarketplaceClonePath } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      expect(
        deriveMarketplaceClonePath("/usr/local/lib/node_modules/context-mode"),
      ).toBeNull();
      expect(
        deriveMarketplaceClonePath("/home/u/sultan-projects/context-mode"),
      ).toBeNull();
      expect(deriveMarketplaceClonePath(undefined)).toBeNull();
      expect(deriveMarketplaceClonePath(null)).toBeNull();
      expect(deriveMarketplaceClonePath("")).toBeNull();
    });
});
