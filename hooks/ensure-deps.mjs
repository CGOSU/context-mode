/** Read-only SQLite capability checks shared by hooks and start.mjs. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSqliteRuntime, sqliteRemediation } from "../scripts/sqlite-health.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function ensureNativeCompat(pluginRoot) {
  return checkSqliteRuntime(pluginRoot);
}

export async function ensureDeps(pluginRoot = root) {
  return ensureNativeCompat(pluginRoot);
}

const health = await ensureDeps();
if (!health.ok) throw new Error(sqliteRemediation(health));
