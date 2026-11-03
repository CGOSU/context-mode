/** Hook regressions: core-routing. */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { useMcpReadyFixture } from "./mcp-ready-fixture.js";
import { spawnPreToolUseHook } from "./routing-probe.js";


// Dynamic import for .mjs module
let routePreToolUse: (
  toolName: string,
  toolInput: Record<string, unknown>,
  projectDir?: string,
  platform?: string,
  sessionId?: string,
  options?: { mcpToolsAvailable?: boolean },
) => {
  action: string;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
} | null;


let resetGuidanceThrottle: (sessionId?: string) => void;

let initSecurity: (buildDir: string) => Promise<boolean>;

let ROUTING_BLOCK: string;

let createRoutingBlock: (t: any, options?: { includeCommands?: boolean; toolSearchBootstrap?: boolean }) => string;

let READ_GUIDANCE: string;

let GREP_GUIDANCE: string;


beforeAll(async () => {
  const mod = await import("../../hooks/core/routing.mjs");
  routePreToolUse = mod.routePreToolUse;
  resetGuidanceThrottle = mod.resetGuidanceThrottle;
  initSecurity = mod.initSecurity;

  const constants = await import("../../hooks/routing-block.mjs");
  ROUTING_BLOCK = constants.ROUTING_BLOCK;
  createRoutingBlock = constants.createRoutingBlock;
  READ_GUIDANCE = constants.READ_GUIDANCE;
  GREP_GUIDANCE = constants.GREP_GUIDANCE;
});
const { _sentinelDir, mcpSentinel } = useMcpReadyFixture(() => {
  if (typeof resetGuidanceThrottle === "function") resetGuidanceThrottle();
});



describe("routePreToolUse", () => {
  // ─── Bash routing ──────────────────────────────────────

  describe("Bash tool", () => {
    it("denies curl commands with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "curl https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect(result!.updatedInput).toBeDefined();
      const cmd = (result!.updatedInput as Record<string, string>).command;
      expect(cmd).toContain("curl/wget redirected");
      expect(cmd).not.toContain("curl/wget blocked");
      expect(cmd).toMatch(/retry/i);
    });

    it("denies Codex exec_command cmd payloads like Bash command payloads", () => {
      const result = routePreToolUse(
        "exec_command",
        { cmd: "curl https://example.com" },
        undefined,
        "codex",
        "codex-cmd-curl",
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "curl/wget redirected",
      );
    });

    it("denies agy run_command CommandLine payloads like Bash command payloads", () => {
      const result = routePreToolUse(
        "run_command",
        { CommandLine: "curl https://example.com" },
        undefined,
        "antigravity-cli",
        "agy-commandline-curl",
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "curl/wget redirected",
      );
    });

    it("denies wget commands with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: "wget https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "curl/wget redirected",
      );
    });

    // ─── curl/wget file-output allow-list (#166) ────────────

    it("allows curl -sLo file (silent + file output)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL https://example.com/file.tar.gz -o /tmp/file.tar.gz",
      });
      expect(result).toBeNull(); // null = allow through
    });

    it("allows curl -s --output file", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s --output /tmp/stripe.tar.gz https://github.com/stripe/stripe-cli/releases/download/v1.38.1/stripe.tar.gz",
      });
      expect(result).toBeNull();
    });

    it("allows wget -q -O file (quiet + file output)", () => {
      const result = routePreToolUse("Bash", {
        command: "wget -q -O /tmp/terraform.zip https://releases.hashicorp.com/terraform/1.0.0/terraform_1.0.0_linux_amd64.zip",
      });
      expect(result).toBeNull();
    });

    it("allows curl -s > file (silent + shell redirect)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s https://example.com/data.json > /tmp/data.json",
      });
      expect(result).toBeNull();
    });

    it("blocks curl -o - (stdout alias)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s -o - https://example.com",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks curl -o file WITHOUT silent flag", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -L -o /tmp/file.tar.gz https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks curl -o file with --verbose", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -s --verbose -o /tmp/file.tar.gz https://example.com/file.tar.gz",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("blocks chained: curl -sLo file && curl url (second floods)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL -o /tmp/file.tar.gz https://example.com/a.tar.gz && curl https://example.com/api",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("allows chained: curl -sLo file && tar xzf file (both safe)", () => {
      const result = routePreToolUse("Bash", {
        command: "curl -sL -o /tmp/file.tar.gz https://example.com/a.tar.gz && tar xzf /tmp/file.tar.gz -C /tmp",
      });
      expect(result).toBeNull();
    });

    it("denies inline fetch() with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: 'node -e "fetch(\'https://api.example.com/data\')"',
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const cmd = (result!.updatedInput as Record<string, string>).command;
      expect(cmd).toContain("Inline HTTP redirected");
      expect(cmd).not.toContain("Inline HTTP blocked");
      expect(cmd).toMatch(/retry/i);
    });

    it("denies requests.get() with modify action", () => {
      const result = routePreToolUse("Bash", {
        command: 'python -c "import requests; requests.get(\'https://example.com\')"',
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Inline HTTP redirected",
      );
    });

    it("git status — bypassed by structurally-bounded allowlist (#463)", () => {
      // Pre-#463: this returned BASH_GUIDANCE context. The #463 allowlist
      // now short-circuits the nudge for read-only git subcommands so the
      // guidance reads as signal, not noise.
      const result = routePreToolUse("Bash", { command: "git status" });
      expect(result).toBeNull();
    });

    it("mkdir — bypassed by structurally-bounded allowlist (#463)", () => {
      const result = routePreToolUse("Bash", {
        command: "mkdir -p /tmp/test-dir",
      });
      expect(result).toBeNull();
    });

    it("allows npm install with BASH_GUIDANCE context", () => {
      const result = routePreToolUse("Bash", { command: "npm install" });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
    });

    it("redirects ./gradlew build to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./gradlew build",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Build tool redirected",
      );
    });

    it("redirects gradle test to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "gradle test --info",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("redirects mvn package to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "mvn clean package -DskipTests",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("redirects ./mvnw verify to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./mvnw verify",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("does not false-positive on gradle in quoted text", () => {
      // Use a command whose first word is NOT in the #463 structurally-bounded
      // allowlist (`echo` is allowlisted), so we still exercise the
      // strip-quotes-then-match-gradle path. The intent is to prove the
      // gradle build-tool redirect doesn't fire on quoted occurrences.
      const result = routePreToolUse("Bash", {
        command: 'find . -name "run gradle build to compile"',
      });
      expect(result).not.toBeNull();
      // stripped version removes quoted content → no gradle match → context
      expect(result!.action).toBe("context");
    });

    // Issue #406 — sbt added alongside gradle/maven
    it("redirects sbt compile to execute sandbox (Issue #406)", () => {
      const result = routePreToolUse("Bash", {
        command: "sbt compile",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      expect((result!.updatedInput as Record<string, string>).command).toContain(
        "Build tool redirected",
      );
    });

    it("redirects ./sbt test to execute sandbox", () => {
      const result = routePreToolUse("Bash", {
        command: "./sbt test",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
    });

    it("does not false-positive on substrings like gradle-wrapper-config or mvnDocker", () => {
      // Word-boundary guard — these are NOT gradle/mvn invocations.
      const r1 = routePreToolUse("Bash", { command: "ls gradle-wrapper-config" });
      expect(r1?.action).not.toBe("modify");
      const r2 = routePreToolUse("Bash", { command: "echo mvnDocker-image" });
      // Quoted/echo passes context, not modify
      expect(r2?.action).not.toBe("modify");
    });
  });

  // ─── Read routing ──────────────────────────────────────

  describe("Read tool", () => {
    it("returns context action with READ_GUIDANCE", () => {
      const result = routePreToolUse("Read", {
        file_path: "/some/file.ts",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBe(READ_GUIDANCE);
    });

    it("treats agy view_file AbsolutePath payloads as Read", () => {
      resetGuidanceThrottle("agy-view-file");
      const result = routePreToolUse(
        "view_file",
        { AbsolutePath: "/some/file.ts" },
        undefined,
        "antigravity-cli",
        "agy-view-file",
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toContain("ctx_execute_file");
    });
  });

  // ─── Grep routing ──────────────────────────────────────

  describe("Grep tool", () => {
    it("returns context action with GREP_GUIDANCE", () => {
      const result = routePreToolUse("Grep", {
        pattern: "TODO",
        path: "/some/dir",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toBe(GREP_GUIDANCE);
    });
  });

  // ─── WebFetch routing ──────────────────────────────────

  describe("WebFetch tool", () => {
    it("returns deny action with redirect message", () => {
      const result = routePreToolUse("WebFetch", {
        url: "https://docs.example.com",
        prompt: "Get the docs",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      // PR #654 substitute: imperative-positive framing, no "blocked" wording,
      // explicit retry hint to keep Haiku-tier agents from capitulating to
      // training data on transient DNS errors (audit Probe 3).
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).not.toContain("WebFetch blocked");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toMatch(/retry/i);
    });

    it("includes the URL in deny reason", () => {
      const url = "https://api.github.com/repos/test";
      const result = routePreToolUse("WebFetch", { url });
      expect(result).not.toBeNull();
      expect(result!.reason).toContain(url);
    });

    it("treats agy read_url_content URL payloads as WebFetch", () => {
      const url = "https://example.com/docs";
      const result = routePreToolUse(
        "read_url_content",
        { URL: url },
        undefined,
        "antigravity-cli",
        "agy-read-url",
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain(url);
      // agy's call surface is context-mode/<tool> (see hooks/core/tool-naming.mjs),
      // not Claude's mcp__context-mode__<tool> form.
      expect(result!.reason).toContain("context-mode/ctx_fetch_and_index");
    });

    it("treats mcp_web_fetch as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_web_fetch", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("ctx_search");
    });

    it("treats mcp_fetch_tool as WebFetch and blocks it", () => {
      const url = "https://example.com";
      const result = routePreToolUse("mcp_fetch_tool", { url });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("WebFetch redirected");
      expect(result!.reason).toContain("fetch_and_index");
      expect(result!.reason).toContain("ctx_search");
    });

    it("allows WebFetch when MCP server not ready (#230)", () => {
      // Remove sentinel to simulate MCP not started
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("WebFetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });

    it("allows mcp_web_fetch alias when MCP server not ready (#230)", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("mcp_web_fetch", { url: "https://example.com" });
      expect(result).toBeNull();
    });

    it("passes WebFetch through when the caller context cannot invoke ctx_* tools (#794)", () => {
      const result = routePreToolUse(
        "WebFetch",
        { url: "https://example.com" },
        undefined,
        "claude-code",
        "subagent-webfetch",
        { mcpToolsAvailable: false },
      );
      expect(result).toBeNull();
    });

    it("keeps WebFetch redirected when options are omitted", () => {
      const result = routePreToolUse(
        "WebFetch",
        { url: "https://example.com" },
        undefined,
        "claude-code",
        "main-webfetch-default-options",
      );
      expect(result).not.toBeNull();
      expect(result!.action).toBe("deny");
      expect(result!.reason).toContain("ctx_fetch_and_index");
    });

    it("Claude Code pretooluse treats subagent hook payloads as ctx_* unavailable (#794)", async () => {
      const main = await spawnPreToolUseHook({
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com" },
        session_id: "core-routing-main-webfetch",
      });
      expect(main.status).toBe(0);
      expect(main.parsed?.hookSpecificOutput?.permissionDecision).toBe("deny");
      expect(main.parsed?.hookSpecificOutput?.permissionDecisionReason).toContain("ctx_fetch_and_index");

      const subagent = await spawnPreToolUseHook({
        tool_name: "WebFetch",
        tool_input: { url: "https://example.com" },
        session_id: "core-routing-subagent-webfetch",
        agent_id: "agent-794",
        agent_type: "claude-code-guide",
      });
      expect(subagent.status).toBe(0);
      expect(subagent.stdout).toBe("");
    });
  });

  // ─── MCP readiness: all redirects degrade gracefully (#230) ───

  describe("MCP readiness graceful degradation (#230)", () => {
    it("allows curl when MCP server not ready", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("Bash", { command: "curl https://example.com" });
      expect(result).toBeNull();
    });

    it("allows inline HTTP when MCP server not ready", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("Bash", { command: "node -e \"fetch('https://example.com')\"" });
      expect(result).toBeNull();
    });

    it("allows build tools when MCP server not ready", () => {
      try { unlinkSync(mcpSentinel); } catch {}
      const result = routePreToolUse("Bash", { command: "./gradlew build" });
      expect(result).toBeNull();
    });

    it("allows MCP-backed redirects when the caller context cannot invoke ctx_* tools", () => {
      const cases = [
        ["Bash", { command: "curl https://example.com" }],
        ["Bash", { command: "node -e \"fetch('https://example.com')\"" }],
        ["Bash", { command: "./gradlew build" }],
        ["WebFetch", { url: "https://example.com" }],
      ] as const;

      for (const [tool, input] of cases) {
        const result = routePreToolUse(
          tool,
          input,
          undefined,
          "claude-code",
          `subagent-${tool}`,
          { mcpToolsAvailable: false },
        );
        expect(result).toBeNull();
      }
    });
  });

  // ─── Subagent ctx_commands omission (#233) ──────────────

  describe("Subagent ctx_commands omission (#233)", () => {
    it("Agent subagent prompt omits ctx_commands", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Search the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).not.toContain("<ctx_commands>");
      expect(prompt).toContain("<tool_selection_hierarchy>");
    });

    it("injects Claude Code Agent routing and ToolSearch bootstrap by default", () => {
      const result = routePreToolUse("Agent", {
        prompt: "Research this repository",
        subagent_type: "general-purpose",
      });
      expect(result).not.toBeNull();
      expect(result!.action).toBe("modify");
      const prompt = (result!.updatedInput as Record<string, string>).prompt;
      expect(prompt).toContain("<context_window_protection>");
      expect(prompt).toContain("ToolSearch");
      expect(prompt).not.toContain("<ctx_commands>");
    });

    it("ROUTING_BLOCK constant includes ctx_commands for main session", () => {
      expect(ROUTING_BLOCK).toContain("<ctx_commands>");
      expect(ROUTING_BLOCK).toContain("ctx stats");
    });

    it("createRoutingBlock with includeCommands: false omits section", () => {
      const t = (name: string) => `mcp__test__${name}`;
      const block = createRoutingBlock(t, { includeCommands: false });
      expect(block).not.toContain("<ctx_commands>");
      expect(block).toContain("<tool_selection_hierarchy>");
    });

    it("createRoutingBlock default includes ctx_commands", () => {
      const t = (name: string) => `mcp__test__${name}`;
      const block = createRoutingBlock(t);
      expect(block).toContain("<ctx_commands>");
    });
  });

  // ─── Task routing (#241: removed — substring matching catches TaskCreate etc.) ──

  describe("Task tool (#241)", () => {
    it("returns null (passthrough) — no longer intercepted", () => {
      const result = routePreToolUse("Task", {
        prompt: "Analyze the codebase",
        subagent_type: "general-purpose",
      });
      expect(result).toBeNull();
    });

    it("TaskCreate returns null (passthrough)", () => {
      const result = routePreToolUse("TaskCreate", {
        title: "my task",
      });
      expect(result).toBeNull();
    });

    it("TaskUpdate returns null (passthrough)", () => {
      const result = routePreToolUse("TaskUpdate", {
        id: "123",
        status: "done",
      });
      expect(result).toBeNull();
    });
  });

  // ─── MCP tools ─────────────────────────────────────────

  describe("MCP execute tools", () => {
    it("passes through non-shell execute", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_execute",
        { language: "javascript", code: "console.log('hello')" },
      );
      expect(result).toBeNull();
    });

    it("passes through execute_file without security", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        {
          path: "/some/file.log",
          language: "python",
          code: "print(len(FILE_CONTENT))",
        },
      );
      expect(result).toBeNull();
    });

    it("passes through batch_execute without security", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        {
          commands: [{ label: "test", command: "ls -la" }],
          queries: ["file list"],
        },
      );
      expect(result).toBeNull();
    });

    it("pins Claude Code ctx_execute shell cwd from hook projectDir (#756)", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_execute",
        { language: "shell", code: "pwd" },
        "/worktree/repo",
        "claude-code",
      );
      expect(result?.action).toBe("modify");
      expect(result?.updatedInput).toEqual({
        language: "shell",
        code: "pwd",
        cwd: "/worktree/repo",
      });
    });

    it("pins Claude Code ctx_batch_execute cwd from hook projectDir (#756)", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        { commands: [{ label: "branch", command: "git rev-parse --abbrev-ref HEAD" }] },
        "/worktree/repo",
        "claude-code",
      );
      expect(result?.action).toBe("modify");
      expect(result?.updatedInput).toEqual({
        commands: [{ label: "branch", command: "git rev-parse --abbrev-ref HEAD" }],
        cwd: "/worktree/repo",
      });
    });

    it("does not overwrite explicit ctx_execute cwd", () => {
      const result = routePreToolUse(
        "mcp__plugin_context-mode_context-mode__ctx_execute",
        { language: "shell", code: "pwd", cwd: "/explicit" },
        "/worktree/repo",
        "claude-code",
      );
      expect(result).toBeNull();
    });
  });

  describe("Codex context-mode MCP execute security", () => {
    let projectDir: string;

    beforeAll(async () => {
      await initSecurity(resolve(process.cwd(), "build"));
    });

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "ctx-codex-routing-"));
      mkdirSync(join(projectDir, ".claude"), { recursive: true });
      writeFileSync(
        join(projectDir, ".claude", "settings.local.json"),
        JSON.stringify({ permissions: { deny: ["Bash(sudo *)"] } }),
        "utf-8",
      );
    });

    afterEach(() => {
      try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
    });

    it.each([
      ["ctx_execute", { language: "shell", code: "sudo whoami" }],
      ["mcp__other__ctx_execute", { language: "shell", code: "sudo whoami" }],
      ["ctx_execute_file", { path: "script.sh", language: "shell", code: "sudo whoami" }],
      ["mcp__other__ctx_execute_file", { path: "script.sh", language: "shell", code: "sudo whoami" }],
      ["ctx_batch_execute", { commands: [{ label: "bad", command: "sudo whoami" }] }],
      ["mcp__other__ctx_batch_execute", { commands: [{ label: "bad", command: "sudo whoami" }] }],
    ])("denies shell policy matches for %s", (toolName, toolInput) => {
      const result = routePreToolUse(toolName, toolInput, projectDir);
      expect(result?.action).toBe("deny");
      expect(result?.reason).toContain("deny pattern");
    });
  });

  describe("Codex exec_command security policy", () => {
    let projectDir: string;
    let homeDir: string;
    let codexDir: string;
    let previousHome: string | undefined;
    let previousCodexHome: string | undefined;
    let previousPlatform: string | undefined;

    beforeAll(async () => {
      await initSecurity(resolve(process.cwd(), "build"));
    });

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), "ctx-codex-exec-project-"));
      homeDir = mkdtempSync(join(tmpdir(), "ctx-codex-home-"));
      codexDir = join(homeDir, ".codex");
      mkdirSync(codexDir, { recursive: true });
      writeFileSync(
        join(codexDir, "settings.json"),
        JSON.stringify({ permissions: { deny: ["Bash(echo blocked)"] } }),
        "utf-8",
      );
      previousHome = process.env.HOME;
      previousCodexHome = process.env.CODEX_HOME;
      previousPlatform = process.env.CONTEXT_MODE_PLATFORM;
      process.env.HOME = homeDir;
      process.env.CODEX_HOME = codexDir;
      process.env.CONTEXT_MODE_PLATFORM = "codex";
    });

    afterEach(() => {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousPlatform === undefined) delete process.env.CONTEXT_MODE_PLATFORM;
      else process.env.CONTEXT_MODE_PLATFORM = previousPlatform;
      try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
      try { rmSync(homeDir, { recursive: true, force: true }); } catch {}
    });

    it("denies Codex exec_command cmd payloads from .codex settings", () => {
      const result = routePreToolUse(
        "exec_command",
        { cmd: "echo blocked" },
        projectDir,
        "codex",
        "codex-cmd-policy",
      );
      expect(result?.action).toBe("deny");
      expect(result?.reason).toContain("deny pattern");
    });
  });

  // ─── Routing block content ──────────────────────────────

  describe("routing block content", () => {
    // Wording rewritten per ADR-0002 (PR #683 follow-up): the original tests
    // asserted negative framings (`NEVER use`, `NO …`, `NEVER inline`) that
    // failed the cross-LLM safety-bias rubric (#9) and the prompt-surface
    // forbidden-token contract in tests/core/server.test.ts. The new
    // assertions cover the same semantic intent expressed positively:
    //   - file writes go through the native Write/Edit tool
    //   - ctx_execute / ctx_execute_file / Bash subprocesses do not persist edits
    //   - artifacts get written to files (path + 1-line description returned)
    it("file_writing_policy points file writes at native Write/Edit tools", () => {
      expect(ROUTING_BLOCK).toContain("<file_writing_policy>");
      expect(ROUTING_BLOCK).toContain("File writes use the native Write or Edit tool");
      // semantic intent: ctx_execute family must not be used for file writes —
      // expressed positively as "do not persist edits to the host filesystem"
      expect(ROUTING_BLOCK).toContain("ctx_execute");
      expect(ROUTING_BLOCK).toContain("do not persist edits");
    });

    it("when_not_to_use redirects ctx_execute away from file creation", () => {
      // Replaces the old `<forbidden_actions>` container; same semantic intent
      // (do not pick ctx_execute for file creation) expressed via WHEN NOT.
      expect(ROUTING_BLOCK).toContain("<when_not_to_use>");
      expect(ROUTING_BLOCK).toContain("for file writes");
      expect(ROUTING_BLOCK).toContain("analysis, processing, and computation only");
    });

    it("artifact_policy points artifacts at files with file-path return shape", () => {
      // Replaces the old "Write artifacts ... NEVER inline" wording.
      // The semantic intent — write artifacts to files, return only the path
      // plus a 1-line description — is asserted via the positive surface.
      expect(ROUTING_BLOCK).toContain(
        "Write artifacts (code, configs, PRDs) to files",
      );
      expect(ROUTING_BLOCK).toContain("file path + 1-line description");
    });
  });

  // ─── Unknown tools ─────────────────────────────────────

  describe("unknown tools", () => {
    it("returns null for Glob", () => {
      const result = routePreToolUse("Glob", { pattern: "**/*.ts" });
      expect(result).toBeNull();
    });

    it("returns null for Edit", () => {
      const result = routePreToolUse("Edit", {
        file_path: "/some/file.ts",
        old_string: "foo",
        new_string: "bar",
      });
      expect(result).toBeNull();
    });

    it("returns null for Write", () => {
      const result = routePreToolUse("Write", {
        file_path: "/some/file.ts",
        content: "hello",
      });
      expect(result).toBeNull();
    });

    it("returns null for WebSearch", () => {
      const result = routePreToolUse("WebSearch", {
        query: "vitest documentation",
      });
      expect(result).toBeNull();
    });
  });

  // ─── External MCP tools (#529) ──────────────────────────
  //
  // hooks/hooks.json registers a `mcp__(?!plugin_context-mode_)` matcher so
  // PreToolUse fires on slack/telegram/gdrive/notion-style MCPs whose payloads
  // would otherwise spill into context before PostToolUse can act. The routing
  // branch emits a one-shot context guidance nudge — same throttle model as
  // bash/read/grep guidance.
  describe("External MCP tools (#529)", () => {
    it("emits context guidance for an external slack-style MCP tool", () => {
      const result = routePreToolUse("mcp__slack__list_channels", {});
      expect(result).not.toBeNull();
      expect(result!.action).toBe("context");
      expect(result!.additionalContext).toContain("External MCP tools");
    });

    it("emits context guidance for telegram, gdrive, and notion namespaces", () => {
      const tools = [
        "mcp__plugin_telegram__list_messages",
        "mcp__claude_ai_Google_Drive__search",
        "mcp__notion__query_database",
      ];
      for (const tool of tools) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        expect(result, `expected guidance for ${tool}`).not.toBeNull();
        expect(result!.action).toBe("context");
      }
    });

    it("does NOT match context-mode's own MCP tools (no double-firing)", () => {
      // These are routed by dedicated branches above (ctx_execute,
      // ctx_execute_file, ctx_batch_execute) — they must NOT receive the
      // external-MCP guidance, which would be redundant noise.
      const contextModeTools = [
        "mcp__plugin_context-mode_context-mode__ctx_execute",
        "mcp__plugin_context-mode_context-mode__ctx_execute_file",
        "mcp__plugin_context-mode_context-mode__ctx_batch_execute",
        "mcp__context-mode__ctx_execute",
      ];
      for (const tool of contextModeTools) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, { language: "javascript", code: "1+1" });
        // ctx_execute returns null (no security violation, no guidance).
        // The external-MCP branch must NOT have run for these.
        if (result !== null) {
          expect(result.additionalContext ?? "").not.toContain("External MCP tools");
        }
      }
    });

    // #567 follow-up — the external-MCP nudge is intentionally periodic, not
    // one-shot. A single nudge gets lost in MCP-heavy sessions (50+ Jira
    // calls) once context compaction kicks in, so we re-fire every N calls to
    // keep the guidance in the model's recent window.
    it("re-fires guidance every N calls (default cadence = 10)", () => {
      const calls = Array.from({ length: 22 }, (_, i) =>
        routePreToolUse(`mcp__slack__tool_${i}`, {}),
      );

      // Fires on the 1st, 11th, 21st calls — null in between.
      const fired = calls.map((c) => c?.action === "context");
      const expected = calls.map((_, i) => i % 10 === 0);
      expect(fired).toEqual(expected);
    });

    it("honors CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY to tune cadence", () => {
      const prev = process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
      try {
        process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = "3";
        const calls = Array.from({ length: 7 }, (_, i) =>
          routePreToolUse(`mcp__notion__tool_${i}`, {}),
        );
        const fired = calls.map((c) => c?.action === "context");
        // period=3 → fires on calls 1, 4, 7 (indices 0, 3, 6).
        expect(fired).toEqual([true, false, false, true, false, false, true]);
      } finally {
        if (prev === undefined) delete process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
        else process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = prev;
      }
    });

    it("falls back to default cadence on invalid env values", () => {
      const prev = process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
      try {
        // Out-of-range, NaN, negative — all coerce to the default (10).
        for (const v of ["0", "-1", "9999", "not-a-number", ""]) {
          process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = v;
          resetGuidanceThrottle();
          const first = routePreToolUse("mcp__slack__a", {});
          const second = routePreToolUse("mcp__slack__b", {});
          expect(first?.action, `value=${JSON.stringify(v)}`).toBe("context");
          // With default=10, the 2nd call must NOT fire.
          expect(second, `value=${JSON.stringify(v)}`).toBeNull();
        }
      } finally {
        if (prev === undefined) delete process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY;
        else process.env.CONTEXT_MODE_EXTERNAL_MCP_NUDGE_EVERY = prev;
      }
    });

    it("resetGuidanceThrottle resets the periodic counter", () => {
      // Burn one call to advance the counter.
      const first = routePreToolUse("mcp__slack__post_message", {});
      expect(first?.action).toBe("context");
      const second = routePreToolUse("mcp__slack__list_users", {});
      expect(second).toBeNull();

      // Reset clears both the in-memory throttle and the periodic counter so
      // the next call re-fires from tick 1 (e.g. start of a fresh session).
      resetGuidanceThrottle();
      const afterReset = routePreToolUse("mcp__slack__list_users", {});
      expect(afterReset?.action).toBe("context");
    });

    it("does NOT match plain Bash/Read/etc as external MCP", () => {
      // Sanity: tools without the mcp__ prefix should not hit this branch.
      // Use a tool name the routing branches don't otherwise handle (Bash
      // would return a guidance from its own branch).
      const result = routePreToolUse("Glob", { pattern: "**/*.ts" });
      expect(result).toBeNull();
    });

    it("treats external MCP tools whose tool part contains 'context-mode' as external", () => {
      // Guards against the substring-on-full-name false negative: only the
      // server segment (first chunk after the mcp__ prefix) is checked, so a
      // notion / slack / etc tool that happens to mention context-mode in its
      // tool name still receives the external-MCP guidance.
      const externals = [
        "mcp__notion__search_context-mode_notes",
        "mcp__slack__post_to_context-mode_channel",
      ];
      for (const tool of externals) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        expect(result, `expected guidance for ${tool}`).not.toBeNull();
        expect(result!.action).toBe("context");
        expect(result!.additionalContext).toContain("External MCP tools");
      }
    });

    it("does NOT trip on degenerate tool names (empty / bare prefix / null)", () => {
      // String() coerces these to non-MCP names — must pass through silently.
      for (const tool of ["", "mcp__", null as unknown as string, undefined as unknown as string]) {
        resetGuidanceThrottle();
        const result = routePreToolUse(tool, {});
        // Either null (passthrough) or NOT external-MCP guidance — never the
        // external-MCP branch.
        if (result !== null) {
          expect(result.additionalContext ?? "").not.toContain("External MCP tools");
        }
      }
    });
  });
});
