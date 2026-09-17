// ── Knowledge text chunking (PLAN-knowledge-base K5) ──
// File-level FTS rows diluted long-document ranking: one BM25 score for the
// whole file, snippet() at the first hit. Chunks (~1200 chars, ~200 overlap,
// cut at paragraph boundaries) give the trigram index a per-passage grain —
// the search result IS the relevant region. Pure so both the main-process
// indexer and the tests share one definition of "chunk".

export const CHUNK_SIZE = 1200
export const CHUNK_OVERLAP = 200

/** Split `content` into overlapping chunks, preferring paragraph boundaries:
 *  grow to CHUNK_SIZE, then cut at the last blank-line boundary inside the
 *  window when one exists (never in the first 40% — a 2-line first chunk is
 *  worse than a long one). The next chunk rewinds CHUNK_OVERLAP characters so
 *  a match spanning the cut still lands whole in one of the two chunks. */
export function chunkText(content: string, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const text = content
  if (text.length <= size) return text.trim().length > 0 ? [text] : []
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + size, text.length)
    if (end < text.length) {
      const windowStart = start + Math.floor(size * 0.4)
      const blank = text.lastIndexOf('\n\n', end)
      if (blank > windowStart) end = blank + 1
      else {
        const line = text.lastIndexOf('\n', end)
        if (line > windowStart) end = line + 1
      }
    }
    const piece = text.slice(start, end)
    if (piece.trim().length > 0) chunks.push(piece)
    if (end >= text.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks
}
