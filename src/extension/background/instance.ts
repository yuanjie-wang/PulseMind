/** Per-install identity for the extension (2026-11-05).
 *
 * The extension binary is identical in every browser that loads it, so its
 * protocol clientId is the constant `pulsemind-extension` — and the service's
 * same-clientId replacement rule therefore made Chrome and 360 kick each other
 * off `ws://127.0.0.1:8765` in an endless reconnect loop. The conversation
 * origin had the same collision: one browser's dead-scope release rolled up the
 * other browser's live tabs, and each install adopted the other's history.
 *
 * An instance id is minted once per browser profile and persisted in
 * `chrome.storage.local` — NOT in the shared config bag: `loadConfig`/
 * `saveConfig` round-trip only `{serviceUrl, token}`, so an instance id kept
 * there would be dropped by the next settings save. Local (not session)
 * storage because the identity must survive browser restarts: that is what
 * makes `(clientId, instanceId)` name the same install across sessions, while
 * a copied session scope must still be treated as dead.
 *
 * The value is an opaque token, never shown to the user; the server accepts
 * `[A-Za-z0-9_-]{1,64}` and treats anything else as absent (which keeps old
 * clients byte-identical). */

const STORAGE_KEY = 'pulsemind.instanceId'
const VALID = /^[A-Za-z0-9_-]{1,64}$/

/** Worker-lifetime cache: a storage failure must not mint a fresh identity on
 *  every alarm — each new id would look like a different install and leave the
 *  previous connection un-kicked. */
let cached: string | null = null
/** Serialized like the tab-scope mint: overlapping SW wake-ups must not each
 *  mint and write, or the loser's id would be stamped on a conversation the
 *  winner's connection never lists. */
let chain: Promise<unknown> = Promise.resolve()

/** Mint shape shared with the test that pins the accepted charset. */
export function mintInstanceId(): string {
  return `inst_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export async function getInstanceId(): Promise<string> {
  if (cached) return cached
  const run = chain.then(async () => {
    if (cached) return cached
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY)
      const raw = stored[STORAGE_KEY]
      if (typeof raw === 'string' && VALID.test(raw)) {
        cached = raw
        return raw
      }
    } catch {
      /* storage unreadable — fall through to an ephemeral identity */
    }
    const minted = mintInstanceId()
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: minted })
    } catch {
      /* storage unwritable: this worker lifetime keeps the ephemeral id */
    }
    cached = minted
    return minted
  })
  // A failed mint must not poison every queued caller behind it.
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
