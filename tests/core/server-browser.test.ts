/** Server regressions: browser. */


import { describe, test, expect } from "vitest";
// ═══════════════════════════════════════════════════════════════════════════
// ctx_insight process helpers (formerly tests/core/process-utils.test.ts)
//
// Behavioral tests for browserOpenArgv / openBrowserSync / killProcessOnPort
// (canonical home: src/server.ts). PR #452 review flagged that source-grep
// tests pin implementation strings, not the actual security property. These
// tests mock spawnSync directly and assert:
//
//   - argv arrays only — never `shell: true`
//   - per-platform fallback semantics (xdg-open → sensible-browser)
//   - Windows netstat parser anchors on LISTENING + local-address column
//   - per-pid kill failures do not abort the remaining loop
//   - structured results surface failure to callers
// ═══════════════════════════════════════════════════════════════════════════

import { vi } from "vitest";
import { browserOpenArgv, openBrowserSync, killProcessOnPort, type SpawnSyncFn } from "../../src/server.js";


type Captured = { cmd: string; args: readonly string[]; opts: unknown };

type FakeReturn = { status: number | null; stdout?: string; error?: Error };


function makeRunner(
  responses: Array<FakeReturn | ((cmd: string, args: readonly string[]) => FakeReturn)>,
): { runner: SpawnSyncFn; calls: Captured[] } {
  const calls: Captured[] = [];
  let i = 0;
  const runner: SpawnSyncFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const next = responses[i++];
    const r = typeof next === "function" ? next(cmd, args) : next;
    return {
      pid: 0,
      output: [],
      stdout: r?.stdout ?? "",
      stderr: "",
      status: r?.status ?? 0,
      signal: null,
      error: r?.error,
    } as ReturnType<SpawnSyncFn>;
  };
  return { runner, calls };
}


describe("browserOpenArgv", () => {
  test("darwin → open url", () => {
    expect(browserOpenArgv("http://x", "darwin")).toEqual([
      { cmd: "open", args: ["http://x"] },
    ]);
  });

  test("win32 → cmd /c start with empty title", () => {
    // The empty-string title arg is the security-relevant detail: if it were
    // dropped, `start "http://attacker?evil=1"` would be parsed as a window
    // title rather than a URL.
    expect(browserOpenArgv("http://x", "win32")).toEqual([
      { cmd: "cmd", args: ["/c", "start", "", "http://x"] },
    ]);
  });

  test("linux → xdg-open then sensible-browser fallback", () => {
    expect(browserOpenArgv("http://x", "linux")).toEqual([
      { cmd: "xdg-open", args: ["http://x"] },
      { cmd: "sensible-browser", args: ["http://x"] },
    ]);
  });

  test("argv contains url as a single argument — no shell metachar expansion", () => {
    // A URL with shell metachars must appear verbatim as one argv entry on
    // every platform. If it were ever interpolated into a shell string, the
    // `; rm -rf /` would split into a separate command.
    const evil = "http://x; rm -rf /; #";
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const attempts = browserOpenArgv(evil, platform);
      for (const { args } of attempts) {
        expect(args).toContain(evil);
      }
    }
  });
});


describe("openBrowserSync", () => {
  test("darwin: spawnSync('open', [url]) with no shell:true", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    const r = openBrowserSync("http://x", "darwin", runner);

    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("open");
    expect(calls[0].args).toEqual(["http://x"]);
    expect(calls[0].opts).not.toHaveProperty("shell", true);
  });

  test("win32: cmd /c start '' url, no shell:true", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    openBrowserSync("http://x", "win32", runner);

    expect(calls[0].cmd).toBe("cmd");
    expect(calls[0].args).toEqual(["/c", "start", "", "http://x"]);
    expect(calls[0].opts).not.toHaveProperty("shell", true);
  });

  test("linux: xdg-open status=0 → sensible-browser is NOT called", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("xdg-open");
    expect(calls.map(c => c.cmd)).toEqual(["xdg-open"]);
  });

  test("linux: xdg-open status!=0 → sensible-browser fallback fires", () => {
    const { runner, calls } = makeRunner([
      { status: 3 },
      { status: 0 },
    ]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.method).toBe("sensible-browser");
    expect(calls.map(c => c.cmd)).toEqual(["xdg-open", "sensible-browser"]);
  });

  test("linux: xdg-open killed by signal (status=null + error) → fallback fires", () => {
    // The pre-fix bug: status===null was treated as success. Verify both
    // signal-kill and ENOENT trigger the fallback.
    const { runner, calls } = makeRunner([
      { status: null, error: new Error("Killed by signal") },
      { status: 0 },
    ]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(true);
    expect(calls.map(c => c.cmd)).toEqual(["xdg-open", "sensible-browser"]);
  });

  test("linux: both xdg-open and sensible-browser fail → ok=false with reason", () => {
    const { runner } = makeRunner([
      { status: 1, error: new Error("ENOENT xdg-open") },
      { status: 1, error: new Error("ENOENT sensible-browser") },
    ]);
    const r = openBrowserSync("http://x", "linux", runner);

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.method).toBe("none");
      expect(r.reason).toContain("xdg-open");
      expect(r.reason).toContain("sensible-browser");
    }
  });

  test("runner throws synchronously → caught, surfaced in reason", () => {
    const runner: SpawnSyncFn = () => { throw new Error("EMFILE"); };
    const r = openBrowserSync("http://x", "darwin", runner);

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("EMFILE");
  });
});


describe("killProcessOnPort — Linux/macOS (lsof)", () => {
  test("port free (lsof status=1, empty stdout) → no kill, no error", () => {
    const { runner, calls } = makeRunner([
      { status: 1, stdout: "" },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.killedPids).toEqual([]);
    expect(r.attemptedPids).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("lsof");
    expect(calls[0].args).toEqual(["-ti", ":4747"]);
  });

  test("lsof ENOENT (binary missing) → surfaced as error, no kill attempt", () => {
    const { runner, calls } = makeRunner([
      { status: null, error: new Error("ENOENT") },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.attemptedPids).toEqual([]);
    expect(r.errors.join(" ")).toMatch(/lsof.*ENOENT/);
    expect(calls).toHaveLength(1);
  });

  test("two pids, both kill cleanly → both reported as killed", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "1234\n5678\n" },
      { status: 0 },
      { status: 0 },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.killedPids).toEqual(["1234", "5678"]);
    expect(r.attemptedPids).toEqual(["1234", "5678"]);
    expect(r.errors).toEqual([]);

    // Argv check: each kill receives the pid as a single argv entry.
    expect(calls[1]).toEqual(expect.objectContaining({ cmd: "kill", args: ["1234"] }));
    expect(calls[2]).toEqual(expect.objectContaining({ cmd: "kill", args: ["5678"] }));
  });

  test("first pid kill fails → second pid still attempted (no abort)", () => {
    // Pre-fix: try/catch wrapped the entire for-loop, so a single pid
    // failure aborted the rest of the kills.
    const { runner } = makeRunner([
      { status: 0, stdout: "1111\n2222\n3333\n" },
      { status: 1, error: new Error("EPERM") },
      { status: 0 },
      { status: 0 },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.attemptedPids).toEqual(["1111", "2222", "3333"]);
    expect(r.killedPids).toEqual(["2222", "3333"]);
    expect(r.errors.join(" ")).toMatch(/kill 1111/);
  });

  test("runner throws on a kill → loop continues, error captured", () => {
    let calls = 0;
    const runner: SpawnSyncFn = (cmd, args) => {
      calls++;
      if (cmd === "lsof") {
        return { pid: 0, output: [], stdout: "1\n2\n", stderr: "", status: 0, signal: null } as ReturnType<SpawnSyncFn>;
      }
      if (cmd === "kill" && args[0] === "1") throw new Error("boom");
      return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null } as ReturnType<SpawnSyncFn>;
    };
    const r = killProcessOnPort(4747, "linux", runner);

    expect(calls).toBe(3);
    expect(r.attemptedPids).toEqual(["1", "2"]);
    expect(r.killedPids).toEqual(["2"]);
    expect(r.errors.join(" ")).toMatch(/boom/);
  });

  test("garbage in lsof stdout is filtered (only digit-PIDs accepted)", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "1234\n\nNot-a-pid\n5678\n" },
      { status: 0 },
      { status: 0 },
    ]);
    const r = killProcessOnPort(4747, "linux", runner);

    expect(r.killedPids).toEqual(["1234", "5678"]);
    expect(calls).toHaveLength(3); // lsof + 2 kills
  });
});


describe("killProcessOnPort — Windows (netstat)", () => {
  // Sample netstat -ano output. The MUST-NOT-KILL row's REMOTE column
  // contains :4747 — pre-fix `line.includes(":4747")` matched it and killed
  // the unrelated PID 9876.
  const netstatOut = [
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    0.0.0.0:4747           0.0.0.0:0              LISTENING       1234",
    "  TCP    192.168.1.5:54321      8.8.8.8:4747           ESTABLISHED     9876", // MUST NOT match
    "  UDP    0.0.0.0:4747           *:*                                    5555", // UDP, must not match
    "  TCP    [::]:4747              [::]:0                 LISTENING       1235",
    "",
  ].join("\r\n");

  test("only LISTENING TCP rows whose LOCAL column ends with :port are killed", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: netstatOut },
      { status: 0 }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
    expect(r.attemptedPids).not.toContain("9876"); // remote-port match — was the bug
    expect(r.attemptedPids).not.toContain("5555"); // UDP — must not be killed

    // taskkill argv: /F /PID <pid> with no shell:true
    const killCalls = calls.filter(c => c.cmd === "taskkill");
    for (const c of killCalls) {
      expect(c.args[0]).toBe("/F");
      expect(c.args[1]).toBe("/PID");
      expect(c.opts).not.toHaveProperty("shell", true);
    }
  });

  test("netstat ENOENT → surfaced as error", () => {
    const { runner } = makeRunner([
      { status: null, error: new Error("ENOENT") },
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.errors.join(" ")).toMatch(/netstat.*ENOENT/);
    expect(r.attemptedPids).toEqual([]);
  });

  test("first taskkill fails → second pid still attempted", () => {
    const { runner } = makeRunner([
      { status: 0, stdout: netstatOut },
      { status: 1, error: new Error("Access denied") }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toContain("1234");
    expect(r.attemptedPids).toContain("1235");
    expect(r.killedPids).toContain("1235");
    expect(r.killedPids).not.toContain("1234");
    expect(r.errors.join(" ")).toMatch(/taskkill 1234/);
  });
});


describe("killProcessOnPort — input validation", () => {
  test("rejects out-of-range port without spawning anything", () => {
    const spy = vi.fn();
    const r = killProcessOnPort(70000, "linux", spy as unknown as SpawnSyncFn);

    expect(spy).not.toHaveBeenCalled();
    expect(r.errors.join(" ")).toMatch(/invalid port/);
  });

  test("rejects non-integer port without spawning anything", () => {
    const spy = vi.fn();
    const r = killProcessOnPort(3.14 as number, "linux", spy as unknown as SpawnSyncFn);

    expect(spy).not.toHaveBeenCalled();
    expect(r.errors.join(" ")).toMatch(/invalid port/);
  });
});


// ─── ctx_insight helper follow-ups (#441 follow-up) ──────────────────────────
//
// 1. Hard timeout on every helper-internal spawnSync. A hung lsof/xdg-open/
//    taskkill would otherwise block the MCP tool indefinitely. We assert the
//    timeout option is propagated to the runner — the actual cap value is an
//    implementation detail, but its presence is the regression we lock.
//
// 2. Windows non-English locale support. The pre-followup parser keyed off
//    `state !== "LISTENING"` which is locale-translated (Windows-FR shows
//    `À l'écoute`, Windows-DE `ABHÖREN`, Windows-ES `ESCUCHANDO`, etc.), so
//    on non-EN Windows the helper would silently match zero rows and never
//    free a stuck dashboard port. The remote-address column is NOT
//    locale-translated; we now key off it instead.

describe("Helper spawnSync timeout (#441 follow-up)", () => {
  test("openBrowserSync passes a timeout to the runner", () => {
    const { runner, calls } = makeRunner([{ status: 0 }]);
    openBrowserSync("http://x", "darwin", runner);

    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toBeDefined();
    expect(typeof (calls[0].opts as { timeout?: number }).timeout).toBe("number");
    expect((calls[0].opts as { timeout: number }).timeout).toBeGreaterThan(0);
  });

  test("killProcessOnPort (Linux) passes a timeout to lsof and kill", () => {
    const { runner, calls } = makeRunner([
      { status: 0, stdout: "1234\n" },
      { status: 0 }, // kill 1234
    ]);
    killProcessOnPort(4747, "linux", runner);

    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(typeof (c.opts as { timeout?: number }).timeout).toBe("number");
      expect((c.opts as { timeout: number }).timeout).toBeGreaterThan(0);
    }
  });

  test("killProcessOnPort (Windows) passes a timeout to netstat and taskkill", () => {
    const winFixture = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:4747           0.0.0.0:0              LISTENING       1234",
      "",
    ].join("\r\n");
    const { runner, calls } = makeRunner([
      { status: 0, stdout: winFixture },
      { status: 0 }, // taskkill 1234
    ]);
    killProcessOnPort(4747, "win32", runner);

    expect(calls.map(c => c.cmd)).toEqual(["netstat", "taskkill"]);
    for (const c of calls) {
      expect(typeof (c.opts as { timeout?: number }).timeout).toBe("number");
      expect((c.opts as { timeout: number }).timeout).toBeGreaterThan(0);
    }
  });
});


describe("killProcessOnPort — Windows non-English locale (#441 follow-up)", () => {
  // Same regression fixture as the en-US Windows test, but with the STATE
  // column translated. Pre-followup, the helper required `state === "LISTENING"`
  // and so silently produced zero PIDs on non-EN Windows. The follow-up keys
  // off the remote-address column (locale-independent) so this fixture must
  // now match LISTENING rows 1234 + 1235 and skip the ESTABLISHED row 9876
  // and the UDP row 5555.
  const netstatFr = [
    "Connexions actives",
    "",
    "  Proto  Adresse locale         Adresse distante       État            PID",
    "  TCP    0.0.0.0:4747           0.0.0.0:0              À l'écoute      1234",
    "  TCP    192.168.1.5:54321      8.8.8.8:4747           ESTABLI         9876",
    "  UDP    0.0.0.0:4747           *:*                                    5555",
    "  TCP    [::]:4747              [::]:0                 À l'écoute      1235",
    "",
  ].join("\r\n");

  const netstatDe = [
    "Aktive Verbindungen",
    "",
    "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
    "  TCP    0.0.0.0:4747           0.0.0.0:0              ABHÖREN         1234",
    "  TCP    192.168.1.5:54321      8.8.8.8:4747           HERGESTELLT     9876",
    "  TCP    [::]:4747              [::]:0                 ABHÖREN         1235",
    "",
  ].join("\r\n");

  test("French Windows netstat output: kills 1234 and 1235, ignores 9876 + 5555", () => {
    const { runner } = makeRunner([
      { status: 0, stdout: netstatFr },
      { status: 0 }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
    expect(r.attemptedPids).not.toContain("9876");
    expect(r.attemptedPids).not.toContain("5555");
    expect(r.killedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
  });

  test("German Windows netstat output: kills 1234 and 1235, ignores 9876", () => {
    const { runner } = makeRunner([
      { status: 0, stdout: netstatDe },
      { status: 0 }, // taskkill 1234
      { status: 0 }, // taskkill 1235
    ]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
    expect(r.attemptedPids).not.toContain("9876");
    expect(r.killedPids).toEqual(expect.arrayContaining(["1234", "1235"]));
  });

  test("a connected remote :port still does NOT match (remote-column anchor)", () => {
    // Sanity: the predicate must still reject the ESTABLISHED row whose
    // REMOTE is 8.8.8.8:4747. This was the original pre-#441 bug; the
    // follow-up must not regress it while changing the locale strategy.
    const onlyEstablished = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    192.168.1.5:54321      8.8.8.8:4747           ESTABLISHED     9876",
      "",
    ].join("\r\n");
    const { runner, calls } = makeRunner([{ status: 0, stdout: onlyEstablished }]);
    const r = killProcessOnPort(4747, "win32", runner);

    expect(r.attemptedPids).toEqual([]);
    expect(calls).toHaveLength(1); // netstat only — no taskkill issued
  });
});
