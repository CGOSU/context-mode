/** Each suite owns its shell cwd and executor cleanup; util-only suites do not use this fixture. */
import { afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PolyglotExecutor } from "../../src/executor.js";
import { detectRuntimes } from "../../src/runtime.js";

export function createExecutorFixture() {
  const runtimes = detectRuntimes();
  // Fully skipped optional-language suites must not allocate a directory at collection time.
  let projectRoot: string | undefined;
  const executor = new PolyglotExecutor({
    runtimes,
    projectRoot: () => projectRoot ??= mkdtempSync(join(tmpdir(), "ctx-executor-suite-")),
  });
  afterAll(() => {
    executor.cleanupBackgrounded();
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });
  return { runtimes, executor };
}
