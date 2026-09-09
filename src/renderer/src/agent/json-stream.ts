/**
 * Incremental JSON object tracker for streaming tool_use input.
 *
 * Replaces the naive `JSON.parse(acc)` per input_json_delta, which was O(n²)
 * over the accumulated string and nearly always threw while the object was
 * still incomplete (the result was discarded). This tracker scans only newly
 * arrived characters (O(total) overall), maintains bracket/string state, and
 * runs a full JSON.parse exactly once — when the top-level object closes.
 */

export interface PushResult {
  /** True only on the push where the top-level object completed. */
  justCompleted: boolean
  /** The parsed value, defined only when justCompleted is true. */
  value?: unknown
}

export class IncrementalJsonTracker {
  private acc = ''
  private depth = 0
  private inString = false
  private escaped = false
  private started = false
  private complete = false
  private value: unknown = undefined

  /** Feed newly arrived characters of the JSON document. */
  push(chunk: string): PushResult {
    if (this.complete) return { justCompleted: false }
    this.acc += chunk

    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]
      if (this.inString) {
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') this.inString = false
        continue
      }
      if (ch === '"') {
        this.inString = true
        this.started = true
        continue
      }
      if (ch === '{' || ch === '[') {
        this.depth++
        this.started = true
        continue
      }
      if (ch === '}' || ch === ']') {
        this.depth--
        if (this.started && this.depth === 0) {
          this.complete = true
          break
        }
      }
    }

    if (this.complete) {
      try {
        this.value = JSON.parse(this.acc)
        return { justCompleted: true, value: this.value }
      } catch {
        // Balanced brackets but invalid JSON (shouldn't happen with well-formed
        // input) — treat as incomplete so the block-stop fallback still runs.
        this.complete = false
      }
    }
    return { justCompleted: false }
  }

  /** The full accumulated string so far (for the block-stop final parse). */
  accumulated(): string {
    return this.acc
  }

  isComplete(): boolean {
    return this.complete
  }
}
