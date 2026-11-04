import { createHash, randomUUID } from "node:crypto";

const processSession = randomUUID();
const cleanupAt = new WeakMap<object, number>();
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Reuse store retention during long-lived servers; cleanup never blocks a run. */
export function cleanupExecutionSources(store: { cleanupStaleSources(days: number): number }): void {
  const now = Date.now();
  const last = cleanupAt.get(store);
  if (last !== undefined && now >= last && now - last < CLEANUP_INTERVAL_MS) return;
  // Bound failed attempts as well, so an unavailable store does not turn every
  // execution into a cleanup retry. A backwards clock change resets the window.
  cleanupAt.set(store, now);
  try { store.cleanupStaleSources(14); } catch { /* retention is best-effort */ }
}

/** Execution observations append; only explicitly named document snapshots replace. */
export function createExecutionSource(kind: string, sessionId?: string): string {
  const session = createHash("sha256").update(sessionId || processSession).digest("hex").slice(0, 16);
  let label = kind.replace(/\s+/g, " ");
  if (label.length > 120) {
    label = `${label.slice(0, 99)}:${createHash("sha256").update(kind).digest("hex").slice(0, 20)}`;
  }
  return `${label}:session:${session}:run:${randomUUID()}`;
}
