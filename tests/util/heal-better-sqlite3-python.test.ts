/** The retired native compiler repair must not reappear under conda. */
import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { healBetterSqlite3Binding } from "../../scripts/heal-better-sqlite3.mjs";

it("missing dependencies remain a clear failure without modifying the conda environment", () => {
  const root = mkdtempSync(join(tmpdir(), "sqlite-conda-test-"));
  vi.stubEnv("CONDA_PREFIX", "/opt/anaconda3");
  vi.stubEnv("PYTHON", "/opt/anaconda3/bin/python3");
  const before = { ...process.env };
  try {
    expect(healBetterSqlite3Binding(root)).toMatchObject({ ok: false, code: "package-missing" });
    expect(process.env).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
