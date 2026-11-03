/** Executor regressions: executor-lifecycle. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { PolyglotExecutor } from "../src/executor.js";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe("Timeout Handling", () => {
  test("JS: infinite loop times out", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "while(true) {}",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  });

  // Issue #406 — when timeout omitted, no server-side timer fires and a
  // long-running process completes naturally. Caller (or MCP host) owns
  // the timeout policy.
  test("JS: no timeout — short script completes without forced kill", async () => {
    const r = await executor.execute({
      language: "javascript",
      // 250ms wait then print — caller didn't pass timeout, so we must
      // wait for natural exit, not kill at any heuristic ceiling.
      code: "setTimeout(() => { console.log('done'); }, 250);",
    });
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout.trim(), "done");
  });

  test("Shell: no timeout — sleep 1 completes without forced kill", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "sleep 1 && echo done",
    });
    assert.equal(r.timedOut, false);
    assert.equal(r.stdout.trim(), "done");
  });

  test("JS: infinite loop leaves no orphaned process after kill", async () => {
    // Spawn a process that writes its PID then loops forever
    const r = await executor.execute({
      language: "javascript",
      code: `process.stdout.write(String(process.pid)); while(true) {}`,
      timeout: 1000,
    });
    assert.equal(r.timedOut, true);
    const pid = parseInt(r.stdout.trim(), 10);
    assert.ok(pid > 0, `Expected valid PID in stdout, got: "${r.stdout}"`);
    // Give OS a moment to reap
    await new Promise(r => setTimeout(r, 200));
    let alive = false;
    try {
      process.kill(pid, 0); // signal 0 = check if alive
      alive = true;
    } catch { /* ESRCH = not found = good */ }
    assert.equal(alive, false, `Process ${pid} should be dead after timeout kill`);
  }, 10_000);

  test("JS: child processes are killed with parent (no orphans)", async () => {
    // Parent spawns a child that writes its PID to stderr, then both loop
    const code = `
      const { fork } = require("child_process");
      if (process.env.__CHILD__) {
        process.stderr.write(String(process.pid));
        while(true) {}
      } else {
        process.stdout.write(String(process.pid));
        const env = { ...process.env, __CHILD__: "1" };
        fork(process.argv[1], { env });
        while(true) {}
      }
    `;
    const r = await executor.execute({
      language: "javascript",
      code,
      timeout: 1500,
    });
    assert.equal(r.timedOut, true);
    const parentPid = parseInt(r.stdout.trim(), 10);
    const childPid = parseInt(r.stderr.trim(), 10);
    assert.ok(parentPid > 0, `Expected parent PID, got: "${r.stdout}"`);
    assert.ok(childPid > 0, `Expected child PID, got: "${r.stderr}"`);
    await new Promise(r => setTimeout(r, 200));
    for (const pid of [parentPid, childPid]) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; } catch {}
      assert.equal(alive, false, `Process ${pid} should be dead after group kill`);
    }
  }, 10_000);

  test("Shell: sleep times out", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "sleep 5",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  }, 10_000);

    test.runIf(runtimes.python)("Python: infinite sleep times out", async () => {
    const r = await executor.execute({
      language: "python",
      code: "import time; time.sleep(5)",
      timeout: 500,
    });
    assert.equal(r.timedOut, true);
  });
});


describe("Concurrent Execution", () => {
  test("5 concurrent JS executions", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      executor.execute({
        language: "javascript",
        code: `console.log("concurrent ${i}");`,
      }),
    );
    const all = await Promise.all(promises);
    for (const r of all) {
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("concurrent"));
    }
  });

  test("mixed language concurrent execution", async () => {
    const promises = [
      executor.execute({
        language: "javascript",
        code: 'console.log("js");',
      }),
      executor.execute({ language: "shell", code: 'echo "sh"' }),
    ];
    promises.push(
      executor.execute({ language: "python", code: 'print("py")' }),
    );
    const all = await Promise.all(promises);
    for (const r of all) {
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.trim().length > 0);
    }
  });
});


describe("Temp Cleanup Resilience", () => {
  test("concurrent executions all return valid results (EBUSY resilience)", async () => {
    const count = 15;
    const promises = Array.from({ length: count }, (_, i) =>
      executor.execute({
        language: "javascript",
        code: `
          const fs = require('fs');
          const path = require('path');
          for (let j = 0; j < 3; j++) {
            fs.writeFileSync(path.join(process.cwd(), 'f' + j + '.tmp'), 'data');
          }
          console.log("ok-${i}");
        `,
      }),
    );
    const results = await Promise.all(promises);
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      assert.equal(typeof r.exitCode, "number", `Execution ${i}: exitCode not a number`);
      assert.equal(typeof r.stdout, "string", `Execution ${i}: stdout not a string`);
      assert.equal(typeof r.stderr, "string", `Execution ${i}: stderr not a string`);
      assert.equal(typeof r.timedOut, "boolean", `Execution ${i}: timedOut not a boolean`);
      assert.equal(r.exitCode, 0, `Execution ${i} failed with stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes(`ok-${i}`), `Missing output for execution ${i}`);
    }
  });

  test("node runtime accessible from executor shell", async () => {
    // Use process.execPath rather than bare 'node' — snap/wrapper installs silently
    // exit 0 with no output when the snap wrapper is re-invoked as a subprocess.
    const r = await executor.execute({
      language: "shell",
      code: `"${process.execPath}" --version`,
    });
    assert.equal(r.exitCode, 0, `node not found in executor env, stderr: ${r.stderr}`);
    assert.ok(r.stdout.trim().startsWith("v"), `Expected version string, got: ${r.stdout}`);
  });
});


describe("Background Mode", () => {
  test("background: true returns partial output with backgrounded flag", async () => {
    const bgExecutor = new PolyglotExecutor({ runtimes });
    const r = await bgExecutor.execute({
      language: "javascript",
      code: `console.log("started"); setInterval(() => {}, 1000);`,
      timeout: 500,
      background: true,
    });
    assert.equal(r.backgrounded, true, "Should be marked as backgrounded");
    assert.equal(r.timedOut, true, "Background detach fires on timeout");
    assert.equal(r.exitCode, 0, "Backgrounded processes return exitCode 0");
    assert.ok(r.stdout.includes("started"), "Should capture output before detach");
    bgExecutor.cleanupBackgrounded();
  }, 10_000);

  test("cleanupBackgrounded kills detached process", async () => {
    const bgExecutor = new PolyglotExecutor({ runtimes });
    const r = await bgExecutor.execute({
      language: "javascript",
      code: `process.stdout.write(String(process.pid)); setInterval(() => {}, 1000);`,
      timeout: 500,
      background: true,
    });
    const pid = parseInt(r.stdout.trim(), 10);
    assert.ok(pid > 0, `Expected valid PID, got: "${r.stdout}"`);

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* ESRCH */ }
    assert.equal(alive, true, "Process should be alive before cleanup");

    bgExecutor.cleanupBackgrounded();
    await new Promise((r) => setTimeout(r, 300));

    alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* ESRCH */ }
    assert.equal(alive, false, `Process ${pid} should be dead after cleanup`);
  }, 10_000);

  test("background: true keeps process alive when it writes after detach", async () => {
    const bgExecutor = new PolyglotExecutor({ runtimes });
    const r = await bgExecutor.execute({
      language: "javascript",
      code: `
        process.stdout.write(String(process.pid));
        // Write every 200ms after detach (timeout is 300ms)
        const id = setInterval(() => {
          process.stdout.write('alive\\n');
        }, 200);
        // Keep alive for 3 seconds total
        setTimeout(() => { clearInterval(id); process.exit(0); }, 3000);
      `,
      timeout: 300,
      background: true,
    });
    const pid = parseInt(r.stdout.trim(), 10);
    assert.ok(pid > 0, `Expected valid PID, got: "${r.stdout}"`);

    // Give the process time to write after detach
    await new Promise((r) => setTimeout(r, 1000));

    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* ESRCH */ }
    assert.equal(alive, true, `Process ${pid} should still be alive after detach (SIGPIPE bug?)`);

    bgExecutor.cleanupBackgrounded();
  }, 10_000);
});
