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
  // hook-browser awaits this defensively before constructing a window; under
  // the stub there is nothing to wait for (the app is "ready" by definition).
  whenReady: async (): Promise<void> => undefined,
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
// that replaces this function with a throwing one. `openExternal` records the
// URLs the window-open gate handed the OS launcher (review 2026-09-26 中3) —
// an empty log on a popup URL is the non-vacuity surface for "the gate ran".
const externalOpens: string[] = []
export const shell = {
  trashItem: async (target: string): Promise<void> => {
    mkdirSync(TEST_TRASH_DIR, { recursive: true })
    await rename(target, join(TEST_TRASH_DIR, `${Date.now()}-${basename(target)}`))
  },
  openExternal: async (url: string): Promise<void> => {
    externalOpens.push(url)
  },
}
export function getStubExternalOpens(): string[] {
  return [...externalOpens]
}
export function resetStubExternalOpens(): void {
  externalOpens.length = 0
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

// ── clipboard (browser real-input primitives) ──
// The main-process clipboard BrowserService reads/writes for tab.clipboard.
// Module state stands in for the OS clipboard so a test can seed and inspect
// what an agent "copied" without touching the developer's real clipboard.
let stubClipboardText = ''
export const clipboard = {
  readText: (): string => stubClipboardText,
  writeText: (text: string): void => {
    stubClipboardText = text
  },
}
export function resetStubClipboard(): void {
  stubClipboardText = ''
}

// ── ipcMain / dialog / BrowserWindow (terminal gate, review 2026-09-25 P0-3) ──
// `ipcMain.handle` registers into a Map so a test drives the REAL registered
// handler with a synthetic invoke event — the gate under test is the
// production code path, never a copy of it. Importing THIS file and letting
// the handler import 'electron' resolve through the vitest alias yields the
// same module instance, so the registry the test reads is the one the
// handler filled.
export const ipcMain = {
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle(channel: string, listener: (...args: unknown[]) => unknown): void {
    this.handlers.set(channel, listener)
  },
  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  },
}
export function resetStubIpcHandlers(): void {
  ipcMain.handlers.clear()
}

// `dialog.showMessageBox` — the native confirmation the gate blocks on.
// response 0 = 允许执行, 1 = 拒绝 (the handler's defaultId/cancelId).
// The call log is the non-vacuity surface for "the gate really asked": a gate
// that skipped the dialog and fell through to allowed shows an empty log.
let stubDialogResponse = 1
const stubDialogCalls: unknown[][] = []
export function setStubDialogResponse(response: number): void {
  stubDialogResponse = response
}
export function getStubDialogCalls(): unknown[][] {
  return stubDialogCalls
}
export function resetStubDialog(): void {
  stubDialogResponse = 1
  stubDialogCalls.length = 0
}
export const dialog = {
  showMessageBox: async (
    ...args: unknown[]
  ): Promise<{ response: number; checkboxChecked: boolean }> => {
    stubDialogCalls.push(args)
    return { response: stubDialogResponse, checkboxChecked: false }
  },
}

// ── BrowserWindow ──
// `fromWebContents` returns null — the window-less fallback overload the gate
// must handle (detached/crashed renderer). `getSender()` then talks to the
// event's own webContents, which is what a test's fake sender is.
//
// Instances exist for hook-browser: the login-window primitive constructs one
// exactly as the app does, so the stub models the four runtime facts its
// contract rests on — construction options (assertable), loadURL (records
// the navigation), destroy → 'closed' (the event `close()` resolves on), and
// isDestroyed (the idempotency guard). The registry + reset are the
// assertion surface: how many windows opened, with what, and whether they
// were actually destroyed.
export class BrowserWindow {
  static fromWebContents(_webContents: unknown): null {
    return null
  }

  readonly options: Record<string, unknown>
  readonly loadedUrls: string[] = []
  private destroyed = false
  private readonly listeners = new Map<string, Array<() => void>>()
  /** The registered window-open handler + the will-navigate listener — the
   *  P0-2 gates the login window installs (review 2026-09-26 中3). */
  private windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null
  private willNavigateListener: ((details: { url: string; preventDefault: () => void }) => void) | null = null
  readonly windowOpenDecisions: Array<{ url: string; action: string }> = []
  /** Every `setTitleBarOverlay` repaint, in order — the caption-button
   *  theme × mask blend asserts against this (tests/title-bar-mask.test.ts). */
  readonly overlayUpdates: Array<{ color: string; symbolColor: string; height: number }> = []

  setTitleBarOverlay(overlay: { color: string; symbolColor: string; height: number }): void {
    this.overlayUpdates.push(overlay)
  }

  readonly webContents = {
    setWindowOpenHandler: (handler: (details: { url: string }) => { action: string }): void => {
      this.windowOpenHandler = handler
    },
    on: (event: string, listener: (details: { url: string; preventDefault: () => void }) => void): void => {
      if (event === 'will-navigate') this.willNavigateListener = listener
    },
  }

  /** Drive a page-side window.open through the registered gate. */
  openWindow(url: string): { action: string } {
    const decision = this.windowOpenHandler ? this.windowOpenHandler({ url }) : { action: 'allow' }
    this.windowOpenDecisions.push({ url, action: decision.action })
    return decision
  }

  /** Drive a top-frame navigation; true = allowed, false = preventDefault'd. */
  navigate(url: string): boolean {
    let blocked = false
    this.willNavigateListener?.({ url, preventDefault: () => { blocked = true } })
    return !blocked
  }

  constructor(options: Record<string, unknown> = {}) {
    this.options = options
    stubBrowserWindows.push(this)
  }

  loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url)
    return Promise.resolve()
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  once(event: string, listener: () => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    for (const listener of this.listeners.get('closed') ?? []) listener()
    this.listeners.delete('closed')
  }
}

const stubBrowserWindows: BrowserWindow[] = []

/** Every window constructed since the last reset, in creation order. */
export function getStubBrowserWindows(): BrowserWindow[] {
  return [...stubBrowserWindows]
}

export function resetStubBrowserWindows(): void {
  stubBrowserWindows.length = 0
}

// ── Notification ──
// routine-runner imports it at module load for its best-effort desktop
// notify; the real class must never appear in a test, so `isSupported()` is
// false and every path past it is a silent no-op shape.
export class Notification {
  static isSupported(): boolean { return false }
  constructor(_options?: { title?: string; body?: string }) {}
  show(): void {}
  on(_event: string, _listener: () => void): this { return this }
}
