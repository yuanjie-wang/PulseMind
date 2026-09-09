import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

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
