/** ContentStore json regressions. */

import { describe, test } from "vitest";
import { strict as assert } from "node:assert";
import { createStore } from "./helpers/content-store.js";



describe("JSON Chunking (Objects)", () => {
  test("chunks JSON object by top-level keys", () => {
    const store = createStore();
    const json = JSON.stringify({
      authentication: {
        oauth: { clientId: "abc", scopes: ["read", "write"] },
        jwt: { algorithm: "RS256", expiry: "1h" },
      },
      database: {
        host: "localhost",
        port: 5432,
      },
    });

    const result = store.indexJSON(json, "config");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    const authResults = store.search("oauth clientId", 5, "config");
    assert.ok(authResults.length > 0, "Should find oauth config");
    assert.ok(
      authResults[0].title.includes("authentication"),
      `Expected 'authentication' in title, got: ${authResults[0].title}`,
    );
    store.close();
  });

  test("small JSON object becomes single chunk", () => {
    const store = createStore();
    const json = JSON.stringify({ name: "Alice", role: "admin" });
    const result = store.indexJSON(json, "small");
    assert.equal(result.totalChunks, 1);
    store.close();
  });

  test("chunks nested JSON with path titles", () => {
    const store = createStore();
    const endpoints: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) {
      endpoints[`/api/v1/resource${i}`] = {
        method: "GET",
        description: `Get resource ${i}. ${"Details. ".repeat(50)}`,
        params: { id: "string", limit: "number" },
      };
    }
    const json = JSON.stringify({ endpoints });

    const result = store.indexJSON(json, "api-spec");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const results = store.search("resource15", 5, "api-spec");
    assert.ok(results.length > 0, "Should find resource15");
    store.close();
  });

  test("handles invalid JSON gracefully by falling back to plain text", () => {
    const store = createStore();
    const result = store.indexJSON("not valid json {{{", "bad-json");
    assert.ok(result.totalChunks >= 1, "Should still index as plain text");
    store.close();
  });
});

describe("JSON Chunking (Arrays)", () => {
  test("top-level array of objects uses identity field in titles", () => {
    const store = createStore();
    const users = Array.from({ length: 50 }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@example.com`,
      bio: `Bio for user ${i + 1}. ${"Some details. ".repeat(10)}`,
    }));
    const json = JSON.stringify(users);

    const result = store.indexJSON(json, "users-api");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const results = store.search("User 25", 5, "users-api");
    assert.ok(results.length > 0, "Should find User 25");
    store.close();
  });

  test("identity field appears in chunk titles", () => {
    const store = createStore();
    const items = [
      { name: "Alice", role: "admin", data: "x".repeat(2000) },
      { name: "Bob", role: "user", data: "y".repeat(2000) },
      { name: "Carol", role: "user", data: "z".repeat(2000) },
    ];
    const json = JSON.stringify(items);

    const result = store.indexJSON(json, "people");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);

    const results = store.search("Alice admin", 5, "people");
    assert.ok(results.length > 0, "Should find Alice");
    assert.ok(
      results[0].title.includes("Alice"),
      `Expected 'Alice' in title, got: ${results[0].title}`,
    );
    store.close();
  });

  test("array of primitives becomes batched chunks", () => {
    const store = createStore();
    const longStrings = Array.from({ length: 100 }, (_, i) =>
      `Item ${i}: ${"content ".repeat(50)}`
    );
    const json = JSON.stringify(longStrings);

    const result = store.indexJSON(json, "primitives");
    assert.ok(result.totalChunks >= 2, `Expected >=2 chunks, got ${result.totalChunks}`);
    store.close();
  });

  test("nested array within object uses full key path", () => {
    const store = createStore();
    const json = JSON.stringify({
      api: {
        endpoints: Array.from({ length: 20 }, (_, i) => ({
          path: `/api/v1/resource${i}`,
          method: "GET",
          description: `Resource ${i}. ${"Details ".repeat(30)}`,
        })),
      },
    });

    const result = store.indexJSON(json, "nested-api");
    assert.ok(result.totalChunks > 1, `Expected >1 chunk, got ${result.totalChunks}`);

    const results = store.search("resource10", 5, "nested-api");
    assert.ok(results.length > 0, "Should find resource10");
    assert.ok(
      results[0].title.includes("api") && results[0].title.includes("endpoints"),
      `Expected path in title, got: ${results[0].title}`,
    );
    store.close();
  });
});

describe("Content-Type Routing", () => {
  test("indexJSON produces searchable chunks from pretty-printed JSON", () => {
    const store = createStore();
    const apiResponse = JSON.stringify({
      data: {
        users: [
          { id: 1, name: "Alice", email: "alice@example.com" },
          { id: 2, name: "Bob", email: "bob@example.com" },
        ],
        pagination: { page: 1, total: 100 },
      },
    });

    const result = store.indexJSON(apiResponse, "api-response");
    assert.ok(result.totalChunks >= 1, `Expected >=1 chunks, got ${result.totalChunks}`);

    const results = store.search("Alice email", 5, "api-response");
    assert.ok(results.length > 0, "Should find Alice's email via search");
    store.close();
  });

  test("indexPlainText handles non-JSON non-HTML content", () => {
    const store = createStore();
    const plainText = "name,email,role\nAlice,alice@example.com,admin\nBob,bob@example.com,user";
    const result = store.indexPlainText(plainText, "csv-response");
    assert.ok(result.totalChunks >= 1);
    store.close();
  });
});
