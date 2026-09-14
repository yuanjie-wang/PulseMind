/** Service discovery + token pairing (PLAN-browser-extension M0.3, G6/G7).
 *
 * The desktop's agent service listens on 127.0.0.1 with a deterministic
 * EADDRINUSE scan (8765..8779), and answers two plain HTTP GETs:
 *   /       → { service: 'pulsemind-agent', protocolVersion }   (liveness)
 *   /token  → { token }   (loopback Host + extension Origin only)
 *
 * A fetch() from the extension service worker to a host_permissions URL is
 * not CORS-gated, so pairing is one GET — the same trick Anywhere uses. */

import type { ExtensionConfig } from './config'

/** Must match PORT_SCAN_ATTEMPTS in src/main/agent/ws-server.ts. */
const SCAN_BASE_PORT = 8765
const SCAN_ATTEMPTS = 15

export interface Discovery {
  httpBase: string
  wsUrl: string
  token: string
  port: number
}

/** ws://host:port[/…] → http://host:port (fetch needs the http scheme). */
export function toHttpBase(serviceUrl: string): string {
  return serviceUrl.trim().replace(/\/+$/, '').replace(/^ws/i, 'http')
}

async function fetchToken(httpBase: string): Promise<string | null> {
  try {
    const res = await fetch(`${httpBase}/token`)
    if (!res.ok) return null
    const data = (await res.json()) as { token?: unknown }
    return typeof data.token === 'string' && data.token ? data.token : null
  } catch {
    return null
  }
}

async function isLive(httpBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${httpBase}/`)
    if (!res.ok) return false
    const data = (await res.json()) as { service?: unknown }
    return data.service === 'pulsemind-agent'
  } catch {
    return false
  }
}

/** Find the desktop service: manual override first, then the scan range.
 *  Returns null when nothing answers (desktop not running / token refused). */
export async function discoverService(cfg: ExtensionConfig): Promise<Discovery | null> {
  const bases = cfg.serviceUrl
    ? [toHttpBase(cfg.serviceUrl)]
    : Array.from({ length: SCAN_ATTEMPTS }, (_, i) => `http://127.0.0.1:${SCAN_BASE_PORT + i}`)

  for (const httpBase of bases) {
    if (!(await isLive(httpBase))) continue
    const token = cfg.token ?? (await fetchToken(httpBase))
    if (!token) continue
    const port = Number(new URL(httpBase).port)
    return { httpBase, wsUrl: httpBase.replace(/^http/i, 'ws'), token, port }
  }
  return null
}
