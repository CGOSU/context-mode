import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../../src/store.js";

export function createStore(): ContentStore {
  const path = join(
    tmpdir(),
    `context-mode-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  return new ContentStore(path);
}
