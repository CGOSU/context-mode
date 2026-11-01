import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

it("upgrade fails explicitly when real SQLite verification fails, never trusting legacy file markers", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../src/cli.ts"), "utf8");
  const start = source.indexOf('// Verify the selected SQLite backend');
  const body = source.slice(start, source.indexOf('// Update global npm', start));
  expect(start).toBeGreaterThan(-1);
  expect(body).toContain("checkSqliteRuntime(pluginRoot)");
  expect(body).toContain("if (!health.ok) throw new Error(sqliteRemediation(health))");
  expect(body).toContain("process.exitCode = 1");
  expect(body).not.toContain("existsSync");
  expect(body).not.toContain("npmExecFile");
});
