// ── SSRF gate: private/reserved address classification ──
// Shared by the API proxy (`validateRequestUrl`) and the tool bridge's
// `http.request` (review 2026-09-25 P1): both fetch URLs that ultimately
// come from a model, so both must refuse private/reserved ranges — RFC1918
// + loopback + link-local + CGNAT + multicast/reserved + the cloud-metadata
// host — and both resolve hostnames through DNS, so a public name that
// points inside the network fails the same check. Two traps this shape
// exists for: WHATWG URL normalizes decimal/hex/short IPv4
// (`http://2130706433/` → `127.0.0.1`) so the dotted form is what we judge,
// while an IPv6 URL keeps its brackets in `.hostname` (`[::1]`) — `isIP`
// returns 0 for the bracketed string, DNS lookup then fails, and the
// failure branch says "not private" — so brackets are stripped first.

import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/** Expand an IPv6 literal to its 8 16-bit groups (a trailing dotted-quad
 *  folds into two groups). Null when the text is not an address. */
function ipv6Groups(host: string): number[] | null {
  let text = host
  const v4 = text.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const n = v4.slice(1).map(Number)
    if (n.some((x) => x > 255)) return null
    text = text.slice(0, v4.index) + ((n[0] << 8) | n[1]).toString(16) + ':' + ((n[2] << 8) | n[3]).toString(16)
  }
  const dbl = text.indexOf('::')
  if (dbl !== text.lastIndexOf('::')) return null // at most one '::'
  const parse = (s: string): number[] | null =>
    s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : NaN))
  const left = parse(dbl >= 0 ? text.slice(0, dbl) : text)
  const right = dbl >= 0 ? parse(text.slice(dbl + 2)) : []
  if (!left || !right || [...left, ...right].some(Number.isNaN)) return null
  if (dbl < 0 ? left.length !== 8 : left.length + right.length > 7) return null
  const zeros = dbl < 0 ? 0 : 8 - left.length - right.length
  return [...left, ...new Array(zeros).fill(0), ...right]
}

/** IP falls within a private/reserved range (SSRF prevention). */
export function isPrivateIP(ip: string): boolean {
  const host = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  if (host.includes(':')) {
    // Embedded IPv4: judge the v4 tail, not the v6 wrapper. WHATWG URL
    // renders v4-mapped in HEX (`[::ffff:127.0.0.1]` → `[::ffff:7f00:1]`), so
    // a dotted-quad-only guard reads that as a plain v6 address and waves
    // loopback through. Carrier prefixes: ::/96 (v4-compatible, where ::1 and
    // :: themselves land too), ::ffff:0:0/96 (mapped), ::ffff:0:0:0/96
    // (translated), 64:ff9b::/96 (NAT64).
    const g = ipv6Groups(host)
    if (g) {
      const zero = (from: number, to: number): boolean => g.slice(from, to).every((x) => x === 0)
      const tailV4 = `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`
      const carrier = (zero(0, 5) && g[5] === 0xffff) // ::ffff:0:0/96 mapped
        || zero(0, 6) // ::/96 v4-compatible (covers ::, ::1)
        || (zero(0, 4) && g[4] === 0xffff && g[5] === 0) // ::ffff:0:0:0/96 translated
        || (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) // 64:ff9b::/96 NAT64
      if (carrier) return isPrivateIP(tailV4)
    }
    // IPv6: ::1 loopback, :: unspecified, fc00::/7 ULA, fe80::/10
    // link-local (+ fec0::/10 deprecated site-local), ff00::/8 multicast.
    return host === '::1' || host === '::'
      || host.startsWith('fc') || host.startsWith('fd')
      || /^fe[89abcdef]/.test(host)
      || host.startsWith('ff')
  }
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false
  const [a, b, c] = parts
  return a === 0 // 0.0.0.0/8 "this host"
    || a === 10 // 10.0.0.0/8 RFC1918
    || a === 127 // 127.0.0.0/8 loopback
    || (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 CGNAT
    || (a === 169 && b === 254) // 169.254.0.0/16 link-local (incl. cloud metadata)
    || (a === 172 && b >= 16 && b <= 31) // 172.16.0.0/12 RFC1918
    || (a === 192 && b === 168) // 192.168.0.0/16 RFC1918
    || (a === 192 && b === 0 && c === 0) // 192.0.0.0/24 IETF protocol assignments
    || (a === 198 && (b === 18 || b === 19)) // 198.18.0.0/15 benchmarking
    || a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
}

const PRIVATE_HOST_TTL = 5 * 60 * 1000
const privateHostCache = new Map<string, { result: boolean; time: number }>()

/** Whether a hostname is private: literal IPs classify directly, names go
 *  through DNS (5 min cache). DNS failure reads as "not private" so the
 *  fetch itself produces the user-visible error. */
export async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  if (isIP(host)) return isPrivateIP(host)
  const cached = privateHostCache.get(host)
  if (cached !== undefined && Date.now() - cached.time < PRIVATE_HOST_TTL) return cached.result
  try {
    const { address } = await lookup(host)
    const result = isPrivateIP(address)
    privateHostCache.set(host, { result, time: Date.now() })
    return result
  } catch {
    return false // DNS failure — let the fetch itself fail naturally
  }
}
