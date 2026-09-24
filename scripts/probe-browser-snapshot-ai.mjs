// PLAN-browser-snapshot-ai — real-Chromium probe (bundler half).
// The body (probe-browser-snapshot-ai.body.mjs) is bundled with esbuild and
// executed, so the TS import chain resolves while playwright-core stays real.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const tmpBundle = join(here, 'probe-browser-snapshot-ai.bundle.mjs')
await build({
  entryPoints: [join(here, 'probe-browser-snapshot-ai.body.mjs')],
  outfile: tmpBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
})
try {
  await import(pathToFileURL(tmpBundle).href)
} finally {
  rmSync(tmpBundle, { force: true })
}
