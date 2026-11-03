/** Executor regressions: executor-languages. */
import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { createExecutorFixture } from "./helpers/executor-fixture.js";

const { runtimes, executor } = createExecutorFixture();


describe("JavaScript Execution", () => {
  test("JS: hello world", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'console.log("hello from js");',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from js"));
    assert.equal(r.timedOut, false);
  });

  test("JS: variables, math, template literals", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: "const x = 42; const y = 58; console.log(`sum: ${x + y}`);",
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 100"));
  });

  test("JS: JSON parse + transform", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: `
        const data = [
          { name: "Alice", age: 30 },
          { name: "Bob", age: 25 },
          { name: "Charlie", age: 35 }
        ];
        const avg = data.reduce((s, d) => s + d.age, 0) / data.length;
        console.log(JSON.stringify({ count: data.length, avgAge: avg.toFixed(1) }));
      `,
    });
    assert.equal(r.exitCode, 0);
    const output = JSON.parse(r.stdout.trim());
    assert.equal(output.count, 3);
    assert.equal(output.avgAge, "30.0");
  });

  test("JS: async/await + setTimeout", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: `
        async function work() {
          return new Promise(resolve => setTimeout(() => resolve("async done"), 50));
        }
        work().then(r => console.log(r));
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("async done"));
  });

  test("JS: require node:os module", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: 'const os = require("os"); console.log("platform:", os.platform());',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("platform:"));
  });

  test("JS: Array.from + map/filter/reduce chain", async () => {
    const r = await executor.execute({
      language: "javascript",
      code: `
        const nums = Array.from({length: 100}, (_, i) => i + 1);
        const evenSum = nums.filter(n => n % 2 === 0).reduce((a, b) => a + b, 0);
        console.log("even sum:", evenSum);
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("even sum: 2550"));
  });
});


describe.runIf(runtimes.typescript)("TypeScript Execution", () => {
    test("TS: hello world with type annotation", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: 'const msg: string = "hello from ts"; console.log(msg);',
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("hello from ts"));
    });

    test("TS: interface + generics", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: `
          interface Item<T> { id: number; value: T; }
          const items: Item<string>[] = [
            { id: 1, value: "apple" },
            { id: 2, value: "banana" },
          ];
          function first<T>(arr: T[]): T | undefined { return arr[0]; }
          console.log(first(items)?.value);
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("apple"));
    });

    test("TS: enum + switch", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: `
          enum Color { Red = "red", Blue = "blue", Green = "green" }
          function describe(c: Color): string {
            switch (c) {
              case Color.Red: return "warm";
              case Color.Blue: return "cool";
              case Color.Green: return "natural";
            }
          }
          console.log(describe(Color.Blue));
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("cool"));
    });

    test("TS: async + Promise.all", async () => {
      const r = await executor.execute({
        language: "typescript",
        code: `
          async function fetchNum(n: number): Promise<number> {
            return new Promise(resolve => setTimeout(() => resolve(n * 2), 10));
          }
          Promise.all([1, 2, 3].map(fetchNum)).then(results => {
            console.log("doubled:", results.join(", "));
          });
        `,
      });
      assert.equal(r.exitCode, 0);
      assert.ok(r.stdout.includes("doubled: 2, 4, 6"));
    });
});


describe.runIf(runtimes.python)("Python Execution", () => {
  test("Python: hello world", async () => {
    const r = await executor.execute({
      language: "python",
      code: 'print("hello from python")',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from python"));
  });

  test("Python: list comprehension + math", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
nums = [i**2 for i in range(10)]
print(f"squares: {nums}")
print(f"sum: {sum(nums)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 285"));
  });

  test("Python: dict + json", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
import json
data = {"users": [{"name": "Alice"}, {"name": "Bob"}]}
print(json.dumps({"count": len(data["users"])}))
      `,
    });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.count, 2);
  });

  test("Python: csv with io.StringIO", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
import io, csv
data = "name,age\\nAlice,30\\nBob,25\\nCharlie,35"
reader = csv.DictReader(io.StringIO(data))
rows = list(reader)
print(f"rows: {len(rows)}, names: {[r['name'] for r in rows]}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("rows: 3"));
  });

  test("Python: regex extraction", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
import re
text = "Error: 404 at /api/users, Error: 500 at /api/data, OK: 200"
errors = re.findall(r'Error: (\\d+) at (\\S+)', text)
print(f"Found {len(errors)} errors: {errors}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("Found 2 errors"));
  });

  test("Python: collections.Counter", async () => {
    const r = await executor.execute({
      language: "python",
      code: `
from collections import Counter
words = "the cat sat on the mat the cat".split()
c = Counter(words)
print(f"most common: {c.most_common(2)}")
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("most common:"));
    assert.ok(r.stdout.includes("the"));
  });
});


describe.runIf(runtimes.ruby)("Ruby Execution", () => {
  test("Ruby: hello world", async () => {
    const r = await executor.execute({
      language: "ruby",
      code: 'puts "hello from ruby"',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from ruby"));
  });

  test("Ruby: array methods", async () => {
    const r = await executor.execute({
      language: "ruby",
      code: `
nums = (1..10).to_a
evens = nums.select { |n| n.even? }
puts "evens: #{evens.join(', ')}"
puts "sum: #{evens.sum}"
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("sum: 30"));
  });

  test("Ruby: hash + JSON", async () => {
    const r = await executor.execute({
      language: "ruby",
      code: `
require 'json'
data = { users: [{ name: "Alice" }, { name: "Bob" }] }
puts JSON.generate({ count: data[:users].length })
      `,
    });
    assert.equal(r.exitCode, 0);
    const out = JSON.parse(r.stdout.trim());
    assert.equal(out.count, 2);
  });
});


describe.runIf(runtimes.perl)("Perl Execution", () => {
  test("Perl: hello world", async () => {
    const r = await executor.execute({
      language: "perl",
      code: 'print "hello from perl\\n";',
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("hello from perl"));
  });

  test("Perl: regex + array", async () => {
    const r = await executor.execute({
      language: "perl",
      code: `
my @words = ("apple", "banana", "avocado", "blueberry");
my @a_words = grep { /^a/i } @words;
print "a-words: @a_words\\n";
      `,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("apple"));
    assert.ok(r.stdout.includes("avocado"));
  });
});
