/** Each caller owns its own temporary directories and afterEach cleanup. */
import { afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function useCacheHealFixtures() {
  const cleanups: string[] = [];

  afterEach(() => {
    while (cleanups.length) {
      const dir = cleanups.pop();
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    }
  });

  /** Create a tracked temp directory; auto-cleaned in afterEach. */
  function makeTmp(prefix = "ctx-cache-heal-"): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(dir);
    return dir;
  }

  /** Pretty-write JSON with trailing newline (matches settings.json convention). */
  function writeJson(path: string, value: unknown): void {
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf-8");
  }

  return { makeTmp, writeJson };
}
