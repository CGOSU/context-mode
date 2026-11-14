import * as path from "node:path";

const WORKSPACE_ENV_CANDIDATES = [
  "PI_WORKSPACE_DIR",
  "PI_PROJECT_DIR",
  "CONTEXT_MODE_PROJECT_DIR",
] as const;

/**
 * Detect whether a path lives inside an agent plugin install tree.
 */
export function isPluginInstallPath(p: string): boolean {
  if (!p) return false;
  return /[/\\]\.(claude|codex)[/\\]plugins[/\\](cache|marketplaces)[/\\]/.test(p);
}

/**
 * Resolve the active Pi project directory without scanning other agents'
 * transcripts or inheriting foreign workspace environment variables.
 *
 * Resolution order:
 *   1. PI_WORKSPACE_DIR / PI_PROJECT_DIR / CONTEXT_MODE_PROJECT_DIR
 *   2. `pwd` (process.env.PWD, when not inside a plugin install path)
 *   3. `cwd` (process.cwd())
 */
export function resolveProjectDir(opts: {
  env: Record<string, string | undefined>;
  cwd: string;
  pwd: string | undefined;
}): string {
  const { env, cwd, pwd } = opts;
  for (const name of WORKSPACE_ENV_CANDIDATES) {
    const v = env[name];
    if (v && !isPluginInstallPath(v)) return path.normalize(v) === v ? v : v;
  }
  if (pwd && !isPluginInstallPath(pwd)) return pwd;
  return cwd;
}
