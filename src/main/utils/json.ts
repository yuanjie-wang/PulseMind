// ── Safe JSON helpers ──
// SQLite text columns store serialized arrays/objects; a single corrupt or
// NULL cell used to throw out of row-mappers and take down a whole list
// query. parseJsonColumn is the one parse-with-fallback for that pattern —
// stores must not hand-roll try/catch parse blocks.

/**
 * Parse a serialized DB column (or any raw string). Returns `fallback` when
 * the value is null/undefined/empty or not valid JSON. Prefer passing the
 * real default shape (e.g. `[]`) over asserting non-null downstream.
 */
export function parseJsonColumn<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
