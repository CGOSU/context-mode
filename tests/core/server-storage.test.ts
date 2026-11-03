/** Server regressions: storage. */


import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, test, expect, afterEach } from "vitest";
import { clearStorageDirectoryCheckCacheForTests, describeStorageDirectorySource, ensureWritableStorageDir, formatStorageDirectoryError, resolveContentStorageDir, resolveDefaultSessionDir, resolveSessionStorageDir, resolveStatsStorageDir, StorageDirectoryError } from "../../src/session/db.js";



const STORAGE_ENV_KEY = "CONTEXT_MODE_DIR";

const savedStorageEnv = process.env[STORAGE_ENV_KEY];


afterEach(() => {
  if (savedStorageEnv === undefined) delete process.env[STORAGE_ENV_KEY];
  else process.env[STORAGE_ENV_KEY] = savedStorageEnv;
  clearStorageDirectoryCheckCacheForTests();
});


describe("storage path resolution", () => {
  test("uses adapter defaults when no storage override is set", () => {
    delete process.env[STORAGE_ENV_KEY];

    const defaultSessionsDir = join(tmpdir(), "context-mode-default", "sessions");
    const defaultRoot = dirname(defaultSessionsDir);
    const session = resolveSessionStorageDir(() => defaultSessionsDir);
    const content = resolveContentStorageDir(() => defaultSessionsDir);
    const stats = resolveStatsStorageDir(() => defaultSessionsDir);

    expect(session).toEqual({
      kind: "session",
      path: defaultSessionsDir,
      envVar: null,
      source: "default",
    });
    expect(content).toEqual({
      kind: "content",
      path: join(defaultRoot, "content"),
      envVar: null,
      source: "default",
    });
    expect(stats).toEqual({
      kind: "stats",
      path: defaultSessionsDir,
      envVar: null,
      source: "default",
    });
  });

  test("shared default session dir helper derives context-mode sessions root", () => {
    const configRoot = join(tmpdir(), "context-mode-config-root");

    expect(resolveDefaultSessionDir({ configDir: configRoot })).toBe(
      join(configRoot, "context-mode", "sessions"),
    );
  });

  test("shared default session dir helper honors config env override", () => {
    const configRoot = join(tmpdir(), "context-mode-env-config-root");

    expect(
      resolveDefaultSessionDir({
        configDir: ".ignored",
        configDirEnv: "CONTEXT_MODE_TEST_CONFIG_DIR",
        env: { CONTEXT_MODE_TEST_CONFIG_DIR: configRoot },
      }),
    ).toBe(join(configRoot, "context-mode", "sessions"));
  });

  test("legacy session dir wins only inside blank or unset storage override default callback", () => {
    const legacyDir = join(tmpdir(), "context-mode-legacy-sessions");
    const root = resolve(tmpdir(), "context-mode-storage-root");
    const defaultDir = () => resolveDefaultSessionDir({
      configDir: ".ignored",
      legacySessionDirEnv: "CONTEXT_MODE_TEST_SESSION_DIR",
      env: { CONTEXT_MODE_TEST_SESSION_DIR: legacyDir },
    });

    delete process.env[STORAGE_ENV_KEY];
    expect(resolveSessionStorageDir(defaultDir).path).toBe(legacyDir);

    process.env[STORAGE_ENV_KEY] = " \t ";
    expect(resolveSessionStorageDir(defaultDir).path).toBe(legacyDir);

    process.env[STORAGE_ENV_KEY] = root;
    expect(resolveSessionStorageDir(defaultDir).path).toBe(join(root, "sessions"));
  });

  test("uses CONTEXT_MODE_DIR as the single root for sessions, content, and stats", () => {
    const root = resolve(tmpdir(), "context-mode-storage-root");
    process.env[STORAGE_ENV_KEY] = root;

    expect(resolveSessionStorageDir(() => "/ignored")).toEqual({
      kind: "session",
      path: join(root, "sessions"),
      envVar: STORAGE_ENV_KEY,
      source: "override",
    });
    expect(resolveContentStorageDir(() => "/ignored")).toEqual({
      kind: "content",
      path: join(root, "content"),
      envVar: STORAGE_ENV_KEY,
      source: "override",
    });
    expect(resolveStatsStorageDir(() => "/ignored")).toEqual({
      kind: "stats",
      path: join(root, "sessions"),
      envVar: STORAGE_ENV_KEY,
      source: "override",
    });
  });

  test("treats blank CONTEXT_MODE_DIR as default and reports ignored metadata", () => {
    process.env[STORAGE_ENV_KEY] = " \t ";
    const defaultSessionsDir = join(tmpdir(), "context-mode-default", "sessions");

    const session = resolveSessionStorageDir(() => defaultSessionsDir);
    const content = resolveContentStorageDir(() => defaultSessionsDir);

    expect(session).toMatchObject({
      kind: "session",
      path: defaultSessionsDir,
      envVar: null,
      source: "default",
      ignoredEnvVar: STORAGE_ENV_KEY,
      ignoredReason: "empty",
    });
    expect(content).toMatchObject({
      kind: "content",
      path: join(dirname(defaultSessionsDir), "content"),
      ignoredEnvVar: STORAGE_ENV_KEY,
      ignoredReason: "empty",
    });
    expect(describeStorageDirectorySource(session)).toBe("default; ignored empty CONTEXT_MODE_DIR");

    const err = new StorageDirectoryError("session", session.path, STORAGE_ENV_KEY, undefined, undefined, session);
    expect(formatStorageDirectoryError(err)).toContain("Ignored empty CONTEXT_MODE_DIR; using adapter default.");
  });

  test("rejects a relative CONTEXT_MODE_DIR", () => {
    process.env[STORAGE_ENV_KEY] = "relative/path";

    expect(() => resolveSessionStorageDir(() => "/ignored")).toThrow(StorageDirectoryError);
    expect(() => resolveSessionStorageDir(() => "/ignored")).toThrow(
      "CONTEXT_MODE_DIR must be an absolute path.",
    );
  });

  test("memoizes successful writable directory checks", () => {
    const dir = {
      kind: "session" as const,
      path: mkdtempSync(join(tmpdir(), "ctx-storage-cache-")),
      envVar: null,
      source: "default" as const,
    };

    expect(ensureWritableStorageDir(dir)).toBe(dir.path);
    rmSync(dir.path, { recursive: true, force: true });
    expect(ensureWritableStorageDir(dir)).toBe(dir.path);
    expect(existsSync(dir.path)).toBe(false);
  });
});
