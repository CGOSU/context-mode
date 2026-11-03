/** Executor regressions: executor-optional-languages. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe.runIf(runtimes.go)("Go Execution", () => {
  test("Go: hello world", async () => {
    const r = await executor.execute({
      language: "go",
      code: 'fmt.Println("hello from go")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from go"));
  });

  test("Go: loops + slices", async () => {
    const r = await executor.execute({
      language: "go",
      code: `
  nums := []int{1, 2, 3, 4, 5}
  sum := 0
  for _, n := range nums {
  sum += n
  }
  fmt.Println("sum:", sum)
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 15"));
  });
});


describe.runIf(runtimes.php)("PHP Execution", () => {
  test("PHP: hello world", async () => {
    const r = await executor.execute({
      language: "php",
      code: 'echo "hello from php\\n";',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from php"));
  });

  test("PHP: array functions", async () => {
    const r = await executor.execute({
      language: "php",
      code: `
$nums = range(1, 10);
$evens = array_filter($nums, fn($n) => $n % 2 === 0);
echo "evens: " . implode(", ", $evens) . "\\n";
echo "sum: " . array_sum($evens) . "\\n";
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });
});


describe.runIf(runtimes.r)("R Execution", () => {
  test("R: hello world", async () => {
    const r = await executor.execute({
      language: "r",
      code: 'cat("hello from R\\n")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from R"));
  });

  test("R: vector operations", async () => {
    const r = await executor.execute({
      language: "r",
      code: `
nums <- 1:10
cat("mean:", mean(nums), "\\n")
cat("sum:", sum(nums), "\\n")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 55"));
  });
});


describe.runIf(runtimes.elixir)("Elixir Execution", () => {
  test("Elixir: hello world", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: 'IO.puts("hello from elixir")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from elixir"));
  });

  test("Elixir: list operations + Enum", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: `
nums = Enum.to_list(1..10)
evens = Enum.filter(nums, fn n -> rem(n, 2) == 0 end)
IO.puts("evens: #{Enum.join(evens, ", ")}")
IO.puts("sum: #{Enum.sum(evens)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test("Elixir: map + pattern matching", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: `
users = [%{name: "Alice", role: "admin"}, %{name: "Bob", role: "user"}]
admins = Enum.filter(users, fn %{role: role} -> role == "admin" end)
IO.puts("admins: #{length(admins)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("admins: 1"));
  });

  test("Elixir: pipe operator + String functions", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: `
result =
  "hello world from elixir"
  |> String.split()
  |> Enum.map(&String.upcase/1)
  |> Enum.join(" ")
IO.puts(result)
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("HELLO WORLD FROM ELIXIR"));
  });

  test("Elixir: error raises non-zero exit", async () => {
    const r = await executor.execute({
      language: "elixir",
      code: 'raise "intentional error"',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0 || r.stdout.includes("intentional error"));
  });
});


describe.runIf(runtimes.csharp)("CSharp Execution", () => {
  test("C#: hello world", async () => {
    const r = await executor.execute({
      language: "csharp",
      code: 'Console.WriteLine("hello from csharp");',
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes("hello from csharp"));
  });

  test("C#: LINQ over array", async () => {
    const r = await executor.execute({
      language: "csharp",
      code: `
using System.Linq;
var nums = Enumerable.Range(1, 10);
var evens = nums.Where(n => n % 2 == 0).ToArray();
Console.WriteLine($"sum: {evens.Sum()}");
      `,
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test("C#: error returns non-zero exit", async () => {
    const r = await executor.execute({
      language: "csharp",
      code: 'throw new System.Exception("intentional error");',
    });
    assert.notEqual(r.exitCode, 0);
    assert.ok(r.stderr.length > 0 || r.stdout.includes("intentional error"));
  });
});
