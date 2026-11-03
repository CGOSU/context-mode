/** Executor regressions: executor. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PolyglotExecutor, buildScriptFilename, buildShellScriptContent, buildPowerShellScriptContent, buildSpawnOptions } from "../src/executor.js";
import { buildCommand, type RuntimeMap } from "../src/runtime.js";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


function findWindowsGitBash(): string | null {
  if (process.platform !== "win32") return null;
  const candidates = [
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  return candidates.find(p => existsSync(p)) ?? null;
}


describe("Runtime Detection", () => {
  test("detects JavaScript runtime (bun or node)", async () => {
    const isBun = runtimes.javascript.endsWith("bun");
    const isAbsoluteNode = runtimes.javascript.startsWith("/") || runtimes.javascript.includes("\\");
    assert.ok(
      isBun || isAbsoluteNode,
      `Expected bun path or absolute node path, got: ${runtimes.javascript}`,
    );
  });

  test("detects JavaScript runtime (bun or absolute node path)", async () => {
    // runtimes.javascript is either a bun path/command or process.execPath —
    // never the bare string "node", since snap/wrapper envs need the real binary.
    const isBun = runtimes.javascript.endsWith("bun");
    const isAbsoluteNode = runtimes.javascript.startsWith("/") || runtimes.javascript.includes("\\");
    assert.ok(
      isBun || isAbsoluteNode,
      `Expected bun path or absolute node path, got: ${runtimes.javascript}`,
    );
  });

  test("buildCommand: javascript uses executable path, not bare 'node'", async () => {
    const cmd = buildCommand(runtimes, "javascript", "/tmp/test.js");
    assert.notEqual(cmd[0], "node", "Should not use bare 'node' — use process.execPath or full bun path");
    assert.equal(cmd[cmd.length - 1], "/tmp/test.js");
  });

  test("buildCommand: javascript with bun-path runtime uses 'run' subcommand", async () => {
    const bunRuntimes: RuntimeMap = { ...runtimes, javascript: "/home/user/.bun/bin/bun" };
    const cmd = buildCommand(bunRuntimes, "javascript", "/tmp/test.js");
    assert.equal(cmd[0], "/home/user/.bun/bin/bun");
    assert.equal(cmd[1], "run");
    assert.equal(cmd[2], "/tmp/test.js");
  });

  test("buildCommand: javascript with Windows bun.exe runtime uses 'run' subcommand", async () => {
    const bunRuntimes: RuntimeMap = { ...runtimes, javascript: "C:\\Users\\me\\.bun\\bin\\bun.exe" };
    const cmd = buildCommand(bunRuntimes, "javascript", "C:\\tmp\\test.js");
    assert.equal(cmd[0], "C:\\Users\\me\\.bun\\bin\\bun.exe");
    assert.equal(cmd[1], "run");
    assert.equal(cmd[2], "C:\\tmp\\test.js");
  });

  test("buildCommand: typescript with Windows bun.exe runtime uses 'run' subcommand", async () => {
    const bunRuntimes: RuntimeMap = { ...runtimes, typescript: "C:\\Users\\me\\.bun\\bin\\bun.exe" };
    const cmd = buildCommand(bunRuntimes, "typescript", "C:\\tmp\\test.ts");
    assert.equal(cmd[0], "C:\\Users\\me\\.bun\\bin\\bun.exe");
    assert.equal(cmd[1], "run");
    assert.equal(cmd[2], "C:\\tmp\\test.ts");
  });

  test("detects Shell runtime (non-empty string)", async () => {
    assert.ok(
      typeof runtimes.shell === "string" && runtimes.shell.length > 0,
      `Got: ${runtimes.shell}`,
    );
  });

  if (process.platform === "win32") {
    const gitBash = findWindowsGitBash();
    // #791 is specifically Git Bash + native git path conversion; fallback
    // shells are covered by the runtime detection test above.
    const gitBashTest = gitBash ? test : test.skip;

    test("Windows: shell is Git Bash or fallback, never WSL bash", async () => {
      const shell = runtimes.shell.toLowerCase();
      assert.ok(
        !shell.includes("system32") && !shell.includes("windowsapps"),
        `Shell should not be WSL bash, got: ${runtimes.shell}`,
      );
    });

    test("Windows: shell execute works with non-ASCII (Chinese) project path", async () => {
      const { mkdirSync } = await import("node:fs");
      const { rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const chineseDir = join(tmpdir(), "测试目录");
      try { mkdirSync(chineseDir, { recursive: true }); } catch {}
      const chineseExecutor = new PolyglotExecutor({ runtimes, projectRoot: chineseDir });
      const r = await chineseExecutor.execute({ language: "shell", code: 'echo "chinese path ok"' });
      assert.equal(r.exitCode, 0, `Failed with stderr: ${r.stderr}`);
      assert.ok(r.stdout.includes("chinese path ok"), `Got: ${r.stdout}`);
      try { await rm(chineseDir, { recursive: true, force: true }); } catch {}
    });

    gitBashTest("Windows: Git Bash sees native git repos created under mktemp dirs (#791)", async () => {
      const gitBashRuntimes: RuntimeMap = { ...runtimes, shell: gitBash! };
      const gitBashExecutor = new PolyglotExecutor({ runtimes: gitBashRuntimes });
      const previousNoPathConv = process.env.MSYS_NO_PATHCONV;
      const previousArgConvExcl = process.env.MSYS2_ARG_CONV_EXCL;
      process.env.MSYS_NO_PATHCONV = "1";
      process.env.MSYS2_ARG_CONV_EXCL = "*";
      try {
        const r = await gitBashExecutor.execute({
          language: "shell",
          timeout: 20_000,
          code: [
            "set -e",
            "T=$(mktemp -d)",
            "git init --bare --quiet \"$T/origin.git\"",
            "test -d \"$T/origin.git\"",
            "git clone --quiet \"$T/origin.git\" \"$T/clone\"",
            "test -d \"$T/clone/.git\"",
            "echo git bash tmp path ok",
          ].join("\n"),
        });
        assert.equal(r.exitCode, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
        assert.ok(r.stdout.includes("git bash tmp path ok"), `Got: ${r.stdout}`);
      } finally {
        if (previousNoPathConv === undefined) delete process.env.MSYS_NO_PATHCONV;
        else process.env.MSYS_NO_PATHCONV = previousNoPathConv;
        if (previousArgConvExcl === undefined) delete process.env.MSYS2_ARG_CONV_EXCL;
        else process.env.MSYS2_ARG_CONV_EXCL = previousArgConvExcl;
      }
    });

  }

  test("detects TypeScript runtime", async () => {
    assert.ok(runtimes.typescript !== null, "No TS runtime found");
  });

  test("detects Python runtime", async () => {
    assert.ok(runtimes.python !== null, "No Python runtime found");
  });

  test("buildCommand: correct JS command structure", async () => {
    const cmd = buildCommand(runtimes, "javascript", "/tmp/test.js");
    assert.ok(cmd.length >= 2);
    assert.ok(cmd[cmd.length - 1] === "/tmp/test.js");
  });

  test("buildCommand: throws for unavailable runtime", async () => {
    const noRuntimes: RuntimeMap = {
      javascript: "node",
      typescript: null,
      python: null,
      shell: "sh",
      ruby: null,
      go: null,
      rust: null,
      php: null,
      perl: null,
      r: null,
      elixir: null,
      csharp: null,
    };
    assert.throws(
      () => buildCommand(noRuntimes, "typescript", "/tmp/t.ts"),
      /No TypeScript runtime/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "python", "/tmp/t.py"),
      /No Python runtime/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "ruby", "/tmp/t.rb"),
      /Ruby not available/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "elixir", "/tmp/t.exs"),
      /Elixir not available/,
    );
    assert.throws(
      () => buildCommand(noRuntimes, "csharp", "/tmp/t.csx"),
      /C# not available/,
    );
  });

  test("buildShellScriptContent restores inherited PATH on Unix", () => {
    const script = buildShellScriptContent("echo ok", "/parent/bin:/usr/bin", "linux");
    assert.equal(script, "export PATH='/parent/bin:/usr/bin'\necho ok");
  });

  test("buildShellScriptContent escapes single quotes in inherited PATH", () => {
    const script = buildShellScriptContent("echo ok", "/parent/it'works/bin", "darwin");
    assert.equal(script, "export PATH='/parent/it'\\''works/bin'\necho ok");
  });

  test("buildShellScriptContent leaves Windows shell scripts unchanged", () => {
    const script = buildShellScriptContent("echo ok", "C:\\parent\\bin", "win32");
    assert.equal(script, "echo ok");
  });

  test("buildPowerShellScriptContent prefixes UTF-8 encoding setup", () => {
    const script = buildPowerShellScriptContent('Write-Output "ok"');
    // Windows PowerShell 5.1 only reliably detects a script as UTF-8 when the
    // file opens with a BOM; without it the body is read as the ANSI code page.
    assert.equal(script.charCodeAt(0), 0xfeff);
    assert.ok(script.startsWith("﻿[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()"));
    assert.ok(script.includes("$OutputEncoding = [System.Text.UTF8Encoding]::new()"));
    assert.ok(script.endsWith('Write-Output "ok"'));
  });
});


describe("Error Handling", () => {
  test("JS: syntax error returns non-zero", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "const x = {",
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0);
  });

  test("JS: runtime error returns non-zero", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'throw new Error("intentional");',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("intentional"));
  });

    test.runIf(runtimes.python)("Python: syntax error", async () => {
    const r = await executor.execute({
      language: "python",
      code: "def foo(\n  pass",
    });
    assert.notEqual(r.exitCode, 0);
  });

    test.runIf(runtimes.python)("Python: runtime error (ValueError)", async () => {
    const r = await executor.execute({
      language: "python",
      code: 'raise ValueError("test error")',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.includes("ValueError"));
  });

  test("Shell: non-zero exit code preserved", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "exit 42",
    });
    assert.equal(r.exitCode, 42);
  });

  test("Shell: command not found", async () => {
    const r = await executor.execute({
      language: "shell",
      code: "nonexistent_command_xyz 2>&1",
    });
    assert.notEqual(r.exitCode, 0);
  });
});


describe("Edge Cases", () => {
  test("empty output returns empty string", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "// no output",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout, "");
  });

  test("multiline output preserved", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "for (let i = 0; i < 10; i++) console.log(`line ${i}`);",
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim().split("\n").length, 10);
  });

  test("stderr captured separately from stdout", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.error("warning"); console.log("ok");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("ok"));
    assert.ok(r.stderr.includes("warning"));
  });

  test("special characters in output", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("line1\\nline2\\ttab\\n\\"quoted\\"");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("line1"));
    assert.ok(r.stdout.includes("line2"));
    assert.ok(r.stdout.includes('"quoted"'));
  });

  test("unicode output", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("Hello world");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Hello"));
  });
});


describe("Windows Shell Support", () => {
  test("shell runtime is always a non-empty string", async () => {
    assert.ok(
      typeof runtimes.shell === "string" && runtimes.shell.length > 0,
      `shell should always be a non-empty string, got: ${runtimes.shell}`,
    );
  });

  test("getAvailableLanguages always includes shell", async () => {
    const { getAvailableLanguages } = await import("../src/runtime.js");
    const langs = getAvailableLanguages(runtimes);
    assert.ok(langs.includes("shell"), `shell should always be in available languages, got: ${langs}`);
  });

  test("buildCommand returns shell command array", async () => {
    const cmd = buildCommand(runtimes, "shell", "/tmp/script.sh");
    assert.ok(Array.isArray(cmd) && cmd.length > 0, `Expected non-empty array, got: ${cmd}`);
    if (process.platform === "win32" && (cmd[0].toLowerCase().includes("bash") || cmd[0].toLowerCase().endsWith("\\sh.exe"))) {
      // Windows + bash → `bash -c "source 'path'"` to dodge MSYS path mangling.
      assert.equal(cmd.length, 3, `Expected [bash, -c, source ...], got: ${cmd}`);
      assert.equal(cmd[1], "-c");
      assert.ok(cmd[2].includes("/tmp/script.sh"), `Expected source clause to reference path, got: ${cmd[2]}`);
    } else if (process.platform === "win32" && /powershell|pwsh/i.test(cmd[0])) {
      assert.equal(cmd.length, 6, `Expected [powershell, -NoProfile, -ExecutionPolicy, Bypass, -File, path], got: ${cmd}`);
      assert.deepEqual(cmd.slice(1, 5), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
      assert.equal(cmd[5], "/tmp/script.sh");
    } else {
      assert.equal(cmd.length, 2, `Expected [shell, path], got: ${cmd}`);
      assert.equal(cmd[1], "/tmp/script.sh");
    }
  });

  // --- Issue #384: hide Windows console + drop .sh extension for shell ---

  test("buildSpawnOptions: windowsHide=true on Windows", async () => {
    assert.equal(buildSpawnOptions("win32").windowsHide, true);
  });

  test("buildSpawnOptions: windowsHide=false on macOS/Linux", async () => {
    assert.equal(buildSpawnOptions("darwin").windowsHide, false);
    assert.equal(buildSpawnOptions("linux").windowsHide, false);
  });

  test("buildScriptFilename: POSIX shell on Windows has NO extension (avoid .sh file association)", async () => {
    assert.equal(buildScriptFilename("shell", "win32"), "script");
    assert.equal(buildScriptFilename("shell", "win32", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"), "script");
    assert.equal(buildScriptFilename("shell", "win32", "sh"), "script");
  });

  test("buildScriptFilename: cmd on Windows uses .cmd extension", async () => {
    assert.equal(buildScriptFilename("shell", "win32", "cmd.exe"), "script.cmd");
    assert.equal(buildScriptFilename("shell", "win32", "C:\\Windows\\System32\\cmd.exe"), "script.cmd");
  });

  test("buildScriptFilename: PowerShell on Windows uses .ps1 extension", async () => {
    assert.equal(buildScriptFilename("shell", "win32", "powershell"), "script.ps1");
    assert.equal(buildScriptFilename("shell", "win32", "pwsh"), "script.ps1");
    assert.equal(
      buildScriptFilename("shell", "win32", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      "script.ps1",
    );
    assert.equal(
      buildScriptFilename("shell", "win32", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
      "script.ps1",
    );
  });

  test.runIf(process.platform === "win32")("PowerShell shell runtime executes generated script", async () => {
    const powershellRuntimes: RuntimeMap = { ...runtimes, shell: "powershell" };
    const powershellExecutor = new PolyglotExecutor({ runtimes: powershellRuntimes });
    const r = await powershellExecutor.execute({
      language: "shell",
      code: 'Write-Output "POWERSHELL_EXECUTOR_OK"',
      timeout: 10_000,
    });

    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("POWERSHELL_EXECUTOR_OK"), `stdout: ${r.stdout}`);
  });

  test("buildScriptFilename: shell on Unix keeps .sh extension", async () => {
    assert.equal(buildScriptFilename("shell", "darwin"), "script.sh");
    assert.equal(buildScriptFilename("shell", "linux"), "script.sh");
    assert.equal(buildScriptFilename("shell", "linux", "pwsh"), "script.sh");
    assert.equal(buildScriptFilename("shell", "darwin", "powershell"), "script.sh");
  });

  test("buildScriptFilename: non-shell languages keep their extension on Windows", async () => {
    assert.equal(buildScriptFilename("python", "win32"), "script.py");
    assert.equal(buildScriptFilename("javascript", "win32"), "script.js");
    assert.equal(buildScriptFilename("typescript", "win32"), "script.ts");
    assert.equal(buildScriptFilename("ruby", "win32"), "script.rb");
    assert.equal(buildScriptFilename("go", "win32"), "script.go");
    assert.equal(buildScriptFilename("rust", "win32"), "script.rs");
    assert.equal(buildScriptFilename("csharp", "win32"), "script.csx");
  });

  test("buildScriptFilename: non-shell languages keep their extension on Unix", async () => {
    assert.equal(buildScriptFilename("python", "linux"), "script.py");
    assert.equal(buildScriptFilename("javascript", "darwin"), "script.js");
  });
});
