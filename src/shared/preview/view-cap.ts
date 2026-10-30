// ── View-mode caps for the preview pane (2026-10-30 perf batch) ──
//
// The preview pane's READ path had no size gate at all: MAX_EDITABLE_BYTES
// (preview-edit.ts) only guards the editor, and svcReadFile's 256MB process
// guard only guards binary reads. A multi-megabyte text file was read whole,
// shipped across the IPC whole, and — the expensive part — handed to
// react-syntax-highlighter for FULL tokenization, freezing the renderer for
// seconds. Two caps fix it at two different costs:
//
//   * MAX_PREVIEW_CHARS caps what the pane will RENDER at all. Above it the
//     text is truncated and an honest notice points at the full file. This is
//     the DOM/memory guard (every rendered line is a span).
//   * HIGHLIGHT_MAX_CHARS caps what gets TOKENIZED. Below it CodeHighlight
//     colors the file; above it TextPreview falls back to plain <pre>
//     rendering — the tokenizer is the multi-second cost, the DOM is not, and
//     a 500KB file in a plain pre scrolls fine.
//
// Both are measured in UTF-16 code units (string .length), not bytes: a byte
// measure would need TextEncoder on every load for a distinction (multibyte
// headroom) no consumer uses. A capped file is therefore never smaller than
// the names suggest, never larger than 2× — and since every char costs ≥1
// byte, a MAX_PREVIEW_CHARS-truncated text is always over MAX_EDITABLE_BYTES,
// so the editor gate still rejects it on its own terms.

/** The pane renders at most this many characters of a text file; the rest is
 *  truncated with a notice. */
export const MAX_PREVIEW_CHARS = 2_000_000

/** Above this, text previews skip syntax highlighting and render plain. */
export const HIGHLIGHT_MAX_CHARS = 200_000

export interface CappedText {
  text: string
  truncated: boolean
}

export function capPreviewText(text: string): CappedText {
  if (text.length <= MAX_PREVIEW_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_PREVIEW_CHARS), truncated: true }
}

export function shouldSkipHighlight(text: string): boolean {
  return text.length > HIGHLIGHT_MAX_CHARS
}

/** Human label of the render cap for the truncation notice ('2M'), derived so
 *  the notice and the constant never drift apart. */
export function previewLimitLabel(): string {
  return MAX_PREVIEW_CHARS % 1_000_000 === 0
    ? `${MAX_PREVIEW_CHARS / 1_000_000}M`
    : `${Math.floor(MAX_PREVIEW_CHARS / 1000)}K`
}
