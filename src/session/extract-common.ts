import type { HookInput } from "./extract-types.js";

/** Null-safe string coercion — no truncation, preserves full data. */
export function safeString(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value);
}

/** Serialise an unknown value to a string — no truncation. */
export function safeStringAny(value: unknown): string {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function isToolError(input: HookInput): boolean {
  const response = String(input.tool_response ?? "");
  // PreToolUse rewrites curl/wget/inline-HTTP/WebFetch commands into
  //   echo "context-mode: <guidance text including 'retry', 'fails', 'error'>"
  // The user-facing copy legitimately mentions failure modes ("retry if it
  // fails with a transient DNS error"), but those words must NOT classify
  // our OWN guidance message as a tool error or it gets captured into
  // session_resume and surfaces as a fake error in the next chat.
  // We check BOTH sides because:
  //   - real shell run → response starts with `context-mode:` (echo stdout)
  //   - test/captured-output path → response is the raw command itself
  //     (`echo "context-mode: …"`), so we also match the command shape
  const command = String(input.tool_input?.command ?? "");
  if (
    response.startsWith("context-mode:") ||
    command.startsWith('echo "context-mode:') ||
    command.startsWith("echo 'context-mode:")
  ) {
    return false;
  }
  const isErrorFlag = input.tool_output?.isError === true || input.tool_output?.is_error === true;
  const isBashError =
    input.tool_name === "Bash" &&
    /exit code [1-9]|error:|Error:|FAIL|failed/i.test(response);
  return isBashError || isErrorFlag;
}
