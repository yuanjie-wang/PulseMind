// ── Element-edit preview nonce registry (M10) ──
// The parent renderer generates a per-mount nonce and registers it here; the
// local-file protocol handler reads it back when the preview copy is served
// and stamps it into the picker. The nonce never rides the frame URL — the
// served page could read location.search and forge pm:* messages that pass
// both the source check and the nonce check, silently rewriting its own file.
// (The nonce is still inside the injected picker script, which shares the
// page's JS realm — this registry closes the URL leak, which is the channel
// any script could read trivially; a hard page/PICKER boundary does not exist
// while the picker is deliberately in-realm.)

import * as path from 'node:path'

interface Registration {
  nonce: string
  registeredAt: number
}

const registrations = new Map<string, Registration>()

/** A registration outlives a slow serve but not a session: 10 minutes. */
const REGISTRATION_TTL_MS = 10 * 60 * 1000

/** One key shape for both writers: the renderer's raw path (possibly
 *  backslashed on Windows) and the protocol handler's URL-derived path
 *  (forward-slashed, drive letter from the hostname) resolve to the same
 *  absolute form. */
export function normalizeNonceKey(p: string): string {
  return path.resolve(p)
}

export function registerPreviewNonce(filePath: string, nonce: string): void {
  prune()
  registrations.set(normalizeNonceKey(filePath), { nonce, registeredAt: Date.now() })
}

export function takePreviewNonce(filePath: string): string | undefined {
  const key = normalizeNonceKey(filePath)
  const reg = registrations.get(key)
  if (!reg) return undefined
  if (Date.now() - reg.registeredAt > REGISTRATION_TTL_MS) {
    registrations.delete(key)
    return undefined
  }
  return reg.nonce
}

function prune(): void {
  const now = Date.now()
  for (const [key, reg] of registrations) {
    if (now - reg.registeredAt > REGISTRATION_TTL_MS) registrations.delete(key)
  }
}

