/**
 * Extract and parse a JSON value from LLM text output.
 *
 * Tries multiple strategies in order:
 *   1. Direct parse (clean JSON with no extra text)
 *   2. Markdown code block extraction (```json … ```)
 *   3. Strip markdown fences entirely and re-try
 *   4. Find outermost `{ }` / `[ ]` boundaries (handles LLM preamble/commentary)
 *   5. Return null
 */
export function extractJson<T>(text: string): T | null {
  const trimmed = text.trim()

  // 1. Direct parse
  try {
    return JSON.parse(trimmed) as T
  } catch { /* fall through */ }

  // 2. Markdown code block
  const blockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/)
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1].trim()) as T
    } catch { /* fall through */ }
  }

  // 3. Strip fences and re-try
  const stripped = trimmed.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim()
  if (stripped !== trimmed) {
    try {
      return JSON.parse(stripped) as T
    } catch { /* fall through */ }
  }

  // 4. Find outermost `{ }` or `[ ]` boundaries
  const firstBrace = trimmed.indexOf('{')
  const firstBracket = trimmed.indexOf('[')
  const first = (firstBrace >= 0 && (firstBracket < 0 || firstBrace < firstBracket)) ? firstBrace : firstBracket
  if (first >= 0) {
    const closer = trimmed[first] === '{' ? '}' : ']'
    const last = trimmed.lastIndexOf(closer)
    if (last > first) {
      const candidate = trimmed.slice(first, last + 1)
      try {
        return JSON.parse(candidate) as T
      } catch {
        // Try fixing trailing commas before giving up
        try {
          return JSON.parse(candidate.replace(/,(\s*[}\]])/g, '$1')) as T
        } catch { /* give up */ }
      }
    }
  }

  return null
}
