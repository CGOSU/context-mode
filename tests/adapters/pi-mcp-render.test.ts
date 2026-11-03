/** Pure terminal regressions: no subprocess fixture or transport import. */
import { describe, it, expect } from "vitest";


// ── Slice 10 — CJK wide-character width-aware truncation (#665) ──
//
// Bug: truncateAnsiLine() counted every JS character as width 1, but
// CJK characters (Chinese, Japanese, Korean) occupy 2 columns in a
// terminal. This caused PiTextComponent.render() to produce lines whose
// actual visible width exceeded the requested `width`, triggering a
// pi-tui crash: "visible width: 162 > terminal width: 147".
//
// The fix: truncateAnsiLine() must measure CJK characters as width 2.
//
// These tests pin the contract:
//   1. Pure CJK text does not exceed the requested width.
//   2. Mixed ASCII + CJK text is correctly truncated.
//   3. ANSI escape sequences are preserved but NOT counted toward width.
//   4. The crash line from the real incident is handled correctly.
describe("truncateAnsiLine / PiTextComponent — CJK width-aware truncation (#665)", () => {
  const testSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

  function extractTestTerminalEscape(str: string, pos: number): { length: number } | null {
    if (pos >= str.length || str[pos] !== "\x1b") return null;
    const next = str[pos + 1];
    if (next === "[") {
      let j = pos + 2;
      while (j < str.length) {
        const code = str.charCodeAt(j);
        if (code >= 0x40 && code <= 0x7e) return { length: j + 1 - pos };
        j++;
      }
      return null;
    }
    if (next === "]" || next === "_") {
      let j = pos + 2;
      while (j < str.length) {
        if (str[j] === "\x07") return { length: j + 1 - pos };
        if (str[j] === "\x1b" && str[j + 1] === "\\") return { length: j + 2 - pos };
        j++;
      }
      return null;
    }
    return null;
  }

  function stripTestTerminalEscapes(str: string): string {
    let stripped = "";
    let i = 0;
    while (i < str.length) {
      const escape = extractTestTerminalEscape(str, i);
      if (escape) {
        i += escape.length;
        continue;
      }
      stripped += str[i];
      i++;
    }
    return stripped;
  }

  function testZeroWidthCodePoint(cp: number): boolean {
    return (
      cp < 0x20 ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x300 && cp <= 0x36f) ||
      (cp >= 0x1ab0 && cp <= 0x1aff) ||
      (cp >= 0x1dc0 && cp <= 0x1dff) ||
      (cp >= 0x20d0 && cp <= 0x20ff) ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      (cp >= 0xfe20 && cp <= 0xfe2f) ||
      cp === 0x200b ||
      cp === 0x200c ||
      cp === 0x200d ||
      cp === 0xfeff
    );
  }

  function testWideCodePoint(cp: number): boolean {
    return cp >= 0x1100 && (
      cp <= 0x115f ||
      (cp >= 0xa960 && cp <= 0xa97c) ||
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xd7b0 && cp <= 0xd7fb) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd)
    );
  }

  function testCouldBeEmoji(segment: string): boolean {
    const cp = segment.codePointAt(0) ?? 0;
    return (
      (cp >= 0x1f000 && cp <= 0x1fbff) ||
      (cp >= 0x2300 && cp <= 0x23ff) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x2b50 && cp <= 0x2b55) ||
      segment.includes("\uFE0F") ||
      segment.includes("\u200D")
    );
  }

  // Test oracle modelled after Pi TUI's visibleWidth contract: strip terminal
  // control sequences, segment graphemes, count CJK/fullwidth/emoji as wide,
  // and treat mark-only clusters as zero-width.
  function visibleWidth(s: string): number {
    const stripped = stripTestTerminalEscapes(s.replace(/\t/g, "   "));
    let w = 0;
    for (const { segment } of testSegmenter.segment(stripped)) {
      const cps = [...segment].map((ch) => ch.codePointAt(0) ?? 0);
      if (cps.every(testZeroWidthCodePoint)) continue;
      const cp = cps.find((c) => !testZeroWidthCodePoint(c)) ?? cps[0] ?? 0;
      w += testCouldBeEmoji(segment) || (cp >= 0x1f1e6 && cp <= 0x1f1ff) || testWideCodePoint(cp) ? 2 : 1;
    }
    return w;
  }

  it("pure CJK line does not exceed requested width", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // 10 Chinese characters → visible width 20
    comp.setText("媒体上传一律用数据删除检查不做协议");
    const lines = comp.render(15);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(15);
    }
  });

  it("mixed ASCII + CJK line is width-aware truncated", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // "AB" = 2, "媒体上传" = 8, "CD" = 2 → total 12
    comp.setText("AB媒体上传CD");
    const lines = comp.render(8);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(8);
    }
  });

  it("ANSI escape sequences are preserved and not counted toward width", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // Red color codes around CJK text
    const red = "\x1b[31m";
    const reset = "\x1b[0m";
    comp.setText(`${red}媒体上传一律用数据删除检查不做协议${reset}`);
    const lines = comp.render(10);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
      // ANSI codes must survive
      expect(line).toContain(red);
    }
  });

  it("the real crash line (CJK mixed with ASCII) fits within terminal width", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // The actual line that caused the crash in pi-crash.log:
    // visible width was 161, terminal was 147
    const crashLine =
      "  - **媒体上传**: 一律用 data URL / base64。删除 `KimiFiles` 和 `isinstance(chat_provider, Kimi)` 检查。不做 `MediaUploader` 协议，除非未来出现真实 provider 需求。";
    comp.setText(crashLine);
    const lines = comp.render(147);
    for (const line of lines) {
      const w = visibleWidth(line);
      expect(w).toBeLessThanOrEqual(147);
    }
  });

  it("does not keep an emoji when it would exceed the render width", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // Pi's TUI counts RGI emoji as width 2. Keeping the emoji here would
    // render as width 6 in a width-5 component and trip the TUI guard.
    comp.setText("AAAA😀");
    expect(comp.render(5)).toEqual(["AAAA"]);
  });

  it("does not emit a dangling escape byte when truncating before an APC sequence", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    comp.setText("AAAA\x1b_marker\x07B");
    expect(comp.render(5)).toEqual(["AAAA\x1b_marker\x07B"]);
  });

  it("counts visible text between OSC 8 ST-terminated hyperlink sequences", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    const open = "\x1b]8;;https://example.com\x1b\\";
    const close = "\x1b]8;;\x1b\\";
    comp.setText(`AAAA${open}B${close}C`);
    expect(comp.render(5)).toEqual([`AAAA${open}B${close}`]);
  });

  it("does not count standalone combining marks toward render width", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // Pi's visibleWidth treats mark-only grapheme clusters as zero-width.
    comp.setText("\u0301ABCDE");
    expect(comp.render(5)).toEqual(["\u0301ABCDE"]);
  });

  it("truncateAnsiLine returns empty for maxWidth 0 or negative", async () => {
    const mod = await import("../../src/adapters/pi/mcp-render.js");
    const { truncateAnsiLine } = mod as unknown as {
      truncateAnsiLine: (line: string, maxWidth: number) => string;
    };
    expect(truncateAnsiLine("媒体上传", 0)).toBe("");
    expect(truncateAnsiLine("媒体上传", -1)).toBe("");
  });

  it("Hangul Extended-A/B characters are correctly width-aware (#665)", async () => {
    const { PiTextComponent } = await import("../../src/adapters/pi/mcp-render.js");
    const comp = new PiTextComponent();
    // Hangul Jamo Extended-A: U+A960..U+A97C (ꥠ..ꥼ)
    // Hangul Jamo Extended-B: U+D7B0..U+D7FB (ퟀ..ퟻ)
    // Mix with ASCII: "A" = 1, "ꥠꥡퟰퟱ" = 8, "B" = 1 → total 10
    const hangulExtA = "\uA960\uA961"; // ꥠꥡ
    const hangulExtB = "\uD7B0\uD7B1"; // ퟰퟱ
    comp.setText(`A${hangulExtA}${hangulExtB}B`);
    const lines = comp.render(4);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(4);
    }
    // Must actually truncate (total width 6 > 4)
    const totalW = lines.reduce((sum, l) => sum + visibleWidth(l), 0);
    expect(totalW).toBeLessThanOrEqual(4);
  });
});
