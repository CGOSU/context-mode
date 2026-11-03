/** Fresh-process probes shared by routing and security-warning regressions. */
import { resolve } from "node:path";

/**
 * Helper — spawn a fresh node subprocess and run a small ESM snippet
 * against routing.mjs. Returns parsed stdout JSON. Each call is
 * isolated (no shared module state) so the global securityInitFailed
 * flag starts false in every test.
 */
export const SLICE4_DIRNAME = (() => {
  // ESM-safe __dirname for the slice 4 helpers (vitest's main file
  // doesn't have one). Lazily evaluated to avoid touching top-level state.
  const { fileURLToPath } = require("node:url");
  const { dirname } = require("node:path");
  return dirname(fileURLToPath(import.meta.url));
})();


export function routingUrl(): string {
  const path = resolve(SLICE4_DIRNAME, "..", "..", "hooks", "core", "routing.mjs");
  // pathToFileURL handles Windows drive letters correctly.
  const { pathToFileURL } = require("node:url");
  return JSON.stringify(pathToFileURL(path).href);
}


export async function spawnRoutingProbe(
  code: string,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; parsed: any }> {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  const stdout = (r.stdout ?? "").trim();
  let parsed: any = null;
  try { parsed = JSON.parse(stdout); } catch { /* surface raw */ }
  return { status: r.status, stdout, parsed };
}


export async function spawnPreToolUseHook(
  input: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; parsed: any }> {
  const { spawnSync } = await import("node:child_process");
  const repoRoot = resolve(SLICE4_DIRNAME, "..", "..");
  const r = spawnSync(process.execPath, ["hooks/pretooluse.mjs"], {
    cwd: repoRoot,
    input: JSON.stringify(input),
    encoding: "utf-8",
    timeout: 15_000,
    env: { ...process.env, ...env },
  });
  const stdout = (r.stdout ?? "").trim();
  let parsed: any = null;
  try { parsed = JSON.parse(stdout); } catch { /* surface raw */ }
  return { status: r.status, stdout, parsed };
}
