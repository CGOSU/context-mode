import type { SessionEvent } from "../../types.js";
import { leafId } from "./history.js";

type CaptureEvent = Omit<SessionEvent, "data_hash"> & { data_hash?: string };
interface Capture {
  sessionId: string;
  events: CaptureEvent[];
  hook: "PostToolUse" | "UserPromptSubmit";
  prompt?: string;
  toolCallId?: string;
  parentToolCallId?: string;
}
interface PendingCapture extends Capture {
  beforeLeaf: string | null;
  emptyBranch: boolean;
  size: number;
}

function branchEntries(ctx: any): any[] | null {
  try {
    const entries = ctx?.sessionManager?.getBranch?.();
    return Array.isArray(entries) ? entries : null;
  } catch { return null; }
}

/**
 * Pi invokes before_agent_start/tool_result/message_end before the corresponding
 * transcript entry is persisted. Bind only at a later context/turn_end boundary.
 * Unverifiable captures remain searchable with entryId:null, never auto memory.
 */
export class PiCaptureBuffer {
  private pending: PendingCapture[] = [];
  constructor(private readonly write: (capture: Capture, entryId: string | null) => void) {}

  private persist(capture: Capture, entryId: string | null): void {
    try { this.write(capture, entryId); } catch { /* capture must never break the host */ }
  }

  enqueue(capture: Capture, ctx: any): void {
    if (!capture.events.length) return;
    const item = {
      ...capture, beforeLeaf: leafId(ctx), emptyBranch: branchEntries(ctx)?.length === 0,
      size: capture.events.reduce((size, event) => size + event.data.length, 0) + (capture.prompt?.length ?? 0),
    };
    this.pending.push(item);
    // Bound retained payloads even for nested tools whose parent has not ended.
    while (this.pending.length > 64 || this.pending.reduce((sum, pending) => sum + pending.size, 0) > 1_048_576) {
      this.persist(this.pending.shift()!, null);
    }
  }

  flush(ctx: any, sessionId: string, final = false, bind = true): void {
    const entries = (bind ? branchEntries(ctx) : null) ?? [];
    const parents = new Map(this.pending.filter(p => p.toolCallId && p.parentToolCallId)
      .map(p => [p.toolCallId!, p.parentToolCallId!]));
    const remaining: PendingCapture[] = [];
    for (const capture of this.pending) {
      let entryId: string | null = null;
      const before = capture.beforeLeaf === null ? -1 : entries.findIndex(entry => entry.id === capture.beforeLeaf);
      const canBind = bind && capture.sessionId === sessionId &&
        (capture.beforeLeaf === null ? capture.emptyBranch : before >= 0);
      if (canBind) {
        const ids = new Set<string>();
        let callId = capture.toolCallId;
        while (callId && !ids.has(callId)) {
          ids.add(callId);
          callId = parents.get(callId);
        }
        const match = entries.slice(before + 1).find(entry => {
          if (entry.type !== "message" || typeof entry.id !== "string") return false;
          const message = entry.message;
          if (capture.hook === "PostToolUse") return message?.role === "toolResult" && ids.has(message.toolCallId);
          if (message?.role !== "user" || !capture.prompt) return false;
          const content = typeof message.content === "string" ? message.content : Array.isArray(message.content)
            ? message.content.filter((part: any) => part?.type === "text").map((part: any) => part.text).join("") : "";
          // Pi can append image-normalization hints after the original prompt.
          return content === capture.prompt || content.startsWith(capture.prompt + "\n\n");
        });
        if (match && match.id.length <= 256) entryId = match.id;
      }
      if (entryId || final || (capture.hook === "PostToolUse" && !capture.toolCallId)) this.persist(capture, entryId);
      else remaining.push(capture);
    }
    this.pending = remaining;
  }
}
