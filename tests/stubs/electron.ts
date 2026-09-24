import { mkdirSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { basename, join } from 'node:path'

// Minimal stand-in for the electron module so main-process storage modules can
// be imported under plain Node. getTemplatesDir() reads app.isPackaged and
// app.getAppPath(); provide a scratch approot whose templates/pulsemind exists
// so ensureDataDir()'s recursive template copy is a no-op.
const APP_ROOT = join(process.env.HOME || '/tmp', 'pulsemind-test-approot')
mkdirSync(join(APP_ROOT, 'templates', 'pulsemind'), { recursive: true })

export const app = {
  isPackaged: false,
  getAppPath: () => APP_ROOT,
}

// `powerSaveBlocker` is here for the keep-awake guard (src/main/system/keep-awake.ts):
// a tiny in-process model — start() hands out ids, stop() retires them — so the
// wiring can be driven for real under vitest. The live count is the assertion
// surface: holding must mean exactly one OS-level blocker, never two.
let blockerSeq = 0
const liveBlockers = new Map<number, string>()
export const powerSaveBlocker = {
  start: (type: string): number => {
    const id = ++blockerSeq
    liveBlockers.set(id, type)
    return id
  },
  stop: (id: number): void => {
    liveBlockers.delete(id)
  },
  isStarted: (id: number): boolean => liveBlockers.has(id),
}

/** How many blockers this stub currently reports as started. */
export function livePowerSaveBlockers(): number {
  return liveBlockers.size
}

/** Where this stub's `shell.trashItem` parks what it "trashes". */
export const TEST_TRASH_DIR = join(process.env.HOME || '/tmp', 'pulsemind-test-trash')

// `shell` is here for svcDeletePath: a delete goes to the OS trash first and
// only falls back to a real removal where no trash exists. Modelling the happy
// path (a move into a scratch trash) is what makes "a deleted file is
// recoverable" a claim a test can check; the fallback is exercised by a test
// that replaces this function with a throwing one.
export const shell = {
  trashItem: async (target: string): Promise<void> => {
    mkdirSync(TEST_TRASH_DIR, { recursive: true })
    await rename(target, join(TEST_TRASH_DIR, `${Date.now()}-${basename(target)}`))
  },
}

// ── safeStorage (PLAN-security-hardening P1) ──
// A reversible fake so the settings-store encryption round-trip runs for real
// under vitest. The transform must produce bytes distinct from the plaintext
// (an encrypt that returned its input would make "盘上是密文" vacuous), so it
// wraps base64 in a marker; `decryptString` throws on anything else, which is
// how the corrupt-blob test drives the drop-and-warn path. `available` is
// module state a test flips to drive the plaintext-fallback branch.
let stubEncryptionAvailable = true
const STUB_ENC_MARK = 'stubenc:'

export const safeStorage = {
  isEncryptionAvailable: (): boolean => stubEncryptionAvailable,
  encryptString: (plain: string): Buffer => {
    if (denyEncrypt) throw new Error('The user denied access to the keychain')
    return Buffer.from(STUB_ENC_MARK + Buffer.from(plain, 'utf-8').toString('base64'), 'utf-8')
  },
  decryptString: (blob: Buffer): string => {
    const s = blob.toString('utf-8')
    if (!s.startsWith(STUB_ENC_MARK)) throw new Error('not a stub-encrypted blob')
    return Buffer.from(s.slice(STUB_ENC_MARK.length), 'base64').toString('utf-8')
  },
}

/** Flip the stub's availability — the plaintext-fallback branch's driver. */
export function setStubEncryptionAvailable(available: boolean): void {
  stubEncryptionAvailable = available
}

/** Simulate the user DECLINING the macOS keychain prompt: availability says
 *  yes, but every encryptString throws. One-shot per setting. */
let denyEncrypt = false
export function setStubKeychainDenied(denied: boolean): void {
  denyEncrypt = denied
}
