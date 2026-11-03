import { describe, it, expect } from "vitest";

import { readFileSync, existsSync, writeFileSync, rmSync, symlinkSync, lstatSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";




import { setupPartialInstallFixture } from "../helpers/partial-install.js";

const ROOT = resolve(import.meta.dirname, "../..");

describe("hooks/heal-partial-install.mjs (containment)", () => {
const { makeTmp, buildFakeLayout, readJson } = setupPartialInstallFixture();
it("healPartialInstallFromMarketplace refuses to heal when pluginRoot equals marketplaceClonePath", async () => {
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { marketplaceClonePath } = buildFakeLayout();
      // Force the probe to trip by stripping start.mjs from the
      // marketplace itself, then point pluginRoot at it.
      rmSync(join(marketplaceClonePath, "start.mjs"));
      const result = healPartialInstallFromMarketplace({
        pluginRoot: marketplaceClonePath,
        marketplaceClonePath,
        log: false,
      });
      expect(result.skipped).toBe("same-as-marketplace");
    });

it("healPartialInstallFromMarketplace rejects files[] entries that escape rootDir via ..", async () => {
      // Regression guard for PR #699 review: a corrupted marketplace
      // package.json with `files: ["../outside.txt", ...]` must not
      // turn the self-heal into an out-of-root write. Seed an
      // `outside.txt` in the marketplace's parent dir, point a files[]
      // entry at it via ..-escape, and assert nothing lands outside
      // pluginRoot.
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Write a sentinel file in the marketplace's parent dir — the
      // ..-escape target. If the guard fails, the heal would copy this
      // into pluginRoot's parent.
      const marketplaceParent = dirname(marketplaceClonePath);
      const escapeTargetPath = join(marketplaceParent, "OUTSIDE-MARKER.txt");
      writeFileSync(escapeTargetPath, "should-not-be-copied\n");

      // Repoint marketplace package.json's files[] to include an
      // escape entry alongside legitimate entries.
      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "context-mode",
          version: "1.0.150",
          files: ["../OUTSIDE-MARKER.txt", "hooks", "start.mjs", "cli.bundle.mjs", "server.bundle.mjs", ".claude-plugin"],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The escape entry must not appear anywhere the heal acted on.
      expect(result.healed).not.toContain("../OUTSIDE-MARKER.txt");
      expect(result.healed).not.toContain("OUTSIDE-MARKER.txt");
      expect(result.stillMissing).not.toContain("../OUTSIDE-MARKER.txt");
      // Nothing got written to pluginRoot's parent.
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "OUTSIDE-MARKER.txt"))).toBe(false);
      // The legitimate entries still healed.
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
    });

it("healPartialInstallFromMarketplace rejects nested ..-escape entries (e.g. 'a/../../outside')", async () => {
      // Mixed-segment escape: even when the entry starts with a
      // legitimate-looking segment, path normalization collapses the
      // ..'s and resolves outside rootDir. Guard must catch it.
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      const marketplaceParent = dirname(marketplaceClonePath);
      const escapeTargetPath = join(marketplaceParent, "NESTED-OUTSIDE.txt");
      writeFileSync(escapeTargetPath, "should-not-be-copied\n");

      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "context-mode",
          version: "1.0.150",
          files: ["hooks/../../NESTED-OUTSIDE.txt", "start.mjs"],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      expect(result.healed.some((p: string) => p.includes("NESTED-OUTSIDE"))).toBe(false);
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "NESTED-OUTSIDE.txt"))).toBe(false);
      expect(result.healed).toContain("start.mjs");
    });

it("healPartialInstallFromMarketplace replaces a planted leaf symlink at the destination instead of writing through it", async () => {
      // Arbitrary-file-write primitive surfaced by the second
      // adversarial review: a stale heal leftover or a local attacker
      // plants `pluginRoot/server.bundle.mjs` as a symlink to an
      // out-of-tree target that doesn't exist yet. existsSync follows
      // the dangling link and returns false, so the probe trips and
      // the file lands in missingBefore. Without the lstat+unlink
      // guard at the copy site, cpSync follows the symlink and writes
      // marketplace bytes (arbitrary JS) to the target outside
      // pluginRoot. The guard must replace the symlink with a fresh
      // regular file before cpSync runs.
      const { healPartialInstallFromMarketplace, isPartialInstall } =
        await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Dangling target outside pluginRoot, must stay un-created.
      const pluginRootParent = dirname(pluginRoot);
      const escapeTargetPath = join(
        pluginRootParent,
        "OUT-OF-ROOT-MUST-NOT-EXIST.txt",
      );
      expect(existsSync(escapeTargetPath)).toBe(false);

      // Plant the symlink at the launch-critical leaf so the probe
      // trips on it (existsSync on a dangling link returns false).
      symlinkSync(escapeTargetPath, join(pluginRoot, "server.bundle.mjs"));
      expect(
        lstatSync(join(pluginRoot, "server.bundle.mjs")).isSymbolicLink(),
      ).toBe(true);
      expect(isPartialInstall(pluginRoot)).toBe(true);

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The symlink target must not have been materialized: no
      // arbitrary write happened outside pluginRoot.
      expect(existsSync(escapeTargetPath)).toBe(false);
      // The leaf is now a regular file with marketplace bytes, not a
      // dangling symlink.
      const stTo = lstatSync(join(pluginRoot, "server.bundle.mjs"));
      expect(stTo.isSymbolicLink()).toBe(false);
      expect(stTo.isFile()).toBe(true);
      expect(
        readFileSync(join(pluginRoot, "server.bundle.mjs"), "utf-8"),
      ).toBe("// server bundle\n");
      // The heal records the file as healed, and the probe agrees
      // we're healthy.
      expect(result.healed).toContain("server.bundle.mjs");
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });

it("healPartialInstallFromMarketplace rejects deep files[] entries reached through a symlinked ancestor in the marketplace tree", async () => {
      // Ancestor-symlink bypass surfaced by the third adversarial
      // review: lstat(from) on a deep leaf returns isSymbolicLink=false
      // when the symlink is in a PARENT segment, not the leaf itself.
      // The lexical resolve+startsWith guard also doesn't catch it,
      // since the symlink's own lexical path stays inside the
      // marketplace tree. Only realpath(from) collapses the ancestor
      // symlink and exposes the escape. Without this guard, cpSync
      // would read attacker-staged content through the ancestor link
      // and copy it into pluginRoot, where the next session start
      // would execute the planted bytes (e.g. scripts/postinstall.mjs).
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Stage attacker-controlled bytes outside the marketplace tree.
      const attackerRoot = mkdtempSync(join(tmpdir(), "ancestor-attack-"));
      writeFileSync(
        join(attackerRoot, "postinstall.mjs"),
        "// ATTACKER PAYLOAD\n",
      );

      // Replace marketplace/scripts/ (a real dir set up by
      // buildFakeLayout) with a symlink to the attacker-staged dir.
      // The lexical resolve check on `from` passes because the
      // symlink's path stays inside marketplaceClonePath; only
      // realpath collapses through it.
      rmSync(join(marketplaceClonePath, "scripts"), {
        recursive: true,
        force: true,
      });
      symlinkSync(attackerRoot, join(marketplaceClonePath, "scripts"));

      // package.json references the deep leaf through the
      // now-symlinked ancestor. lstat(from).isSymbolicLink() === false
      // because the leaf is a real file at the symlink target.
      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "context-mode",
          version: "1.0.150",
          files: [
            "scripts/postinstall.mjs",
            "hooks",
            ".claude-plugin",
            "start.mjs",
            "cli.bundle.mjs",
            "server.bundle.mjs",
          ],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // The ancestor-symlinked entry must not appear in healed, and
      // pluginRoot must not contain the attacker payload at the
      // resolved-through-ancestor path.
      expect(result.healed).not.toContain("scripts/postinstall.mjs");
      const planted = join(pluginRoot, "scripts", "postinstall.mjs");
      if (existsSync(planted)) {
        expect(readFileSync(planted, "utf-8")).not.toBe(
          "// ATTACKER PAYLOAD\n",
        );
      }
      // Legitimate non-symlinked entries still healed (sanity).
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
    });

it("healPartialInstallFromMarketplace rejects symlink entries that escape rootDir", async () => {
      // Symlink-based bypass for the ..-escape resolve+startsWith
      // guard: the symlink itself sits inside marketplaceClonePath, so
      // its lexical resolve stays inside rootDir, but the symlink
      // target points outside. Reading through the link would expose
      // arbitrary host filesystem content to the heal. expandFilesArray
      // and listFilesRecursive must drop symlinks via lstatSync.
      const { healPartialInstallFromMarketplace } = await import(
        "../../hooks/heal-partial-install.mjs"
      );
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      // Sentinel outside the marketplace tree.
      const marketplaceParent = dirname(marketplaceClonePath);
      const sentinelPath = join(marketplaceParent, "SYMLINK-TARGET.txt");
      writeFileSync(sentinelPath, "should-not-leak\n");

      // Top-level symlink-to-outside file at marketplace root.
      const topLink = join(marketplaceClonePath, "evil-link.txt");
      symlinkSync(sentinelPath, topLink);

      // Symlink-to-outside hidden inside a legitimate-looking dir,
      // so listFilesRecursive's walk has to drop it too.
      const nestedDir = join(marketplaceClonePath, "scripts");
      const nestedLink = join(nestedDir, "evil-nested.txt");
      symlinkSync(sentinelPath, nestedLink);

      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "context-mode",
          version: "1.0.150",
          // "scripts" is a directory walk; "evil-link.txt" is a
          // top-level symlink entry. Both should be filtered.
          files: [
            "evil-link.txt",
            "scripts",
            "hooks",
            "start.mjs",
            "cli.bundle.mjs",
            "server.bundle.mjs",
            ".claude-plugin",
          ],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // Neither the top-level nor the nested symlink can appear in
      // healed; nothing got materialized at pluginRoot for them either.
      expect(result.healed).not.toContain("evil-link.txt");
      expect(result.healed.some((p: string) => p.includes("evil-nested"))).toBe(false);
      expect(existsSync(join(pluginRoot, "evil-link.txt"))).toBe(false);
      expect(existsSync(join(pluginRoot, "scripts", "evil-nested.txt"))).toBe(false);

      // Legitimate scripts entries still healed (the symlink dropped
      // out, but the regular files in scripts/ stayed). Use join() so
      // Windows backslash and POSIX forward-slash both match the
      // OS-native paths listFilesRecursive emits.
      expect(result.healed).toContain(join("scripts", "postinstall.mjs"));
      expect(result.healed).toContain(join("scripts", "plugin-cache-integrity.mjs"));
      // Sentinel content was never copied anywhere in pluginRoot.
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "SYMLINK-TARGET.txt"))).toBe(false);
    });

it("healPartialInstallFromMarketplace keeps valid entries when escape entries are mixed in", async () => {
      // The escape guard must drop only the bad entries, leaving valid
      // ones in the manifest. Otherwise a single corrupt entry would
      // poison the whole heal.
      const { healPartialInstallFromMarketplace, isPartialInstall } =
        await import("../../hooks/heal-partial-install.mjs");
      const { pluginRoot, marketplaceClonePath } = buildFakeLayout();

      const marketplaceParent = dirname(marketplaceClonePath);
      writeFileSync(join(marketplaceParent, "POISON.txt"), "x");

      writeFileSync(
        join(marketplaceClonePath, "package.json"),
        JSON.stringify({
          name: "context-mode",
          version: "1.0.150",
          files: [
            "../POISON.txt",
            "hooks",
            ".claude-plugin",
            "start.mjs",
            "cli.bundle.mjs",
            "server.bundle.mjs",
            "scripts/postinstall.mjs",
            "scripts/plugin-cache-integrity.mjs",
            "bin",
          ],
        }),
      );

      const result = healPartialInstallFromMarketplace({
        pluginRoot,
        marketplaceClonePath,
        log: false,
      });

      // Every valid entry healed.
      expect(result.healed).toContain("start.mjs");
      expect(result.healed).toContain("cli.bundle.mjs");
      expect(result.healed).toContain("server.bundle.mjs");
      // No escape side effect.
      const pluginRootParent = dirname(pluginRoot);
      expect(existsSync(join(pluginRootParent, "POISON.txt"))).toBe(false);
      // The probe agrees we're healthy after the heal (the legitimate
      // launch-critical files all landed).
      expect(isPartialInstall(pluginRoot)).toBe(false);
    });
});
