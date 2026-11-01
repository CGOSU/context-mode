import { describe, expect, it } from "vitest";
import { PI_ROUTING_ANCHOR as anchor, omitRepeatedRouting } from "../../src/adapters/pi/context-routing.js";

describe("request-local routing deduplication", () => {
  it.each([
    anchor,
    [{ type: "text", text: anchor }],
    [{ type: "image", data: "unchanged" }, { type: "text", text: anchor + "\n\nprevious memory" }],
  ])("preserves new memory and recovery bytes while omitting only the repeated prefix", content => {
    const messages = [{ role: "user", content }];
    const original = structuredClone(messages);
    const recovery = '<active_memory>有效记忆\n\nkeep spacing</active_memory>\n\n<session_resume>recover safely</session_resume>';
    expect(omitRepeatedRouting(anchor + "\n\n" + recovery, messages)).toBe(recovery);
    expect(omitRepeatedRouting(anchor, messages)).toBe("");
    expect(messages).toEqual(original);
  });

  it("does not erase user quotations, partial matches, or other roles' content", () => {
    const messages = [
      { role: "user", content: "Please review this quotation:\n" + anchor },
      { role: "user", content: anchor + " — this is my own suffix" },
      { role: "assistant", content: anchor },
    ];
    expect(omitRepeatedRouting(anchor, messages)).toBe(anchor);
    expect(omitRepeatedRouting("unrelated pending context", [{ role: "user", content: anchor }]))
      .toBe("unrelated pending context");
  });

  it("keeps dynamic context unchanged even if it repeats, and has no cross-request latch", () => {
    const memory = "<active_memory>important decision</active_memory>";
    expect(omitRepeatedRouting(anchor + "\n\n" + memory, [{ role: "user", content: anchor + "\n\n" + memory }]))
      .toBe(memory);
    expect(omitRepeatedRouting(anchor + "\n\n" + memory, [])).toBe(anchor + "\n\n" + memory);
  });
});
