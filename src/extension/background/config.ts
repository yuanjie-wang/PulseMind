/** Extension config (chrome.storage.local): the service address and pairing
 *  token. Empty fields mean "discover automatically" (M0.5: port scan +
 *  GET /token pairing against the desktop's loopback service). */

export interface ExtensionConfig {
  /** Manual override, e.g. ws://127.0.0.1:8765 — empty = scan 8765..8779. */
  serviceUrl?: string
  /** Manual token override — empty = pair via GET /token. */
  token?: string
}

const STORAGE_KEY = 'pulsemind'

export async function loadConfig(): Promise<ExtensionConfig> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const raw = (stored[STORAGE_KEY] ?? {}) as Record<string, unknown>
  return {
    serviceUrl: typeof raw.serviceUrl === 'string' && raw.serviceUrl.trim() ? raw.serviceUrl.trim() : undefined,
    token: typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : undefined,
  }
}

export async function saveConfig(patch: ExtensionConfig): Promise<void> {
  const current = await loadConfig()
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...patch } })
}
