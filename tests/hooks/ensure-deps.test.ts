import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { probeSqlite } from "../../scripts/sqlite-health.mjs";

let builtinAvailable = false;
try {
  const require = createRequire(import.meta.url);
  builtinAvailable = probeSqlite(require("node:sqlite").DatabaseSync, "node:sqlite").ok;
} catch { /* Older supported Node builds may need the native fallback. */ }

const repo = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
function stage(native: boolean) {
  const root = mkdtempSync(join(tmpdir(), "ensure-deps-test-"));
  roots.push(root);
  for (const dir of ["scripts", "hooks", "node_modules"]) mkdirSync(join(root, dir));
  copyFileSync(join(repo, "scripts/sqlite-health.mjs"), join(root, "scripts/sqlite-health.mjs"));
  copyFileSync(join(repo, "hooks/ensure-deps.mjs"), join(root, "hooks/ensure-deps.mjs"));
  writeFileSync(join(root, "package.json"), "{}");
  if (native) symlinkSync(join(repo, "node_modules/better-sqlite3"), join(root, "node_modules/better-sqlite3"), "junction");
  return root;
}
function run(root: string, nativeOnly = false) {
  return spawnSync(process.execPath, [
    ...(nativeOnly ? ["--no-experimental-sqlite"] : []),
    "--input-type=module", "-e",
    'const { ensureDeps } = await import("./hooks/ensure-deps.mjs"); console.log(JSON.stringify(await ensureDeps()));',
  ], { cwd: root, encoding: "utf8", timeout: 15000 });
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it("uses the shipped native binary when built-in SQLite is unavailable", () => {
  const result = run(stage(true), true);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, backend: "better-sqlite3" });
});

it.skipIf(!builtinAvailable)("uses working built-in SQLite without requiring a native package", () => {
  const result = run(stage(false));
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, backend: "node:sqlite" });
});

it("fails explicitly for missing dependencies, without installing them", () => {
  const root = stage(false);
  const result = run(root, true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("package-missing");
  expect(result.stderr).toContain("No automatic install or compilation");
});

it("never trusts or overwrites stale ABI cache files", () => {
  const root = stage(false);
  const release = join(root, "node_modules/better-sqlite3/build/Release");
  mkdirSync(release, { recursive: true });
  const cache = join(release, `better_sqlite3.abi${process.versions.modules}.node`);
  const active = join(release, "better_sqlite3.node");
  writeFileSync(cache, "old cached binary");
  writeFileSync(active, "incompatible binary");
  const result = run(root, true);
  expect(result.status).not.toBe(0);
  expect(readFileSync(active, "utf8")).toBe("incompatible binary");
  expect(readFileSync(cache, "utf8")).toBe("old cached binary");
});
