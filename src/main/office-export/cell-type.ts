// ── Cell type inference for xlsx/csv export (PLAN-office-export, D5) ──
// A WHITELIST, not a guess: a cell becomes a number only when its exact
// round-trip through Number() reproduces the original string. Leading zeros
// (工号 007), over-precision long digit strings, dates like 2026-09 and
// anything else fall back to TEXT — a wrong type corrupts data silently, a
// text cell is merely not arithmetic-friendly (R3).

/** A string becomes an xlsx number only if the strict Number() round-trip
 *  reproduces it byte for byte. Everything else stays text. */
export function inferCellValue(raw: string): string | number | null {
  if (raw === '') return null
  if (STRICT_NUMERIC.test(raw) && String(Number(raw)) === raw) return Number(raw)
  const grouped = THOUSAND_GROUPS.exec(raw)
  if (grouped) {
    const stripped = raw.replace(/,/g, '')
    if (String(Number(stripped)) === stripped) return Number(stripped)
  }
  return raw
}

/** Pure optionally-signed decimal — the ONLY shape allowed into Number()
 *  directly. Keeps out hex (0x1A), exponents (1e5), Infinity and '' which
 *  Number() would happily convert. */
const STRICT_NUMERIC = /^-?\d+(\.\d+)?$/

/** `1,234` / `12,345,678.9` — well-formed thousand groups only. `1,23` is
 *  not a number with a weird separator, it is text. */
const THOUSAND_GROUPS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/

/** Apply the D5 typing to a whole grid (shared by the xlsx build and the CSV
 *  input path). '' → null keeps genuinely empty cells empty. */
export function typedRows(rows: string[][]): Array<Array<string | number | null>> {
  return rows.map((row) => row.map((cell) => inferCellValue(cell)))
}
