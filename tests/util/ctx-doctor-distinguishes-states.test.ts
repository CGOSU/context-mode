import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

it("doctor counts SQLite load/capability errors as failures rather than skipping them", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../../src/cli.ts"), "utf8");
  const start = source.indexOf("Checking FTS5 / SQLite");
  const error = source.indexOf("catch (err: unknown)", start);
  const end = source.indexOf("// Version check", error);
  const body = source.slice(error, end);
  expect(body).toContain("criticalFails++");
  expect(body).toContain("p.log.error");
  expect(body).not.toContain("SKIP");
  expect(body).not.toContain("npm rebuild");
  expect(body).not.toContain("npm install better-sqlite3");
});
