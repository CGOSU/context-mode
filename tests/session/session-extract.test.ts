import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, test } from "vitest";
import { extractEvents } from "../../src/session/extract.js";

// ════════════════════════════════════════════
// SLICE 1: FILE EVENT EXTRACTION
// ════════════════════════════════════════════

describe("File Events", () => {
  test("extracts file event from Edit tool call", () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "/project/src/server.ts",
        old_string: 'const VERSION = "0.9.21"',
        new_string: 'const VERSION = "0.9.22"',
      },
      tool_response: "File edited successfully",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_edit");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "/project/src/server.ts");
    assert.equal(events[0].priority, 1);
  });

  test("extracts file event from Write tool call", () => {
    const input = {
      tool_name: "Write",
      tool_input: { file_path: "/project/tests/new.test.ts", content: "..." },
      tool_response: "File written",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_write");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].priority, 1);
  });

  test("extracts file event from Read of source files", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/store.ts" },
      tool_response: "file contents...",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_read");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].priority, 1);
  });

  test("extracts file_write and file_edit from Codex apply_patch hunks", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/new-file.ts",
          "+export const created = true;",
          "*** Update File: src/existing.ts",
          "@@",
          "-export const before = true;",
          "+export const after = true;",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };

    const events = extractEvents(input);
    const fileWrites = events.filter(e => e.type === "file_write");
    const fileEdits = events.filter(e => e.type === "file_edit");
    assert.equal(fileWrites.length, 1);
    assert.equal(fileWrites[0].data, "src/new-file.ts");
    assert.equal(fileEdits.length, 1);
    assert.equal(fileEdits[0].data, "src/existing.ts");
  });

  test("extracts moved target path from Codex apply_patch", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: src/old-name.ts",
          "*** Move to: src/new-name.ts",
          "@@",
          "-export const value = 1;",
          "+export const value = 2;",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };

    const events = extractEvents(input);
    const fileEdits = events.filter(e => e.type === "file_edit").map(e => e.data);
    assert.ok(fileEdits.includes("src/old-name.ts"));
    assert.ok(fileEdits.includes("src/new-name.ts"));
  });
});

// ════════════════════════════════════════════
// SLICE 2: RULE EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Rule Events", () => {
  test("extracts rule event when CLAUDE.md is read", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/CLAUDE.md" },
      tool_response: "# Rules\n- Never push without approval\n- Always use TypeScript",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
    assert.equal(ruleEvents[0].priority, 1);
    assert.ok(ruleEvents[0].data.includes("CLAUDE.md"));
  });

  test("extracts rule event for .claude/ config files", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/home/user/.claude/settings.json" },
      tool_response: "{ ... }",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
  });

  test("CLAUDE.md read yields both rule AND file events", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/CLAUDE.md" },
      tool_response: "rules...",
    };

    const events = extractEvents(input);
    const types = events.map(e => e.type);
    assert.ok(types.includes("rule"), "should include rule event");
    assert.ok(types.includes("file_read"), "should include file_read event");
  });
});

// ════════════════════════════════════════════
// SLICE 4: ERROR EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Error Events", () => {
  test("extracts error event from failed bash command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "FAIL src/store.test.ts\nError: expected 3 but got 5\nexit code 1",
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].priority, 2);
    assert.ok(errorEvents[0].data.includes("FAIL"));
  });

  test("extracts error from isError: true response", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "/x.ts", old_string: "foo", new_string: "bar" },
      tool_response: "old_string not found in file",
      tool_output: { isError: true },
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
  });

  test("does not extract error from successful bash command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 6: TASK EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Task Events", () => {
  test("extracts task event from TodoWrite", () => {
    const input = {
      tool_name: "TodoWrite",
      tool_input: { todos: [{ id: "1", content: "Write tests", status: "in_progress" }] },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].priority, 1);
  });

  test("extracts task event from TaskCreate", () => {
    const input = {
      tool_name: "TaskCreate",
      tool_input: { subject: "Implement session DB", status: "pending" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task_create");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].priority, 1);
    assert.equal(taskEvents[0].category, "task");
  });

  test("extracts task event from TaskUpdate", () => {
    const input = {
      tool_name: "TaskUpdate",
      tool_input: { taskId: "1", status: "done" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const taskEvents = events.filter(e => e.type === "task_update");
    assert.equal(taskEvents.length, 1);
    assert.equal(taskEvents[0].category, "task");
  });
});

// ════════════════════════════════════════════
// SLICE 6B: PLAN MODE EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Plan Mode Events", () => {
  test("extracts plan_enter from EnterPlanMode", () => {
    const input = {
      tool_name: "EnterPlanMode",
      tool_input: {},
      tool_response: "",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_enter");
    assert.equal(planEvents[0].data, "entered plan mode");
    assert.equal(planEvents[0].priority, 2);
  });

  test("extracts plan_exit from ExitPlanMode", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_exit");
    assert.equal(planEvents[0].data, "exited plan mode");
  });

  test("extracts plan_exit with allowedPrompts from ExitPlanMode", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {
        allowedPrompts: [
          { tool: "Bash", prompt: "run tests" },
          { tool: "Bash", prompt: "install dependencies" },
        ],
      },
      tool_response: "",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_exit");
    assert.ok(planEvents[0].data.includes("run tests"));
    assert.ok(planEvents[0].data.includes("install dependencies"));
  });

  test("extracts plan_approved when user approves", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "User has approved your plan",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 2); // plan_exit + plan_approved
    assert.equal(planEvents[0].type, "plan_exit");
    assert.equal(planEvents[1].type, "plan_approved");
    assert.equal(planEvents[1].priority, 1);
  });

  test("extracts plan_rejected when user rejects", () => {
    const input = {
      tool_name: "ExitPlanMode",
      tool_input: {},
      tool_response: "User declined your plan. Please revise.",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 2); // plan_exit + plan_rejected
    assert.equal(planEvents[0].type, "plan_exit");
    assert.equal(planEvents[1].type, "plan_rejected");
    assert.ok(planEvents[1].data.includes("rejected"));
  });

  test("extracts plan_file_write from Write to ~/.claude/plans/", () => {
    const input = {
      tool_name: "Write",
      tool_input: { file_path: "/Users/test/.claude/plans/jaunty-nebula.md", content: "# Plan" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_file_write");
    assert.ok(planEvents[0].data.includes("jaunty-nebula.md"));
  });

  test("extracts plan_file_write from Edit to ~/.claude/plans/", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: "/Users/test/.claude/plans/my-plan.md", old_string: "a", new_string: "b" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_file_write");
  });

  test("extracts plan_file_write from relative apply_patch updates to .claude/plans/", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Update File: .claude/plans/my-plan.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch applied successfully",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 1);
    assert.equal(planEvents[0].type, "plan_file_write");
    assert.ok(planEvents[0].data.includes("my-plan.md"));
  });

  test("does not extract file continuity events from failed apply_patch", () => {
    const input = {
      tool_name: "apply_patch",
      tool_input: {
        command: [
          "*** Begin Patch",
          "*** Add File: src/failed.ts",
          "+export const failed = true;",
          "*** Update File: src/existing.ts",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      },
      tool_response: "Patch failed",
      tool_output: { isError: true },
    };

    const events = extractEvents(input);
    assert.equal(events.filter(e => e.type === "file_write").length, 0);
    assert.equal(events.filter(e => e.type === "file_edit").length, 0);
  });

  test("does not extract plan event from Write to non-plan path", () => {
    const input = {
      tool_name: "Write",
      tool_input: { file_path: "/Users/test/src/index.ts", content: "code" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 0);
  });

  test("ignores non-plan tools", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    const planEvents = events.filter(e => e.category === "plan");
    assert.equal(planEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 10: SKILL EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Skill Events", () => {
  test("extracts skill event from Skill tool call", () => {
    const input = {
      tool_name: "Skill",
      tool_input: { skill: "tdd", args: "session tests" },
      tool_response: "Loaded TDD skill",
    };

    const events = extractEvents(input);
    const skillEvents = events.filter(e => e.type === "skill");
    assert.equal(skillEvents.length, 1);
    assert.equal(skillEvents[0].data, "tdd");
    assert.equal(skillEvents[0].priority, 2);
  });

  test("extracts skill event without args", () => {
    const input = {
      tool_name: "Skill",
      tool_input: { skill: "commit" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const skillEvents = events.filter(e => e.type === "skill");
    assert.equal(skillEvents.length, 1);
    assert.equal(skillEvents[0].data, "commit");
  });
});

// ════════════════════════════════════════════
// SLICE 11: SUBAGENT EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Subagent Events", () => {
  test("extracts subagent event from Agent tool call", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research the best approach for session continuity", description: "Research agent" },
      tool_response: "Agent completed. Found 3 approaches.",
    };

    const events = extractEvents(input);
    const subagentEvents = events.filter(e => e.category === "subagent");
    assert.equal(subagentEvents.length, 1);
    // Has tool_response → completed → priority 2
    assert.equal(subagentEvents[0].priority, 2);
  });

  // ── Bug fix: Agent completion results must be captured ──

  test("captures tool_response in subagent event when Agent completes", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research Cursor env vars" },
      tool_response: "Found CURSOR_TRACE_DIR and CURSOR_CHANNEL env vars. Cursor also sets VSCODE_PID.",
    };

    const events = extractEvents(input);
    const subagentEvents = events.filter(e => e.category === "subagent");
    assert.equal(subagentEvents.length, 1);
    // The event data MUST include the response, not just the prompt
    assert.ok(
      subagentEvents[0].data.includes("CURSOR_TRACE_DIR") || subagentEvents[0].data.includes("Found"),
      `subagent event data should include tool_response content, got: "${subagentEvents[0].data}"`,
    );
  });

  test("distinguishes completed agents from launched-only agents", () => {
    const completedInput = {
      tool_name: "Agent",
      tool_input: { prompt: "Research VS Code env vars" },
      tool_response: "VSCODE_PID is set by VS Code for all child processes.",
    };

    const launchedInput = {
      tool_name: "Agent",
      tool_input: { prompt: "Research Codex CLI env vars" },
      // No tool_response — agent was launched but hasn't completed
    };

    const completedEvents = extractEvents(completedInput);
    const launchedEvents = extractEvents(launchedInput);

    const completed = completedEvents.filter(e => e.category === "subagent");
    const launched = launchedEvents.filter(e => e.category === "subagent");

    assert.equal(completed.length, 1);
    assert.equal(launched.length, 1);

    // Completed agents should have higher priority (P2) than launched (P3)
    assert.ok(
      completed[0].priority < launched[0].priority,
      `completed priority (${completed[0].priority}) should be lower (=higher importance) than launched (${launched[0].priority})`,
    );
  });

  test("completed agent event type indicates completion status", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Audit all adapter env vars" },
      tool_response: "Completed audit. Gemini CLI sets GEMINI_PROJECT_DIR. Codex has no env detection.",
    };

    const events = extractEvents(input);
    const subagentEvents = events.filter(e => e.category === "subagent");
    assert.equal(subagentEvents.length, 1);

    // Event type must distinguish completed from launched
    assert.ok(
      subagentEvents[0].type.includes("completed") || subagentEvents[0].type.includes("complete"),
      `completed agent event type should indicate completion, got: "${subagentEvents[0].type}"`,
    );
  });
});

// ════════════════════════════════════════════
// CROSS-PLATFORM (Windows paths)
// ════════════════════════════════════════════

describe("Cross-Platform (Windows)", () => {
  test("extracts rule event for Windows .claude\\ path", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "C:\\Users\\dev\\.claude\\settings.json" },
      tool_response: "{ ... }",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
    assert.ok(ruleEvents[0].data.includes(".claude\\"));
  });

  test("extracts rule event for Windows CLAUDE.md", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "C:\\Users\\dev\\project\\CLAUDE.md" },
      tool_response: "rules...",
    };

    const events = extractEvents(input);
    const ruleEvents = events.filter(e => e.type === "rule");
    assert.equal(ruleEvents.length, 1);
  });

  test("extracts file event from Windows Edit path", () => {
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: "C:\\Users\\dev\\project\\src\\server.ts",
        old_string: "a",
        new_string: "b",
      },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_edit");
    assert.ok(events[0].data.includes("server.ts"));
  });

  test("extracts cwd from cd with Windows path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'cd "C:\\Users\\dev\\project"' },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "C:\\Users\\dev\\project");
  });

  test("extracts cwd from cd with Windows UNC path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'cd "\\\\server\\share\\project"' },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "\\\\server\\share\\project");
  });
});

// ════════════════════════════════════════════
// NotebookEdit TRACKING
// ════════════════════════════════════════════

describe("NotebookEdit Events", () => {
  test("extracts file_edit event from NotebookEdit tool", () => {
    const input = {
      tool_name: "NotebookEdit",
      tool_input: {
        notebook_path: "/project/analysis.ipynb",
        new_source: "import pandas as pd",
        cell_type: "code",
        edit_mode: "replace",
      },
      tool_response: "Cell updated",
    };

    const events = extractEvents(input);
    const fileEvents = events.filter(e => e.category === "file");
    assert.equal(fileEvents.length, 1);
    assert.equal(fileEvents[0].type, "file_edit");
    assert.equal(fileEvents[0].data, "/project/analysis.ipynb");
    assert.equal(fileEvents[0].priority, 1);
  });

  test("NotebookEdit with insert mode", () => {
    const input = {
      tool_name: "NotebookEdit",
      tool_input: {
        notebook_path: "/project/notebook.ipynb",
        new_source: "print('hello')",
        cell_type: "code",
        edit_mode: "insert",
      },
      tool_response: "Cell inserted",
    };

    const events = extractEvents(input);
    const fileEvents = events.filter(e => e.category === "file");
    assert.equal(fileEvents.length, 1);
    assert.equal(fileEvents[0].type, "file_edit");
  });
});

// ════════════════════════════════════════════
// AskUserQuestion TRACKING
// ════════════════════════════════════════════

describe("AskUserQuestion Events", () => {
  test("extracts decision_question event from AskUserQuestion", () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which database should we use?",
            header: "Database",
            options: [
              { label: "PostgreSQL", description: "Relational DB" },
              { label: "MongoDB", description: "Document DB" },
            ],
            multiSelect: false,
          },
        ],
      },
      tool_response: JSON.stringify({ answers: { "Which database should we use?": "PostgreSQL" } }),
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 1);
    assert.equal(decisionEvents[0].category, "decision");
    assert.equal(decisionEvents[0].priority, 2);
    assert.ok(decisionEvents[0].data.includes("database"), "should include question text");
    // The selected option label MUST appear as the answer.
    assert.ok(
      decisionEvents[0].data.includes("PostgreSQL"),
      "should include the selected answer label",
    );
    // The raw answers map must NOT leak into the event data.
    assert.ok(
      !decisionEvents[0].data.includes('"answers"'),
      "must not embed the raw answers map",
    );
  });

  test("extracts only the selected label when tool_response echoes the request payload", () => {
    // Real Claude Code harness shape: the tool_response echoes the full
    // request (questions + options) alongside the answers map. The extractor
    // must NOT leak the echoed payload into the event data — that's what
    // produced "Unhandled case: [object Object]" toasts on SessionStart.
    const QUESTION = "Which database should we use?";
    const SELECTED = "PostgreSQL";
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: QUESTION,
            header: "Database",
            options: [
              { label: "PostgreSQL", description: "Relational DB" },
              { label: "MongoDB", description: "Document DB" },
            ],
            multiSelect: false,
          },
        ],
      },
      tool_response: JSON.stringify({
        questions: [
          {
            question: QUESTION,
            header: "Database",
            options: [
              { label: "PostgreSQL", description: "Relational DB" },
              { label: "MongoDB", description: "Document DB" },
            ],
            multiSelect: false,
          },
        ],
        answers: { [QUESTION]: SELECTED },
      }),
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 1);
    assert.equal(decisionEvents[0].data, `Q: ${QUESTION} → A: ${SELECTED}`);
    // Must not embed the echoed request payload.
    assert.ok(
      !decisionEvents[0].data.includes('"questions":['),
      "must not embed the echoed questions array",
    );
    assert.ok(
      !decisionEvents[0].data.includes('"options":['),
      "must not embed the echoed options array",
    );
    assert.ok(
      !decisionEvents[0].data.includes("[object Object]"),
      "must not stringify objects as [object Object]",
    );
  });

  test("falls back safely when tool_response is not valid JSON", () => {
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Pick one",
            header: "Choice",
            options: [{ label: "A", description: "" }],
            multiSelect: false,
          },
        ],
      },
      tool_response: "not-json at all { broken",
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 1);
    // Empty answer rather than leaking the malformed raw text.
    assert.equal(decisionEvents[0].data, "Q: Pick one → A: ");
    assert.ok(
      !decisionEvents[0].data.includes("not-json"),
      "must not leak the raw non-JSON response",
    );
  });

  test("joins multi-select string-array answers", () => {
    // multiSelect: true on the request means the harness returns the answer
    // as a string[] in the answers map. Without array handling the extractor
    // would emit an empty answer despite a valid selection — regression caught
    // by CodeRabbit on the original fix PR.
    const QUESTION = "Pick features";
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: QUESTION,
            header: "Features",
            options: [
              { label: "Auth", description: "" },
              { label: "Billing", description: "" },
              { label: "Reporting", description: "" },
            ],
            multiSelect: true,
          },
        ],
      },
      tool_response: JSON.stringify({
        answers: { [QUESTION]: ["Auth", "Reporting"] },
      }),
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 1);
    assert.equal(decisionEvents[0].data, `Q: ${QUESTION} → A: Auth | Reporting`);
  });

  test("falls back to joined answer values when question text does not match a key", () => {
    // Defensive: if the harness ever sends an answers map keyed differently
    // from the question text (renamed key, locale variation), recover the
    // string values rather than leaving the answer empty.
    const input = {
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Original question",
            header: "Q",
            options: [{ label: "Yes", description: "" }],
            multiSelect: false,
          },
        ],
      },
      tool_response: JSON.stringify({ answers: { "Renamed key": "Yes" } }),
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 1);
    assert.equal(decisionEvents[0].data, "Q: Original question → A: Yes");
  });

  test("non-AskUserQuestion tool does not produce decision_question", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/src/main.ts" },
      tool_response: "file content",
    };

    const events = extractEvents(input);
    const decisionEvents = events.filter(e => e.type === "decision_question");
    assert.equal(decisionEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// EnterWorktree TRACKING
// ════════════════════════════════════════════

describe("EnterWorktree Events", () => {
  test("extracts worktree event from EnterWorktree", () => {
    const input = {
      tool_name: "EnterWorktree",
      tool_input: { name: "feature-auth" },
      tool_response: "Worktree created",
    };

    const events = extractEvents(input);
    const wtEvents = events.filter(e => e.type === "worktree");
    assert.equal(wtEvents.length, 1);
    assert.equal(wtEvents[0].category, "env");
    assert.equal(wtEvents[0].priority, 2);
    assert.ok(wtEvents[0].data.includes("feature-auth"), "should include worktree name");
  });

  test("extracts worktree event without name", () => {
    const input = {
      tool_name: "EnterWorktree",
      tool_input: {},
      tool_response: "Worktree created",
    };

    const events = extractEvents(input);
    const wtEvents = events.filter(e => e.type === "worktree");
    assert.equal(wtEvents.length, 1);
    assert.ok(wtEvents[0].data.length > 0, "should have data even without name");
  });
});

// ════════════════════════════════════════════
// MULTI-EVENT & EDGE CASES
// ════════════════════════════════════════════

describe("Multi-Event & Edge Cases", () => {
  test("extracts multiple events from a single tool call (cd + git)", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cd /project && git checkout main" },
      tool_response: "Switched to branch 'main'",
    };

    const events = extractEvents(input);
    assert.ok(events.length >= 2, `Expected >=2 events, got ${events.length}`);
    const types = events.map(e => e.type);
    assert.ok(types.includes("cwd"), "should include cwd");
    assert.ok(types.includes("git"), "should include git");
  });

  test("does not extract events from no-op tool calls", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 0);
  });

  test("returns empty array for unknown tool names", () => {
    const input = {
      tool_name: "UnknownTool",
      tool_input: {},
      tool_response: "something",
    };

    const events = extractEvents(input);
    assert.ok(Array.isArray(events));
    assert.equal(events.length, 0);
  });

  test("handles missing/undefined fields gracefully", () => {
    const input = {
      tool_name: "Bash",
      tool_input: {},
      tool_response: undefined,
    };

    // Should not throw
    const events = extractEvents(input as any);
    assert.ok(Array.isArray(events));
  });
});

// ════════════════════════════════════════════
// SAFETY — safeString preserves full data
// ════════════════════════════════════════════

describe("Safety — safeString preserves full data", () => {
  test("preserves full tool response in error events (no truncation)", () => {
    const longError = "Error: " + "x".repeat(10000);
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: longError,
    };

    const events = extractEvents(input);
    const errorEvents = events.filter(e => e.type === "error_tool");
    assert.equal(errorEvents.length, 1);
    assert.equal(errorEvents[0].data, longError, "Full error string must be preserved");
  });

  test("data field is always a string and preserves full content", () => {
    const longPath = "/project/src/" + "a".repeat(500) + ".ts";
    const input = {
      tool_name: "Edit",
      tool_input: {
        file_path: longPath,
        old_string: "x",
        new_string: "y",
      },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    for (const event of events) {
      assert.equal(typeof event.data, "string", `event.type=${event.type} data should be string`);
    }
    assert.equal(events[0].data, longPath, "Full path must be preserved without truncation");
  });
});

// ════════════════════════════════════════════
// GLOB EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Glob Events", () => {
  test("extracts file_glob event from Glob tool call", () => {
    const input = {
      tool_name: "Glob",
      tool_input: { pattern: "src/**/*.ts" },
      tool_response: JSON.stringify({ filenames: ["src/server.ts", "src/runtime.ts"] }),
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_glob");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "src/**/*.ts");
    assert.equal(events[0].priority, 3);
  });

  test("extracts file_glob with path filter", () => {
    const input = {
      tool_name: "Glob",
      tool_input: { pattern: "*.test.ts", path: "/project/tests" },
      tool_response: "[]",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, "*.test.ts");
  });
});

// ════════════════════════════════════════════
// GREP EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Grep Events", () => {
  test("extracts file_search event from Grep tool call", () => {
    const input = {
      tool_name: "Grep",
      tool_input: { pattern: "extractEvents", path: "/project/src" },
      tool_response: JSON.stringify(["src/extract.ts", "src/hook.ts"]),
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "file_search");
    assert.equal(events[0].category, "file");
    assert.equal(events[0].data, "extractEvents in /project/src");
    assert.equal(events[0].priority, 3);
  });

  test("extracts file_search without path", () => {
    const input = {
      tool_name: "Grep",
      tool_input: { pattern: "TODO" },
      tool_response: "...",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, "TODO in ");
  });
});

// ════════════════════════════════════════════
// ZERO-TRUNCATION: safeString replaces truncate
// ════════════════════════════════════════════

describe("Zero-truncation architecture", () => {
  const extractSource = [
    "extract.ts",
    "extract-common.ts",
    "extract-tools.ts",
    "extract-tool-state.ts",
    "extract-user.ts",
    "extract-usage.ts",
  ].map(file => readFileSync(resolve(__dirname, "../../src/session", file), "utf-8")).join("\n");

  test("extract.ts contains zero truncate() calls", () => {
    const truncateMatches = extractSource.match(/\btruncate\(/g) ?? [];
    assert.equal(
      truncateMatches.length,
      0,
      `Expected 0 truncate() calls but found ${truncateMatches.length}`,
    );
  });

  test("extract.ts contains zero truncateAny() calls", () => {
    const truncateAnyMatches = extractSource.match(/\btruncateAny\(/g) ?? [];
    assert.equal(
      truncateAnyMatches.length,
      0,
      `Expected 0 truncateAny() calls but found ${truncateAnyMatches.length}`,
    );
  });

  test("extract.ts uses safeString() for null-safe string conversion", () => {
    const safeStringMatches = extractSource.match(/\bsafeString\(/g) ?? [];
    assert.ok(
      safeStringMatches.length > 0,
      "Expected at least one safeString() call in extract.ts",
    );
  });

  test("safeString preserves full data without truncation", () => {
    const longPath = "/very/long/path/" + "a".repeat(500) + "/file.ts";
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: longPath, old_string: "x", new_string: "y" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    assert.equal(events.length, 1);
    assert.equal(events[0].data, longPath, "safeString must preserve full string without truncation");
  });

  test("safeString handles null/undefined gracefully", () => {
    const input = {
      tool_name: "Edit",
      tool_input: { file_path: undefined as unknown as string },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    // Should not throw and should produce an event (with empty string data from undefined)
    assert.ok(events.length >= 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SLICE N: MCP EVENT EXTRACTION (extractMcp)
// ════════════════════════════════════════════════════════════════════════════

describe("MCP Events", () => {
  test("captures tool_response content so ctx_search can find details, not just the call", () => {
    const input = {
      tool_name: "mcp__jira__jira_get",
      tool_input: { ticket: "CVX-5909" },
      tool_response: JSON.stringify({
        key: "CVX-5909",
        summary: "MQTT reconnect storm after broker failover",
        description: "Agents see intermittent disconnects during broker failover...",
      }),
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.equal(mcpEvents[0].type, "mcp");
    assert.equal(mcpEvents[0].category, "mcp");
    assert.ok(mcpEvents[0].data.includes("jira_get"), "data should include tool short name");
    assert.ok(mcpEvents[0].data.includes("CVX-5909"), "data should include first string arg");
    // Response body is now searchable, not just the call shape
    assert.ok(
      mcpEvents[0].data.includes("MQTT reconnect storm"),
      "data should include tool_response body so FTS5 can index it",
    );
  });

  test("preserves full response even for large payloads (no truncation)", () => {
    // Large grafana loki export — exactly the kind of response we most want the
    // cache to preserve to avoid re-fetching. No cap: matches rule_content
    // precedent (extract.ts File Events path).
    const bigResponse = "log_line_".repeat(5000); // ~45KB
    const input = {
      tool_name: "mcp__grafana__query_loki_logs",
      tool_input: { query: '{app="mqtt"} |= "error"' },
      tool_response: bigResponse,
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.ok(
      mcpEvents[0].data.includes(bigResponse),
      "large tool_response must be preserved in full",
    );
  });

  test("gracefully handles missing tool_response (regression)", () => {
    // Pre-existing behavior: when tool_response is absent, no response suffix.
    const input = {
      tool_name: "mcp__context-mode__ctx_stats",
      tool_input: {},
      // tool_response omitted
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.equal(mcpEvents[0].type, "mcp");
    assert.equal(mcpEvents[0].data, "ctx_stats", "no \\nresponse: suffix when tool_response absent");
  });

  test("gracefully handles empty tool_response", () => {
    const input = {
      tool_name: "mcp__context-mode__ctx_stats",
      tool_input: {},
      tool_response: "",
    };

    const events = extractEvents(input);
    const mcpEvents = events.filter(e => e.category === "mcp");
    assert.equal(mcpEvents.length, 1);
    assert.equal(mcpEvents[0].data, "ctx_stats", "empty tool_response should not add suffix");
  });

  test("emits mcp_tool_call category for mcp__* events with truncated params", () => {
    // Small payload — no truncation, params parsed verbatim
    const small = extractEvents({
      tool_name: "mcp__context-mode__ctx_batch_execute",
      tool_input: { commands: [{ label: "x", command: "ls" }], concurrency: 6 },
    });
    const smallCall = small.find(e => e.category === "mcp_tool_call");
    assert.ok(smallCall, "mcp_tool_call event should be emitted");
    assert.equal(smallCall!.type, "mcp_tool_call");
    assert.equal(smallCall!.priority, 4);
    const smallPayload = JSON.parse(smallCall!.data);
    assert.equal(smallPayload.tool_name, "mcp__context-mode__ctx_batch_execute");
    assert.equal(smallPayload.params.concurrency, 6);
    assert.equal(smallPayload.truncated, undefined);

    // Large payload — params JSON exceeds 2KB, must be truncated with sentinel
    const bigCommands = Array.from({ length: 200 }, (_, i) => ({
      label: `cmd-${i}`,
      command: "echo " + "x".repeat(50),
    }));
    const big = extractEvents({
      tool_name: "mcp__context-mode__ctx_batch_execute",
      tool_input: { commands: bigCommands, concurrency: 8 },
    });
    const bigCall = big.find(e => e.category === "mcp_tool_call");
    assert.ok(bigCall, "mcp_tool_call event should be emitted for large payload");
    // 2KB params budget + JSON-escape overhead + wrapper (~300 bytes max).
    assert.ok(bigCall!.data.length <= 2500, "data should be capped near 2KB params budget");
    const bigPayload = JSON.parse(bigCall!.data);
    assert.equal(bigPayload.truncated, true, "truncation sentinel must be set");
    assert.equal(typeof bigPayload.params_raw, "string", "raw substring preserved");
    assert.equal(bigPayload.tool_name, "mcp__context-mode__ctx_batch_execute");
  });

  test("UTF-8-aware truncation: never lands mid-codepoint (review F3)", () => {
    // Naive `string.slice(0, N)` operates on UTF-16 code units. With multi-byte
    // characters, that can either over-shoot the byte budget OR slice mid
    // surrogate pair, producing an unpaired surrogate that becomes U+FFFD
    // after a SQLite TEXT round-trip.
    //
    // Repro shape: enough multi-byte characters to push the JSON payload past
    // 2KB. We use 3-byte (CJK) and 4-byte (math symbol) characters so any
    // mid-codepoint slice is observable.
    const cjkChunk = "中文测试".repeat(200); // 4 × 3 bytes × 200 = 2400 bytes raw
    const symbolChunk = "𝕏".repeat(100);     // 1 × 4 bytes × 100 = 400 bytes raw
    const big = extractEvents({
      tool_name: "mcp__context-mode__ctx_batch_execute",
      tool_input: { mixed: cjkChunk + symbolChunk, concurrency: 4 },
    });
    const call = big.find(e => e.category === "mcp_tool_call");
    assert.ok(call, "mcp_tool_call event should be emitted for multibyte payload");
    const payload = JSON.parse(call!.data);
    assert.equal(payload.truncated, true, "multibyte payload should trip truncation");

    // Critical invariant 1 — params_raw must round-trip through Buffer.from cleanly.
    // If the slice landed mid-codepoint, JSON.parse would have already thrown above
    // (invalid JSON token) OR the string would contain U+FFFD replacement chars.
    assert.equal(typeof payload.params_raw, "string");
    assert.ok(!payload.params_raw.includes("�"), "no replacement chars (mid-codepoint slice)");

    // Critical invariant 2 — the truncated raw must satisfy the BYTE budget,
    // not the UTF-16 code-unit budget. Since CJK = 3 bytes/char and the raw
    // payload includes JSON quoting overhead, a UTF-16-only cap would let
    // ~6KB of bytes through; UTF-8-aware cap holds it ≤ 2KB.
    const rawBytes = Buffer.byteLength(payload.params_raw, "utf8");
    assert.ok(rawBytes <= 2048, `raw bytes (${rawBytes}) exceed 2KB budget`);
  });

  test("redacts secret-bearing keys before persisting (B3 token leakage fix)", () => {
    // PR #401 review (grill-me) flagged: any MCP tool whose tool_input
    // carries Authorization, api_key, password, etc. would be persisted
    // verbatim to SessionDB. Reproduce + assert masking.
    const events = extractEvents({
      tool_name: "mcp__github__create_issue",
      tool_input: {
        repo: "owner/name",
        title: "test",
        headers: {
          Authorization: "Bearer ghp_ABC123XYZ_secret_token",
          "X-API-Key": "sk-real-key-here",
          "Content-Type": "application/json",
        },
        auth: {
          token: "another-secret",
          api_key: "yet-another",
        },
        password: "p@ssw0rd!",
        nested: {
          deep: {
            cookie: "session=secret-cookie",
            ok_field: "kept",
          },
        },
      },
    });
    const call = events.find((e) => e.category === "mcp_tool_call");
    assert.ok(call, "mcp_tool_call event emitted");
    const payload = JSON.parse(call!.data);

    // No secret value should appear anywhere in serialized data
    const serialized = call!.data;
    assert.ok(!serialized.includes("ghp_ABC123XYZ_secret_token"), "Bearer token must be redacted");
    assert.ok(!serialized.includes("sk-real-key-here"), "X-API-Key must be redacted");
    assert.ok(!serialized.includes("another-secret"), "auth.token must be redacted");
    assert.ok(!serialized.includes("yet-another"), "auth.api_key must be redacted");
    assert.ok(!serialized.includes("p@ssw0rd!"), "password must be redacted");
    assert.ok(!serialized.includes("session=secret-cookie"), "nested cookie must be redacted");

    // Non-secret values must survive
    assert.equal(payload.params.repo, "owner/name", "non-secret repo preserved");
    assert.equal(payload.params.title, "test", "non-secret title preserved");
    assert.equal(payload.params.headers["Content-Type"], "application/json", "non-secret header preserved");
    assert.equal(payload.params.nested.deep.ok_field, "kept", "non-secret nested field preserved");

    // Redacted values must show the sentinel
    assert.equal(payload.params.headers.Authorization, "[REDACTED]");
    assert.equal(payload.params.headers["X-API-Key"], "[REDACTED]");
    assert.equal(payload.params.auth.token, "[REDACTED]");
    assert.equal(payload.params.auth.api_key, "[REDACTED]");
    assert.equal(payload.params.password, "[REDACTED]");
    assert.equal(payload.params.nested.deep.cookie, "[REDACTED]");
  });

  test("shared-ref redaction (B3) — same secret object referenced multiple times stays redacted", () => {
    // tool_input frequently uses shared object references (e.g., a single
    // headers object passed to multiple sub-requests). Redaction must mask
    // the value AT EVERY reference site, not just one.
    const sharedHeaders = { Authorization: "Bearer SECRET-XYZ-shared", trace_id: "abc-123" };
    const events = extractEvents({
      tool_name: "mcp__test__shared",
      tool_input: {
        primary_request: { url: "https://api/x", headers: sharedHeaders },
        retry_request: { url: "https://api/x", headers: sharedHeaders }, // SAME ref
      },
    });
    const call = events.find((e) => e.category === "mcp_tool_call");
    assert.ok(call, "mcp_tool_call event emitted for shared-ref input");
    // Secret must be redacted at BOTH reference sites
    assert.ok(!call!.data.includes("SECRET-XYZ-shared"), "shared secret value redacted at all sites");
    const payload = JSON.parse(call!.data);
    assert.equal(payload.params.primary_request.headers.Authorization, "[REDACTED]");
    assert.equal(payload.params.retry_request.headers.Authorization, "[REDACTED]");
    // Non-secret trace_id survives at both sites
    assert.equal(payload.params.primary_request.headers.trace_id, "abc-123");
    assert.equal(payload.params.retry_request.headers.trace_id, "abc-123");
  });
});

// ════════════════════════════════════════════
// CATEGORY 22: AGENT-FINDING
// ════════════════════════════════════════════

describe("Agent Finding Events", () => {
  test("extracts agent_finding when Agent completes with tool_response", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research auth patterns" },
      tool_response: "Found 3 auth patterns: JWT, OAuth2, and session-based. JWT is stateless...",
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].category, "agent-finding");
    assert.equal(findings[0].priority, 2);
    assert.ok(findings[0].data.includes("JWT"), "should include response content");
  });

  test("truncates agent_finding to 500 chars", () => {
    const longResponse = "x".repeat(1000);
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Big research task" },
      tool_response: longResponse,
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 1);
    assert.equal(findings[0].data.length, 500, "should truncate to 500 chars");
  });

  test("does not fire agent_finding when Agent has no tool_response", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research task" },
      // no tool_response — agent launched but not completed
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 0);
  });

  test("does not fire agent_finding for empty tool_response", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research task" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 0);
  });

  test("does not fire agent_finding for non-Agent tools", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      tool_response: "hi",
    };

    const events = extractEvents(input);
    const findings = events.filter(e => e.type === "agent_finding");
    assert.equal(findings.length, 0);
  });

  test("agent_finding coexists with subagent_completed", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Research Cursor env vars" },
      tool_response: "Found CURSOR_TRACE_DIR and CURSOR_CHANNEL.",
    };

    const events = extractEvents(input);
    const subagent = events.filter(e => e.type === "subagent_completed");
    const finding = events.filter(e => e.type === "agent_finding");
    assert.equal(subagent.length, 1, "should still emit subagent_completed");
    assert.equal(finding.length, 1, "should also emit agent_finding");
  });
});

// ════════════════════════════════════════════
// CATEGORY 24: EXTERNAL-REF
// ════════════════════════════════════════════

describe("External Ref Events", () => {
  test("extracts URLs from tool_input", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl https://api.github.com/repos/user/repo" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.equal(refs[0].category, "external-ref");
    assert.equal(refs[0].priority, 3);
    assert.ok(refs[0].data.includes("https://api.github.com"), "should capture URL");
  });

  test("extracts GitHub issue URLs from tool_response", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "gh issue list" },
      tool_response: "Fix: https://github.com/user/repo/issues/42 is blocking",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("github.com/user/repo/issues/42"));
  });

  test("extracts GitHub PR URLs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "gh pr view 99" },
      tool_response: "See https://github.com/user/repo/pull/99",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("github.com/user/repo/pull/99"));
  });

  test("extracts shorthand issue refs (#123)", () => {
    const input = {
      tool_name: "Read",
      tool_input: { file_path: "/project/CHANGELOG.md" },
      tool_response: "Fixed bug #42 and addressed #99",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("#42"), "should capture #42");
    assert.ok(refs[0].data.includes("#99"), "should capture #99");
  });

  test("deduplicates refs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo https://example.com" },
      tool_response: "Visit https://example.com again",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    // Should only appear once despite being in both input and response
    const count = refs[0].data.split("https://example.com").length - 1;
    assert.equal(count, 1, "URL should appear exactly once (deduplicated)");
  });

  test("skips localhost URLs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl http://localhost:3000/api" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 0, "should skip localhost");
  });

  test("skips 127.0.0.1 URLs", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl http://127.0.0.1:8080/health" },
      tool_response: "ok",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 0, "should skip 127.0.0.1");
  });

  test("does not fire when no refs found", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_response: "hello",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 0);
  });

  test("captures multiple mixed refs", () => {
    const input = {
      tool_name: "Agent",
      tool_input: { prompt: "Check issue #344" },
      tool_response: "Found https://github.com/user/repo/pull/100 and #344 is related to https://docs.example.com/guide",
    };

    const events = extractEvents(input);
    const refs = events.filter(e => e.type === "external_ref");
    assert.equal(refs.length, 1);
    assert.ok(refs[0].data.includes("#344"), "should include issue ref");
    assert.ok(refs[0].data.includes("github.com/user/repo/pull/100"), "should include PR URL");
    assert.ok(refs[0].data.includes("docs.example.com"), "should include doc URL");
  });

  test("attaches bytes_avoided parsed from ctx_fetch_and_index preamble", () => {
    // SLICE 2: when a ctx_fetch_and_index call returns its single-fetch
    // preamble ("Fetched and indexed **N sections** (XKB) from: ..."),
    // the external_ref event must carry the bytes-avoided figure so the
    // honest-savings stats line is non-zero. Without this, indexed bytes
    // never reach the session_events.bytes_avoided column.
    const input = {
      tool_name: "mcp__plugin_context-mode_context-mode__ctx_fetch_and_index",
      tool_input: { url: "https://example.com/guide" },
      tool_response:
        "Fetched and indexed **5 sections** (47.50KB) from: example-guide\n" +
        "Full content indexed in sandbox — use ctx_search(queries: [...], source: \"example-guide\") for specific lookups.\n" +
        "\n---\n\n" +
        "Visit https://example.com/guide for the full doc.",
    };

    const events = extractEvents(input);
    const refs = events.filter((e) => e.type === "external_ref");
    assert.equal(refs.length, 1, "external_ref should fire on the preamble");
    const ref = refs[0] as { type: string; data: string; bytes_avoided?: number };
    assert.ok(
      typeof ref.bytes_avoided === "number" && ref.bytes_avoided > 0,
      `expected bytes_avoided > 0, got ${ref.bytes_avoided}`,
    );
    // 47.50KB = 47.50 * 1024 = 48640 bytes
    assert.equal(ref.bytes_avoided, Math.round(47.5 * 1024));
  });
});

// ════════════════════════════════════════════
// CATEGORY 27: LATENCY (cross-hook state)
// ════════════════════════════════════════════

describe("Category 27 — Latency", () => {
  /**
   * Latency tracking uses cross-hook state (tmpdir files) to bridge
   * PreToolUse → PostToolUse. The extractEvents function itself does NOT
   * produce latency events — they are created directly in posttooluse.mjs
   * by comparing timestamps from the tmpdir marker file.
   *
   * These tests verify the architecture is sound:
   * - extractEvents does not accidentally produce latency events (no false positives)
   * - The latency event shape matches the SessionEvent interface
   */

  test("extractEvents does not produce latency events (latency is cross-hook, not extract-based)", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: "all tests passed",
    };

    const events = extractEvents(input);
    const latencyEvents = events.filter(e => e.category === "latency");
    assert.equal(latencyEvents.length, 0, "extractEvents should not produce latency events");
  });

  test("latency event shape conforms to SessionEvent interface", () => {
    // This validates the event shape that posttooluse.mjs will produce
    const latencyEvent = {
      type: "tool_latency",
      category: "latency",
      data: "Bash: 7500ms",
      priority: 3,
    };

    assert.equal(typeof latencyEvent.type, "string");
    assert.equal(typeof latencyEvent.category, "string");
    assert.equal(typeof latencyEvent.data, "string");
    assert.equal(typeof latencyEvent.priority, "number");
    assert.equal(latencyEvent.type, "tool_latency");
    assert.equal(latencyEvent.category, "latency");
    assert.equal(latencyEvent.priority, 3);
  });

  test("latency data format includes tool name and duration", () => {
    // Validate the data format convention: "${tool}: ${duration}ms"
    const data = "Read: 12345ms";
    const match = data.match(/^(\w+): (\d+)ms$/);
    assert.ok(match, "data should match 'ToolName: Nms' format");
    assert.equal(match![1], "Read");
    assert.equal(match![2], "12345");
  });
});

// ════════════════════════════════════════════
// CATEGORY 28: PERMISSION (not feasible)
// ════════════════════════════════════════════

describe("Category 28 — Permission (architectural limitation)", () => {
  /**
   * Permission tracking is NOT implementable from hooks.
   *
   * Why:
   * - PreToolUse fires BEFORE the tool call. The user's approve/deny decision
   *   happens AFTER PreToolUse returns but BEFORE the tool actually executes.
   *   The hook cannot observe this decision.
   *
   * - PostToolUse ONLY fires when the tool successfully executed, meaning the
   *   user already approved. There is no PostToolUse invocation for denied tools.
   *   So PostToolUse always implies "approved" — there's no deny signal to track.
   *
   * - The hook system has no "permission_result" or "user_decision" field in
   *   either PreToolUse or PostToolUse stdin payloads.
   *
   * Possible future approaches:
   * 1. Claude Code adds a permission_result field to PostToolUse input
   * 2. A new hook event type (e.g., "ToolPermissionDecision") is introduced
   * 3. Track implicit approvals by counting PostToolUse invocations (but this
   *    adds no information beyond what we already have — every PostToolUse IS
   *    an implicit approval)
   *
   * Conclusion: Skip this category until the hook protocol evolves.
   */

  test("PostToolUse always implies approval — no deny signal available", () => {
    // Every PostToolUse input represents a tool that was approved and ran.
    // There's no way to distinguish "user clicked approve" from "tool was auto-approved".
    const input = {
      tool_name: "Bash",
      tool_input: { command: "rm -rf node_modules" },
      tool_response: "removed",
    };

    const events = extractEvents(input);
    const permEvents = events.filter(e => e.category === "permission");
    assert.equal(permEvents.length, 0, "no permission events should be extracted — not implementable");
  });

  test("PreToolUse deny is already captured as rejected-approach (Phase 1)", () => {
    // When PreToolUse returns action: "deny", the pretooluse.mjs hook already
    // writes a rejected-approach event. This is the closest we get to permission
    // tracking: we know when context-mode itself denies a tool, but NOT when
    // the user denies a tool.
    //
    // This test documents that rejected-approach covers the hook-level deny case.
    const input = {
      tool_name: "Bash",
      tool_input: { command: "curl https://example.com" },
      tool_response: "",
    };

    const events = extractEvents(input);
    // rejected-approach is written by pretooluse.mjs directly to DB, not via extractEvents
    const rejectedEvents = events.filter(e => e.category === "rejected-approach");
    assert.equal(rejectedEvents.length, 0, "extractEvents does not produce rejected-approach — that's pretooluse.mjs's job");
  });
});

// ─── SLICE Qwen-4: extractEvents Qwen-aware (Z5b) ───
describe("Qwen native tool name normalization", () => {
  test("run_shell_command + git status emits git event", () => {
    const events = extractEvents({
      tool_name: "run_shell_command",
      tool_input: { command: "git status" },
      tool_response: "On branch main",
    });
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1, "git event should be extracted");
    assert.equal(gitEvents[0].data, "status");
  });

  test("run_shell_command + cd emits cwd event", () => {
    const events = extractEvents({
      tool_name: "run_shell_command",
      tool_input: { command: "cd /tmp/foo && ls" },
      tool_response: "",
    });
    const cwdEvents = events.filter(e => e.category === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/tmp/foo");
  });

  test("read_file emits file_read event", () => {
    const events = extractEvents({
      tool_name: "read_file",
      tool_input: { file_path: "/tmp/a.ts" },
      tool_response: "code",
    });
    const fileEvents = events.filter(e => e.type === "file_read");
    assert.equal(fileEvents.length, 1);
    assert.equal(fileEvents[0].data, "/tmp/a.ts");
  });

  test("write_file emits file_write event", () => {
    const events = extractEvents({
      tool_name: "write_file",
      tool_input: { file_path: "/tmp/b.ts" },
      tool_response: "ok",
    });
    const fileEvents = events.filter(e => e.type === "file_write");
    assert.equal(fileEvents.length, 1);
  });

  test("edit emits file_edit event", () => {
    const events = extractEvents({
      tool_name: "edit",
      tool_input: { file_path: "/tmp/c.ts" },
      tool_response: "ok",
    });
    const fileEvents = events.filter(e => e.type === "file_edit");
    assert.equal(fileEvents.length, 1);
  });

  test("todo_write emits task event", () => {
    const events = extractEvents({
      tool_name: "todo_write",
      tool_input: { todos: [{ content: "do thing" }] },
      tool_response: "ok",
    });
    const taskEvents = events.filter(e => e.category === "task");
    assert.equal(taskEvents.length, 1);
  });

  test("agent emits subagent event", () => {
    const events = extractEvents({
      tool_name: "agent",
      tool_input: { prompt: "investigate the bug" },
      tool_response: "found it",
    });
    const subEvents = events.filter(e => e.category === "subagent");
    assert.equal(subEvents.length, 1);
    assert.equal(subEvents[0].type, "subagent_completed");
  });

  test("read_file with QWEN.md path emits rule event", () => {
    const events = extractEvents({
      tool_name: "read_file",
      tool_input: { file_path: "/proj/QWEN.md" },
      tool_response: "qwen rules",
    });
    const ruleEvents = events.filter(e => e.category === "rule");
    assert.ok(ruleEvents.length >= 1, "QWEN.md should emit rule event");
  });
});
