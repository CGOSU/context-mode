/** Executor regressions: executor-environment. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe("Environment Passthrough", () => {
  test("SSH_AUTH_SOCK is passed through to subprocess when set", async () => {
    const original = process.env.SSH_AUTH_SOCK;
    process.env.SSH_AUTH_SOCK = "/tmp/test-ssh-agent.sock";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "SSH_AUTH_SOCK=$SSH_AUTH_SOCK"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("/tmp/test-ssh-agent.sock"),
        `Expected SSH_AUTH_SOCK to be passed through, got: ${r.stdout}`,
      );
    } finally {
      if (original === undefined) delete process.env.SSH_AUTH_SOCK;
      else process.env.SSH_AUTH_SOCK = original;
    }
  });

  test("SSH_AGENT_PID is passed through to subprocess when set", async () => {
    const original = process.env.SSH_AGENT_PID;
    process.env.SSH_AGENT_PID = "99999";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "SSH_AGENT_PID=$SSH_AGENT_PID"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("99999"),
        `Expected SSH_AGENT_PID to be passed through, got: ${r.stdout}`,
      );
    } finally {
      if (original === undefined) delete process.env.SSH_AGENT_PID;
      else process.env.SSH_AGENT_PID = original;
    }
  });

  test("SSH_AUTH_SOCK is absent from subprocess when not set in parent", async () => {
    const original = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'if [ -z "${SSH_AUTH_SOCK+x}" ]; then echo "unset"; else echo "set=$SSH_AUTH_SOCK"; fi',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("unset"),
        `Expected SSH_AUTH_SOCK to be absent, got: ${r.stdout}`,
      );
    } finally {
      if (original !== undefined) process.env.SSH_AUTH_SOCK = original;
    }
  });
});


describe("Environment Denylist", () => {
  test("dangerous vars are stripped from subprocess (BASH_ENV, NODE_OPTIONS)", async () => {
    const origBash = process.env.BASH_ENV;
    const origNode = process.env.NODE_OPTIONS;
    process.env.BASH_ENV = "/tmp/evil.sh";
    process.env.NODE_OPTIONS = "--inspect";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "BASH_ENV=${BASH_ENV:-unset}" && echo "NODE_OPTIONS=${NODE_OPTIONS:-unset}"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("BASH_ENV=unset"), `BASH_ENV should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("NODE_OPTIONS=unset"), `NODE_OPTIONS should be stripped, got: ${r.stdout}`);
    } finally {
      if (origBash === undefined) delete process.env.BASH_ENV;
      else process.env.BASH_ENV = origBash;
      if (origNode === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = origNode;
    }
  });

  test("dangerous vars are stripped: PERL5OPT, RUBYOPT, LD_PRELOAD", async () => {
    const origPerl = process.env.PERL5OPT;
    const origRuby = process.env.RUBYOPT;
    const origLD = process.env.LD_PRELOAD;
    process.env.PERL5OPT = "-Mbase";
    process.env.RUBYOPT = "-rmalicious";
    process.env.LD_PRELOAD = "/tmp/evil.so";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "PERL5OPT=${PERL5OPT:-unset}" && echo "RUBYOPT=${RUBYOPT:-unset}" && echo "LD_PRELOAD=${LD_PRELOAD:-unset}"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("PERL5OPT=unset"), `PERL5OPT should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("RUBYOPT=unset"), `RUBYOPT should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("LD_PRELOAD=unset"), `LD_PRELOAD should be stripped, got: ${r.stdout}`);
    } finally {
      if (origPerl === undefined) delete process.env.PERL5OPT;
      else process.env.PERL5OPT = origPerl;
      if (origRuby === undefined) delete process.env.RUBYOPT;
      else process.env.RUBYOPT = origRuby;
      if (origLD === undefined) delete process.env.LD_PRELOAD;
      else process.env.LD_PRELOAD = origLD;
    }
  });

  test("user env vars pass through by default (no allowlist needed)", async () => {
    const origSlack = process.env.SLACK_BOT_TOKEN;
    const origCustom = process.env.MY_CUSTOM_API_KEY;
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.MY_CUSTOM_API_KEY = "custom-12345";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "SLACK=$SLACK_BOT_TOKEN" && echo "CUSTOM=$MY_CUSTOM_API_KEY"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("SLACK=xoxb-test-token"), `SLACK_BOT_TOKEN should pass through, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("CUSTOM=custom-12345"), `MY_CUSTOM_API_KEY should pass through, got: ${r.stdout}`);
    } finally {
      if (origSlack === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = origSlack;
      if (origCustom === undefined) delete process.env.MY_CUSTOM_API_KEY;
      else process.env.MY_CUSTOM_API_KEY = origCustom;
    }
  });

  test("sandbox overrides take precedence over parent env", async () => {
    const r = await executor.execute({
      language: "shell",
      code: 'echo "NO_COLOR=$NO_COLOR" && echo "PYTHONUNBUFFERED=$PYTHONUNBUFFERED"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("NO_COLOR=1"), `NO_COLOR should be forced to 1, got: ${r.stdout}`);
    assert.ok(r.stdout.includes("PYTHONUNBUFFERED=1"), `PYTHONUNBUFFERED should be forced to 1, got: ${r.stdout}`);
  });

  // PR #546 follow-up: Microsoft documents native injection vectors that
  // hijack the dotnet host. Profiler attach loads an arbitrary DLL into the
  // host process; DiagnosticPorts allows a peer to attach a debugger /
  // inject IL via the IPC port; the bundle extract dir lets a
  // single-file app extraction be redirected. Every DOTNET_* knob has a
  // COMPlus_* synonym (back-compat alias). Strip the explicit set and
  // sweep COMPlus_* via prefix.
  // Refs: learn.microsoft.com/en-us/dotnet/core/runtime-config/{debugging-profiling,dotnet-environment-variables}
  test("DOTNET profiler + DiagnosticPorts + COMPlus aliases are stripped", async () => {
    const KEYS = [
      "CORECLR_PROFILER",
      "CORECLR_PROFILER_PATH",
      "CORECLR_PROFILER_PATH_32",
      "CORECLR_PROFILER_PATH_64",
      "CORECLR_PROFILER_PATH_ARM32",
      "CORECLR_PROFILER_PATH_ARM64",
      "DOTNET_PROFILER_PATH",
      "DOTNET_PROFILER_PATH_32",
      "DOTNET_PROFILER_PATH_64",
      "DOTNET_PROFILER_PATH_ARM32",
      "DOTNET_PROFILER_PATH_ARM64",
      "CORECLR_ENABLE_PROFILING",
      "DOTNET_DiagnosticPorts",
      "DOTNET_BUNDLE_EXTRACT_BASE_DIR",
      // COMPlus_* alias coverage — sweep via /^COMPlus_/i prefix.
      "COMPlus_EnableDiagnostics",
      "COMPlus_DbgEnableMiniDump",
      "COMPlus_TieredCompilation",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      process.env[k] = "evil-injected";
    }
    try {
      const echoes = KEYS.map((k) => `echo "${k}=\${${k}:-unset}"`).join(" && ");
      const r = await executor.execute({ language: "shell", code: echoes });
      assert.equal(r.exitCode, 0);
      for (const k of KEYS) {
        assert.ok(
          r.stdout.includes(`${k}=unset`),
          `${k} should be stripped, got: ${r.stdout}`,
        );
      }
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  test("CLAUDE_PLUGIN_ROOT and unrelated env vars survive after DOTNET strip", async () => {
    // Defense-in-depth — make sure the new explicit denylist + COMPlus_*
    // sweep do not accidentally clobber unrelated env. CLAUDE_PLUGIN_ROOT
    // is the canary because the hooks rely on it.
    const origRoot = process.env.CLAUDE_PLUGIN_ROOT;
    const origUnrelated = process.env.MY_HARMLESS_VAR;
    process.env.CLAUDE_PLUGIN_ROOT = "/test/plugin/root";
    process.env.MY_HARMLESS_VAR = "stay-alive";
    try {
      const r = await executor.execute({
        language: "shell",
        code:
          'echo "CLAUDE_PLUGIN_ROOT=$CLAUDE_PLUGIN_ROOT" && echo "MY_HARMLESS_VAR=$MY_HARMLESS_VAR"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(
        r.stdout.includes("CLAUDE_PLUGIN_ROOT=/test/plugin/root"),
        `CLAUDE_PLUGIN_ROOT must survive, got: ${r.stdout}`,
      );
      assert.ok(
        r.stdout.includes("MY_HARMLESS_VAR=stay-alive"),
        `MY_HARMLESS_VAR must survive, got: ${r.stdout}`,
      );
    } finally {
      if (origRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
      else process.env.CLAUDE_PLUGIN_ROOT = origRoot;
      if (origUnrelated === undefined) delete process.env.MY_HARMLESS_VAR;
      else process.env.MY_HARMLESS_VAR = origUnrelated;
    }
  });

  test("ERL_AFLAGS and ERL_FLAGS are stripped", async () => {
    const origA = process.env.ERL_AFLAGS;
    const origF = process.env.ERL_FLAGS;
    process.env.ERL_AFLAGS = "-eval 'os:cmd(\"id\")'";
    process.env.ERL_FLAGS = "-eval 'os:cmd(\"id\")'";
    try {
      const r = await executor.execute({
        language: "shell",
        code: 'echo "ERL_AFLAGS=${ERL_AFLAGS:-unset}" && echo "ERL_FLAGS=${ERL_FLAGS:-unset}"',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("ERL_AFLAGS=unset"), `ERL_AFLAGS should be stripped, got: ${r.stdout}`);
      assert.ok(r.stdout.includes("ERL_FLAGS=unset"), `ERL_FLAGS should be stripped, got: ${r.stdout}`);
    } finally {
      if (origA === undefined) delete process.env.ERL_AFLAGS;
      else process.env.ERL_AFLAGS = origA;
      if (origF === undefined) delete process.env.ERL_FLAGS;
      else process.env.ERL_FLAGS = origF;
    }
  });
});
