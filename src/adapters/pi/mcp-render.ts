/** Connection-free Pi tool presentation and terminal-width handling. */

import type { MCPCallResult } from "./mcp-client.js";

export class PiTextComponent {
  private text: string;

  constructor(text = "") {
    this.text = text;
  }

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {
    // Stateless renderer: no cached layout to invalidate.
  }

  render(width: number): string[] {
    if (!this.text || this.text.trim() === "") return [];
    return this.text
      .replace(/\t/g, "   ")
      .split(/\r?\n/)
      .map((line) => truncateAnsiLine(line, Math.max(1, width)));
  }
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function extractTerminalEscape(str: string, pos: number): { code: string; length: number } | null {
  if (pos >= str.length || str[pos] !== "\x1b") return null;
  const next = str[pos + 1];

  // CSI sequence: ESC [ ... final-byte. Covers SGR plus cursor/control codes.
  if (next === "[") {
    let j = pos + 2;
    while (j < str.length) {
      const code = str.charCodeAt(j);
      if (code >= 0x40 && code <= 0x7e) {
        return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      }
      j++;
    }
    return null;
  }

  // OSC/APC sequence: ESC ]/_ ... BEL or ST (ESC \). Stop at the FIRST
  // terminator so OSC 8 hyperlinks don't swallow visible link text.
  if (next === "]" || next === "_") {
    let j = pos + 2;
    while (j < str.length) {
      if (str[j] === "\x07") return { code: str.slice(pos, j + 1), length: j + 1 - pos };
      if (str[j] === "\x1b" && str[j + 1] === "\\") {
        return { code: str.slice(pos, j + 2), length: j + 2 - pos };
      }
      j++;
    }
    return null;
  }

  return null;
}

function couldBeEmoji(segment: string): boolean {
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

function isZeroWidthCodePoint(cp: number): boolean {
  return (
    cp < 0x20 ||
    (cp >= 0x7f && cp <= 0x9f) ||
    (cp >= 0x300 && cp <= 0x36f) ||     // Combining Diacritical Marks
    (cp >= 0x1ab0 && cp <= 0x1aff) ||   // Combining Diacritical Marks Extended
    (cp >= 0x1dc0 && cp <= 0x1dff) ||   // Combining Diacritical Marks Supplement
    (cp >= 0x20d0 && cp <= 0x20ff) ||   // Combining Diacritical Marks for Symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) ||   // Variation Selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) ||   // Combining Half Marks
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff
  );
}

function isZeroWidthGrapheme(segment: string): boolean {
  if (segment.length === 0) return true;
  for (const char of segment) {
    if (!isZeroWidthCodePoint(char.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * Returns the terminal display width of a code point.
 * CJK ideographs, Hangul, fullwidth forms, etc. → 2; everything else → 1.
 * Mirrors the Unicode east-asian-width "W"/"F" categories.
 */
function charWidth(cp: number): number {
  return cp >= 0x1100 && (
    cp <= 0x115f ||   // Hangul Jamo
    (cp >= 0xa960 && cp <= 0xa97c) ||   // Hangul Jamo Extended-A
    cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||  // CJK
    (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
    (cp >= 0xd7b0 && cp <= 0xd7fb) ||   // Hangul Jamo Extended-B
    (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compat
    (cp >= 0xfe10 && cp <= 0xfe19) ||   // Vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) ||   // CJK compat forms
    (cp >= 0xff01 && cp <= 0xff60) ||   // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||   // Fullwidth signs
    (cp >= 0x20000 && cp <= 0x2fffd) || // CJK extensions
    (cp >= 0x30000 && cp <= 0x3fffd)    // CJK extensions B+
  ) ? 2 : 1;
}

function graphemeWidth(segment: string): number {
  const cp = segment.codePointAt(0);
  if (cp === undefined) return 0;
  if (isZeroWidthGrapheme(segment)) return 0;
  if (couldBeEmoji(segment)) return 2;
  // Regional indicator symbols render as wide emoji flags in Pi's TUI.
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;
  return charWidth(cp);
}

export function truncateAnsiLine(line: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  let output = "";
  let visible = 0;
  let index = 0;
  while (index < line.length) {
    const escape = extractTerminalEscape(line, index);
    if (escape) {
      output += escape.code;
      index += escape.length;
      continue;
    }

    let end = index + 1;
    while (end < line.length && !extractTerminalEscape(line, end)) end++;
    const chunk = line.slice(index, end);
    for (const { segment } of GRAPHEME_SEGMENTER.segment(chunk)) {
      const w = graphemeWidth(segment);
      if (visible + w > maxWidth) return output;
      output += segment;
      visible += w;
    }
    index = end;
  }
  return output;
}

export interface PiRenderTheme {
  bold(text: string): string;
  fg(color: string, text: string): string;
}

export interface PiRenderContext {
  lastComponent?: unknown;
}

export function createContextModeCallRenderer(toolName: string) {
  return (_args: unknown, theme: PiRenderTheme, context: PiRenderContext) => {
    const text =
      context.lastComponent instanceof PiTextComponent
        ? context.lastComponent
        : new PiTextComponent();
    text.setText(theme.fg("toolTitle", theme.bold(toolName)));
    return text;
  };
}

export function createContextModeResultRenderer(toolName: string) {
  return (
    result: MCPCallResult,
    { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
    theme: PiRenderTheme,
    context: PiRenderContext,
  ) => {
    const text =
      context.lastComponent instanceof PiTextComponent
        ? context.lastComponent
        : new PiTextComponent();
    if (isPartial) {
      text.setText(theme.fg("warning", "indexing/searching..."));
      return text;
    }
    const output = (result.content ?? [])
      .filter((c) => c?.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n");
    if (expanded) {
      text.setText(theme.fg("toolOutput", output));
      return text;
    }
    const firstLine = output
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    const status =
      firstLine && firstLine.length <= 180
        ? firstLine
        : `${toolName} completed`;
    text.setText(theme.fg("toolOutput", status));
    return text;
  };
}
