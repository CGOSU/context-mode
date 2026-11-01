import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi entry loads with production dependencies and no other build files", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "context-mode-pi-install-"));
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    writeFileSync(join(sandbox, "package.json"), JSON.stringify({ type: "module" }));
    for (const name of Object.keys(pkg.dependencies)) {
      const target = join(sandbox, "node_modules", name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(join(root, "node_modules", name), target, "junction");
    }
    for (const entry of pkg.pi.extensions) {
      const target = join(sandbox, entry);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, entry), target);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import assert from 'node:assert/strict'; const entry = await import(${JSON.stringify(entry)}); assert.equal(typeof entry.default, 'function');`,
      ], { cwd: sandbox, encoding: "utf8" });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
