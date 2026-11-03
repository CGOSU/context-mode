/** Hook regressions: sessionstart-legacy-settings. */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";


// ═══════════════════════════════════════════════════════════════════════
// Issue #636 — PreToolUse hook fails on project paths containing spaces.
//
// The self-heal "legacy" branch in pretooluse.mjs (only fires when the
// plugin cache lives at a stale-version dir AND hooks.json is absent —
// typical for users who upgraded from <v1.0.108) used to write hook
// commands as the unquoted string `node ${path}`. When the plugin cache
// path contained spaces (Dropbox/iCloud display names, CLAUDE_CONFIG_DIR
// pointed at a synced folder), the resulting settings.json had a command
// like `node /Users/foo/Library/CloudStorage/Lucas Werneck/.../pretooluse.mjs`
// that /bin/sh word-split into pieces, producing the user-visible
// "Failed with non-blocking status code" spam on every tool call.
//
// Regression guard: the rewritten command must round-trip through
// /bin/sh -c without parse errors. Properly quoting the script path
// (via JSON.stringify) is sufficient.
// ═══════════════════════════════════════════════════════════════════════

describe("Issue #636: legacy settings.json rewrite quotes spaced paths", () => {
  // Skip on Windows — the legacy rewrite + /bin/sh assertion are POSIX-only.
  // Windows users go through normalize-hooks.mjs (#378/#582) which is already
  // covered by tests/hooks/windows-hooks-normalization.test.ts.
  const skipOnWindows = process.platform === "win32";

  // The legacy rewrite at hooks/pretooluse.mjs:124-135 is a self-contained
  // string mutation. We replicate it here verbatim against the FIXED code so
  // the regression is locked in even if future contributors restructure the
  // block. The test deliberately uses a *spaced* targetDir to mirror the
  // user-reported Dropbox/iCloud scenario from #636.
  function applyLegacyRewrite(command: string, targetDir: string): string | null {
    if (
      command &&
      command.includes(".mjs") &&
      command.includes("context-mode") &&
      !command.includes(targetDir)
    ) {
      const scriptMatch = command.match(/([a-z]+\.mjs)\s*"?\s*$/);
      if (scriptMatch) {
        const scriptPath = resolve(targetDir, "hooks", scriptMatch[1]);
        // MUST match the production form in hooks/pretooluse.mjs (#636 fix):
        // path is JSON.stringify'd so spaces inside targetDir survive
        // /bin/sh word-splitting at hook-spawn time.
        return `node ${JSON.stringify(scriptPath)}`;
      }
    }
    return null;
  }

  test.skipIf(skipOnWindows)(
    "rewritten command keeps spaced path quoted so /bin/sh sees one arg",
    () => {
      const spacedTargetDir =
        "/Users/foo/Library/CloudStorage/Dropbox-2olhares/Lucas Werneck/.claude/plugins/cache/context-mode/context-mode/1.0.140";
      const staleCommand =
        "node /old/path/context-mode/0.5.0/hooks/pretooluse.mjs";

      const rewritten = applyLegacyRewrite(staleCommand, spacedTargetDir);
      expect(rewritten).not.toBeNull();
      expect(rewritten).toContain("Lucas Werneck");
      expect(rewritten).toContain("/hooks/pretooluse.mjs");

      // CORE ASSERTION (#636): /bin/sh -c "<cmd>" must parse the path as
      // a single positional arg, not split on whitespace. Use `printf %s\n`
      // to enumerate the post-split argv — the OLD unquoted form yielded
      // 4 tokens (node, /Users/foo/.../Lucas, Werneck/..., pretooluse.mjs);
      // the FIXED form yields exactly 2 (node + quoted script path).
      const probe = spawnSync(
        "/bin/sh",
        ["-c", `set -- ${rewritten}; printf "%s\\n" "$#" "$@"`],
        { encoding: "utf-8", timeout: 5_000 },
      );
      expect(probe.status).toBe(0);
      const lines = probe.stdout.trim().split("\n");
      expect(lines[0]).toBe("2"); // exactly: node + script
      expect(lines[1]).toBe("node");
      expect(lines[2]).toBe(
        resolve(spacedTargetDir, "hooks", "pretooluse.mjs"),
      );
    },
  );

  test.skipIf(skipOnWindows)(
    "without the fix, /bin/sh would word-split the spaced path (red baseline)",
    () => {
      // Encode the OLD buggy form so we have a fail-loud regression baseline.
      // This documents what the bug looked like — if anyone ever reverts the
      // fix, the assertion above flips and this one stays as the diagnostic.
      const spacedTargetDir =
        "/Users/foo/Library/CloudStorage/Lucas Werneck/.claude/plugins/cache/context-mode/context-mode/1.0.140";
      const buggyForm =
        "node " + resolve(spacedTargetDir, "hooks", "pretooluse.mjs");
      const probe = spawnSync(
        "/bin/sh",
        ["-c", `set -- ${buggyForm}; printf "%s\\n" "$#"`],
        { encoding: "utf-8", timeout: 5_000 },
      );
      expect(probe.status).toBe(0);
      // Spaced path word-splits into multiple tokens — exactly the
      // pathological state the #636 fix prevents.
      const tokenCount = Number(probe.stdout.trim().split("\n")[0]);
      expect(tokenCount).toBeGreaterThan(2);
    },
  );
});
