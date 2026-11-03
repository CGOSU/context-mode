import { strict as assert } from "node:assert";
import { describe, test } from "vitest";
import { extractEvents } from "../../src/session/extract.js";


// ════════════════════════════════════════════
// SLICE 3: CWD EVENT EXTRACTION
// ════════════════════════════════════════════

describe("CWD Events", () => {
  test("extracts cwd event from cd command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cd /project/subdir && ls" },
      tool_response: "file1.ts\nfile2.ts",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/project/subdir");
    assert.equal(cwdEvents[0].priority, 2);
  });

  test("extracts cwd from cd with double-quoted path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'cd "/path with spaces/dir"' },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/path with spaces/dir");
  });

  test("extracts cwd from cd with single-quoted path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cd '/path with spaces/dir'" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 1);
    assert.equal(cwdEvents[0].data, "/path with spaces/dir");
  });

  test("does not extract cwd from non-cd bash commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: "...",
    };

    const events = extractEvents(input);
    const cwdEvents = events.filter(e => e.type === "cwd");
    assert.equal(cwdEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 5: GIT EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Git Events", () => {
  test("extracts git event from checkout command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git checkout -b feature/session-continuity" },
      tool_response: "Switched to a new branch 'feature/session-continuity'",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "branch");
    assert.equal(gitEvents[0].priority, 2);
  });

  test("extracts git event from commit command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: 'git commit -m "feat: add session continuity"' },
      tool_response: "[next abc1234] feat: add session continuity",
    };

    const events = extractEvents(input);
    // v1.0.161: commits with a -m message surface as type='git_commit' so the
    // rollup aggregator can distinguish actual commits from other git ops.
    // category stays 'git' for downstream consumers that filter by category.
    const gitCategoryEvents = events.filter(e => e.category === "git");
    assert.equal(gitCategoryEvents.length, 1);
    assert.equal(gitCategoryEvents[0].type, "git_commit");
    assert.equal(gitCategoryEvents[0].data, "feat: add session continuity");
  });

  test("extracts git event from push command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git push origin main" },
      tool_response: "Branch pushed",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "push");
  });

  test("does not extract git event from non-git commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm install" },
      tool_response: "installed",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// SLICE 9: ENV EVENT EXTRACTION
// ════════════════════════════════════════════

describe("Env Events", () => {
  test("extracts env event from venv activation", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "source .venv/bin/activate" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
    assert.equal(envEvents[0].priority, 2);
  });

  test("extracts env event from nvm use", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "nvm use 20" },
      tool_response: "Now using node v20.0.0",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from export command", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "export API_KEY=sk-test" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("does not extract env from regular bash commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: "files...",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 0);
  });
});

// ════════════════════════════════════════════
// NEW GIT PATTERNS
// ════════════════════════════════════════════

describe("New Git Patterns", () => {
  test("extracts git add event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git add src/server.ts" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("add"), "should include add operation");
  });

  test("extracts git cherry-pick event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git cherry-pick abc123" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("cherry-pick"), "should include cherry-pick");
  });

  test("extracts git tag event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git tag v1.0.0" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("tag"), "should include tag");
  });

  test("extracts git fetch event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git fetch origin" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("fetch"), "should include fetch");
  });

  test("extracts git clone event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git clone https://github.com/user/repo.git" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.category === "git");
    assert.equal(gitEvents.length, 1);
    assert.ok(gitEvents[0].data.includes("clone"), "should include clone");
  });
});

// ════════════════════════════════════════════
// NEW ENV PATTERNS
// ════════════════════════════════════════════

describe("New Env Patterns", () => {
  test("extracts env event from cargo install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "cargo install serde" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for cargo install");
  });

  test("extracts env event from go install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "go install golang.org/x/tools/gopls@latest" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for go install");
  });

  test("extracts env event from rustup", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "rustup default stable" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for rustup");
  });

  test("extracts env event from volta", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "volta install node@18" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for volta");
  });

  test("extracts env event from deno install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "deno install --allow-net server.ts" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event for deno install");
  });
});

// ════════════════════════════════════════════
// ENV SECRET SANITIZATION
// ════════════════════════════════════════════

describe("Env Secret Sanitization", () => {
  test("sanitizes export commands to prevent secret leakage", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "export API_KEY=sk-secret-12345" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event");
    assert.ok(!envEvents[0].data.includes("sk-secret"), "should NOT contain the secret value");
    assert.ok(envEvents[0].data.includes("API_KEY"), "should contain the key name");
    assert.ok(envEvents[0].data.includes("***"), "should contain masked value");
  });

  test("does not sanitize non-export env commands", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm install express" },
      tool_response: "",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.category === "env");
    assert.ok(envEvents.length >= 1, "should extract env event");
    assert.ok(envEvents[0].data.includes("npm install express"), "should contain full command");
  });
});

// ════════════════════════════════════════════
// EXPANDED GIT PATTERNS
// ════════════════════════════════════════════

describe("Expanded Git Patterns", () => {
  test("extracts git log event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git log --oneline -5" },
      tool_response: "abc123 fix: something",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "log");
  });

  test("extracts git diff event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git diff HEAD~1" },
      tool_response: "diff --git...",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "diff");
  });

  test("extracts git status event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git status" },
      tool_response: "On branch main",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "status");
  });

  test("extracts git pull event", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "git pull origin main" },
      tool_response: "Already up to date.",
    };

    const events = extractEvents(input);
    const gitEvents = events.filter(e => e.type === "git");
    assert.equal(gitEvents.length, 1);
    assert.equal(gitEvents[0].data, "pull");
  });
});

// ════════════════════════════════════════════
// EXPANDED ENV PATTERNS (dependency install)
// ════════════════════════════════════════════

describe("Dependency Install Events", () => {
  test("extracts env event from npm install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "npm install vitest --save-dev" },
      tool_response: "added 50 packages",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from pip install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "pip install requests" },
      tool_response: "Successfully installed",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from bun install", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "bun install" },
      tool_response: "installed dependencies",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });

  test("extracts env event from yarn add", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "yarn add lodash" },
      tool_response: "success",
    };

    const events = extractEvents(input);
    const envEvents = events.filter(e => e.type === "env");
    assert.equal(envEvents.length, 1);
  });
});
