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
