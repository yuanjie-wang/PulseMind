/**
 * Streaming pipe decoder for shell output (terminal service).
 *
 * A plain `chunk.toString('utf-8')` has two failure modes on a Windows child
 * pipe:
 *   1. Node's `data` chunks are cut at arbitrary byte offsets — a 3-byte
 *      Chinese character split across two events decodes as U+FFFD. (GBK pairs
 *      split the same way.)
 *   2. On Chinese Windows the ANSI/OEM codepage is cp936: legacy tools (Python
 *      without UTF-8 mode, batch builtins, old console programs) emit GBK bytes
 *      on pipes even after WIN_PS_UTF8_PREFIX forced PowerShell itself to UTF-8
 *      — the terminal service's comment there calls this the remaining source.
 *
 * The encoding rule mirrors decodeCsvBytes (routine/batch-source.ts): strict
 * UTF-8 first, GBK fallback. Streaming makes it two decisions instead of one:
 * an incomplete UTF-8 tail (≤3 bytes) is held for the next push, and the first
 * buffer that cannot be UTF-8 commits the stream to GBK — sticky, because a
 * mixed stream cannot be re-guessed reliably backwards. GBK output is split on
 * pair boundaries (a trailing lead byte 0x81–0xFE awaits its trail byte), so a
 * pair cut across chunks reassembles. BOMs need no special case: TextDecoder
 * drops a buffer-leading UTF-8 BOM on every decode() call, and the holdback
 * loop keeps a BOM split across chunks buffered until it is whole.
 */

export interface StreamDecoder {
  /** Decode one pipe chunk. Returns the text safe to emit now — possibly ''
   *  when an incomplete sequence is being held for the next push. */
  push(chunk: Buffer): string
  /** Emit whatever is still held at end of stream. Idempotent. */
  flush(): string
}

/** Length of the pair-aligned GBK prefix: bytes walk 1 (ASCII) or 2 (lead+
   trail), stopping before a lone lead byte at the end that awaits its trail. */
function gbkCut(buf: Buffer): number {
  let i = 0
  while (i < buf.length) {
    const b = buf[i]
    if (b >= 0x81 && b <= 0xfe) {
      if (i + 1 >= buf.length) break
      i += 2
    } else {
      i += 1
    }
  }
  return i
}

export function createStreamDecoder(): StreamDecoder {
  // Non-stream TextDecoder instances are stateless between decode() calls, so
  // one of each per stream is safe to reuse.
  const utf8Strict = new TextDecoder('utf-8', { fatal: true })
  const gbkLenient = new TextDecoder('gbk')
  let held = Buffer.alloc(0)
  let mode: 'undecided' | 'gbk' = 'undecided'

  function decodeGbk(buf: Buffer): string {
    const cut = gbkCut(buf)
    held = Buffer.from(buf.subarray(cut))
    return gbkLenient.decode(buf.subarray(0, cut))
  }

  function process(buf: Buffer): string {
    if (mode === 'gbk') return decodeGbk(buf)
    // Prefer UTF-8: the whole buffer, then with 1–3 tail bytes held back as a
    // possibly-incomplete sequence. A buffer that survives none of these has a
    // byte no UTF-8 sequence can start at — commit to GBK from here on.
    for (let k = 0; k <= 3 && k <= buf.length; k++) {
      try {
        const text = utf8Strict.decode(buf.subarray(0, buf.length - k))
        held = k > 0 ? Buffer.from(buf.subarray(buf.length - k)) : Buffer.alloc(0)
        return text
      } catch {
        /* hold one more tail byte and retry */
      }
    }
    mode = 'gbk'
    return decodeGbk(buf)
  }

  return {
    push(chunk: Buffer): string {
      const buf = held.length ? Buffer.concat([held, chunk]) : chunk
      held = Buffer.alloc(0)
      if (buf.length === 0) return ''
      return process(buf)
    },
    flush(): string {
      const buf = held
      held = Buffer.alloc(0)
      if (buf.length === 0) return ''
      if (mode === 'gbk') return gbkLenient.decode(buf)
      try {
        return utf8Strict.decode(buf)
      } catch {
        return gbkLenient.decode(buf)
      }
    },
  }
}
