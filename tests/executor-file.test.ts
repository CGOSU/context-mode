/** Executor regressions: executor-file. */
import { describe, test, afterAll } from "vitest";
import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe("execute_file (FILE_CONTENT)", () => {
  const testDir = join(tmpdir(), "ctx-mode-test-" + Date.now());
  mkdirSync(testDir, { recursive: true });
  const testFile = join(testDir, "test-data.json");
  writeFileSync(
    testFile,
    JSON.stringify({
      users: [
        { name: "Alice", role: "admin" },
        { name: "Bob", role: "user" },
        { name: "Charlie", role: "admin" },
      ],
    }),
    "utf-8",
  );

  test("execute_file: JS reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "javascript",
      code: `
        const data = JSON.parse(FILE_CONTENT);
        const admins = data.users.filter(u => u.role === "admin");
        console.log("admins: " + admins.map(a => a.name).join(", "));
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("admins: Alice, Charlie"));
  });

    test.runIf(runtimes.python)("execute_file: Python reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "python",
      code: `
import json
data = json.loads(FILE_CONTENT)
print(f"Users: {len(data['users'])}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Users: 3"));
  });

  test("execute_file: Shell reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "shell",
      code: 'echo "size: ${#FILE_CONTENT} bytes"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("bytes"));
  });

    test.runIf(runtimes.ruby)("execute_file: Ruby reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "ruby",
      code: `
require 'json'
data = JSON.parse(FILE_CONTENT)
puts "Users: #{data['users'].length}"
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Users: 3"));
  });

  test.runIf(runtimes.csharp)("execute_file: C# reads FILE_CONTENT", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "csharp",
      code: `
using (var doc = System.Text.Json.JsonDocument.Parse(FILE_CONTENT)) {
  var users = doc.RootElement.GetProperty("users").GetArrayLength();
  System.Console.WriteLine($"Users: {users}");
}
      `,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes("Users: 3"));
  });

  // --- execute_file: shell $ expansion in paths ---

  const dollarDir = join(testDir, "path$SHOULD_NOT_EXPAND");
  mkdirSync(dollarDir, { recursive: true });
  const dollarFile = join(dollarDir, "data.txt");
  writeFileSync(dollarFile, "dollar-sign-content", "utf-8");

  test("execute_file: Shell path with $ is not expanded", async () => {
    const r = await executor.executeFile({
      path: dollarFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: dollar-sign-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with spaces ---

  const spaceDir = join(testDir, "path with spaces");
  mkdirSync(spaceDir, { recursive: true });
  const spaceFile = join(spaceDir, "space file.txt");
  writeFileSync(spaceFile, "space-content", "utf-8");

  test("execute_file: Shell path with spaces works correctly", async () => {
    const r = await executor.executeFile({
      path: spaceFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: space-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with single quotes ---

  const quoteDir = join(testDir, "it's-a-dir");
  mkdirSync(quoteDir, { recursive: true });
  const quoteFile = join(quoteDir, "quote.txt");
  writeFileSync(quoteFile, "quote-content", "utf-8");

  test("execute_file: Shell path with single quotes works correctly", async () => {
    const r = await executor.executeFile({
      path: quoteFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: quote-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with backticks ---

  const backtickDir = join(testDir, "dir`tick");
  mkdirSync(backtickDir, { recursive: true });
  const backtickFile = join(backtickDir, "bt.txt");
  writeFileSync(backtickFile, "backtick-content", "utf-8");

  test("execute_file: Shell path with backticks is not executed", async () => {
    const r = await executor.executeFile({
      path: backtickFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: backtick-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

  // --- execute_file: shell paths with combined special characters ---

  const comboDir = join(testDir, "$HOME has `spaces` & 'quotes'");
  mkdirSync(comboDir, { recursive: true });
  const comboFile = join(comboDir, "combo.txt");
  writeFileSync(comboFile, "combo-content", "utf-8");

  test("execute_file: Shell path with combined special chars works", async () => {
    const r = await executor.executeFile({
      path: comboFile,
      language: "shell",
      code: 'echo "content: $FILE_CONTENT"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(
      r.stdout.includes("content: combo-content"),
      `Expected literal file content, got: ${r.stdout}`,
    );
  });

    test.runIf(runtimes.elixir)("execute_file: Elixir reads file_content", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "elixir",
      code: `
IO.puts("file size: #{byte_size(file_content)}")
IO.puts("has users: #{String.contains?(file_content, "users")}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("has users: true"));
  });

  // --- UTF-8 / Non-ASCII file content ---
  const utf8File = join(testDir, "utf8-data.txt");
  writeFileSync(utf8File, "这是中文内容\n日本語テスト\n한국어\nEmoji: 🔒✅\nLine 5", "utf-8");

  test("execute_file: Python reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "python",
      code: `
lines = FILE_CONTENT.strip().split('\\n')
print(f"lines: {len(lines)}")
print(f"first: {lines[0]}")
print(f"has_emoji: {'🔒' in FILE_CONTENT}")
      `,
    });
    assert.equal(r.exitCode, 0, "Python UTF-8 exit code: " + r.stderr);
    assert.ok(r.stdout.includes("lines: 5"), "Should have 5 lines");
    assert.ok(r.stdout.includes("first: 这是中文内容"), "Should read Chinese");
    assert.ok(r.stdout.includes("has_emoji: True"), "Should find emoji");
  });

  test("execute_file: JS reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "javascript",
      code: `
const lines = FILE_CONTENT.trim().split('\\n');
console.log("lines: " + lines.length);
console.log("first: " + lines[0]);
console.log("has_emoji: " + FILE_CONTENT.includes('🔒'));
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("lines: 5"));
    assert.ok(r.stdout.includes("first: 这是中文内容"));
    assert.ok(r.stdout.includes("has_emoji: true"));
  });

    test.runIf(runtimes.ruby)("execute_file: Ruby reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "ruby",
      code: `
lines = FILE_CONTENT.strip.split("\\n")
puts "lines: #{lines.length}"
puts "first: #{lines[0]}"
puts "has_emoji: #{FILE_CONTENT.include?('🔒')}"
      `,
    });
    assert.equal(r.exitCode, 0, "Ruby UTF-8 exit code: " + r.stderr);
    assert.ok(r.stdout.includes("lines: 5"));
    assert.ok(r.stdout.includes("first: 这是中文内容"));
  });

  test("execute_file: Shell reads UTF-8 non-ASCII content", async () => {
    const r = await executor.executeFile({
      path: utf8File,
      language: "shell",
      code: 'echo "$FILE_CONTENT" | head -1',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("这是中文内容"), "Shell should read Chinese: " + r.stdout);
  });

  // --- execute_file: file_path alias ---

  test.runIf(runtimes.python)("execute_file: Python exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "python",
      code: `
import json
with open(file_path) as f:
    data = json.load(f)
print(f"Users via file_path: {len(data['users'])}")
      `,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("Users via file_path: 3"), `Got: ${r.stdout}`);
  });

  test("execute_file: JS exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "javascript",
      code: `console.log("file_path alias: " + file_path);`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test("execute_file: TypeScript exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "typescript",
      code: `console.log("file_path alias: " + file_path);`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test("execute_file: Shell exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "shell",
      code: 'echo "file_path alias: $file_path"',
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.ruby)("execute_file: Ruby exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "ruby",
      code: `
require 'json'
data = JSON.parse(File.read(file_path))
puts "Users via file_path: #{data['users'].length}"
      `,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes("Users via file_path: 3"), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.go)("execute_file: Go exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "go",
      code: `fmt.Println("file_path alias: " + file_path)`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.rust)("execute_file: Rust exposes 'file_path' as alias for file_content_path", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "rust",
      code: `println!("file_path alias: {}", file_path);`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.php)("execute_file: PHP exposes '$file_path' as alias for $FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "php",
      code: `echo "file_path alias: " . $file_path . "\\n";`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.perl)("execute_file: Perl exposes '$file_path' as alias for $FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "perl",
      code: `print "file_path alias: $file_path\\n";`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.r)("execute_file: R exposes 'file_path' as alias for FILE_CONTENT_PATH", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "r",
      code: `cat(paste0("file_path alias: ", file_path, "\\n"))`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  test.runIf(runtimes.elixir)("execute_file: Elixir exposes 'file_path' as alias for file_content_path", async () => {
    const r = await executor.executeFile({
      path: testFile,
      language: "elixir",
      code: `IO.puts("file_path alias: " <> file_path)`,
    });
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.ok(r.stdout.includes(testFile), `Got: ${r.stdout}`);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
});
