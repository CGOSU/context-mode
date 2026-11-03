/** Executor regressions: executor-shell. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PolyglotExecutor } from "../src/executor.js";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe("Shell Execution", () => {
  test("Shell: hello world", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "hello from shell"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from shell"));
  });

  test("Shell: pipes + sort", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'printf "banana\\napple\\ncherry" | sort',
    });
    assert.equal(r.exitCode, 0);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines[0], "apple");
    assert.equal(lines[1], "banana");
    assert.equal(lines[2], "cherry");
  });

  test("Shell: arithmetic + variables", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'X=10\nY=20\necho "sum: $((X + Y))"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test.runIf(process.platform !== "win32")(
    "shell restores inherited PATH after startup clobbers it",
    async () => {
      const originalPath = process.env.PATH;
      const testDir = join(tmpdir(), `ctx-path-${process.pid}-${Date.now()}`);
      const binDir = join(testDir, "bin");
      const fakeBin = join(binDir, "ctx-path-probe");
      const fakeShell = join(testDir, "sh");

      try {
        mkdirSync(binDir, { recursive: true });
        writeFileSync(fakeBin, "#!/bin/sh\nprintf 'probe-ok\\n'\n", { mode: 0o755 });
        writeFileSync(
          fakeShell,
          "#!/bin/sh\nPATH=/usr/bin:/bin\nexport PATH\nexec /bin/sh \"$@\"\n",
          { mode: 0o755 },
        );
        process.env.PATH = `${binDir}:${originalPath ?? ""}`;

        const pathClobberingShell = new PolyglotExecutor({
          runtimes: { ...runtimes, shell: fakeShell },
        });
        const r = await pathClobberingShell.execute({
          language: "shell",
          code: "command -v ctx-path-probe\nctx-path-probe",
          timeout: 5_000,
        });

        assert.equal(r.exitCode, 0, r.stderr);
        assert.ok(r.stdout.includes(fakeBin), `Expected ${fakeBin}, got: ${r.stdout}`);
        assert.ok(r.stdout.includes("probe-ok"), `Got: ${r.stdout}`);
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(testDir, { recursive: true, force: true });
      }
    },
  );

  test("shell TMPDIR points to sandbox temp dir, not project root", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "$TMPDIR"',
      timeout: 5_000,
    });
    const reported = r.stdout.trim();
    assert.ok(
      !reported.startsWith(process.cwd()),
      `TMPDIR should not be project root, got: ${reported}`,
    );
    assert.ok(
      reported.includes(".ctx-mode-"),
      `TMPDIR should be the sandbox temp dir, got: ${reported}`,
    );
  });

  test("shell TMPDIR works cross-platform (not just echo)", async () => {
    // Use a command that writes to TMPDIR to verify it's writable
    const r = await executor.execute({
      language: "shell",
      code: 'touch "$TMPDIR/ctx-test-file" && echo "ok"',
      timeout: 5_000,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim() === "ok");
  });

  test("Shell: for loop + wc", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'for i in 1 2 3 4 5; do echo "item $i"; done | wc -l | tr -d " "',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim() === "5");
  });

  test("Shell: awk processing", async () => {
    const r = await executor.execute({
      language: "shell",
      code: `printf "Alice 30\\nBob 25\\nCharlie 35" | awk '{sum += $2; count++} END {print "avg:", sum/count}'`,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("avg: 30"));
  });
});
