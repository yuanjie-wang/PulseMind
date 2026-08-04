import type { StreamParser } from './stream-types'

/**
 * Fetch all SSE chunks from the streaming API proxy in the main process.
 * Returns the raw chunk strings, or rejects on error.
 */
export function fetchStreamChunks(
  requestId: string,
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    const unsubChunk = window.electronAPI.onApiStreamChunk(data => {
      if (data.requestId === requestId) chunks.push(data.data)
    })
    const unsubError = window.electronAPI.onApiStreamError(data => {
      if (data.requestId !== requestId) return
      unsubChunk(); unsubError(); unsubDone()
      reject(new Error(data.error))
    })
    const unsubDone = window.electronAPI.onApiStreamDone(data => {
      if (data.requestId !== requestId) return
      unsubChunk(); unsubError(); unsubDone()
      resolve(chunks)
    })
    window.electronAPI.apiFetchStream(requestId, url, { method: 'POST', headers, body })
      .catch(err => { unsubChunk(); unsubError(); unsubDone(); reject(err) })
  })
}

/**
 * Create a stream parser from a line-by-line processor function.
 * Handles buffer accumulation and line splitting — the shared boilerplate
 * that both Anthropic and OpenAI SSE parsers duplicate.
 */
export function createStreamParser(processLine: (line: string) => void): StreamParser {
  let buffer = ''
  return {
    processChunk(text: string): void {
      buffer += text
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) processLine(line)
    },
    flush(): void {
      if (buffer.trim()) processLine(buffer.trim())
    }
  }
}
