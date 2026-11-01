import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { checkBetterSqlite3, probeSqlite } from "../../scripts/sqlite-health.mjs";
import { healBetterSqlite3Binding } from "../../scripts/heal-better-sqlite3.mjs";

const roots: string[] = [];
function fixture(source?: string) {
  const root = mkdtempSync(join(tmpdir(), "sqlite-health-test-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), "{}");
  if (source !== undefined) {
    const pkg = join(root, "node_modules/better-sqlite3");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ main: "index.cjs" }));
    writeFileSync(join(pkg, "index.cjs"), source);
  }
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("read-only SQLite health", () => {
  it("loads the real bundled native binary and verifies FTS5 read/write", () => {
    expect(checkBetterSqlite3(resolve(import.meta.dirname, "../.."))).toEqual({
      ok: true, backend: "better-sqlite3",
    });
  });

  it.each([
    [undefined, "package-missing"],
    ['throw new Error("unsupported platform");', "module-load-failed"],
    ['module.exports = class { constructor() { throw new Error("missing binary"); } };', "sqlite-capability-failed"],
  ])("reports %s without installing, compiling or mutating files", (source, code) => {
    const root = fixture(source);
    const before = readdirSync(root, { recursive: true });
    const forbidden = ["execSync", "execFileSync", "spawnSync", "spawn", "exec", "execFile"] as const;
    const spies = forbidden.map(name => vi.spyOn(childProcess, name).mockImplementation(() => {
      throw new Error("Unexpected child process during health check");
    }));
    syncBuiltinESMExports();
    const result = healBetterSqlite3Binding(root);
    expect(result).toMatchObject({ ok: false, code });
    expect(result.message).toBeTruthy();
    expect(readdirSync(root, { recursive: true })).toEqual(before);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects missing FTS5 and closes the transient database", () => {
    let closed = false;
    class WithoutFts {
      exec() { throw new Error("no such module: fts5"); }
      close() { closed = true; }
    }
    expect(probeSqlite(WithoutFts, "test")).toMatchObject({ ok: false, code: "sqlite-capability-failed" });
    expect(closed).toBe(true);
  });

  it("does not report success when a query returns incorrect data", () => {
    class BrokenQuery {
      exec() {}
      prepare() { return { run() {}, get() { return { value: "wrong" }; } }; }
      close() {}
    }
    expect(probeSqlite(BrokenQuery, "test")).toMatchObject({ ok: false, code: "sqlite-capability-failed" });
  });
});
