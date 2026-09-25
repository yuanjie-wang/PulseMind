// PLAN-browser-snapshot-ai — real-Chromium probe (bundler half).
// The body (probe-browser-snapshot-ai.body.mjs) is bundled with esbuild and
// executed, so the TS import chain resolves while playwright-core stays real.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmpBundle = join(here, 'probe-browser-snapshot-ai.bundle.mjs')
await build({
  entryPoints: [join(here, 'probe-browser-snapshot-ai.body.mjs')],
  outfile: tmpBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
})
// The body ends with process.exit(0) (the app-view browser keeps a handle
// open), which skips this finally — so the cleanup also rides the exit event,
// or every run leaves an untracked bundle next to the probe.
const cleanup = () => rmSync(tmpBundle, { force: true })
process.once('exit', cleanup)
try {
  await import(pathToFileURL(tmpBundle).href)
} finally {
  cleanup()
}
