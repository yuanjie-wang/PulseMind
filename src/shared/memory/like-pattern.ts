/**
 * Escape SQL LIKE wildcards so query text matches literally.
 * Pair with `LIKE ? ESCAPE '\'` — the backslash prefix neutralizes
 * `%`, `_` and a literal backslash in the user's query.
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
