// review_20260927 中1 — roleSet 对表探针 (bundler half).
// The body (probe-browser-role-table.body.mjs) imports the TS tables and the
// real verify path, so it is bundled with esbuild and executed — the TS import
// chain resolves while playwright-core stays real.
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tmpBundle = join(here, 'probe-browser-role-table.bundle.mjs')
await build({
  entryPoints: [join(here, 'probe-browser-role-table.body.mjs')],
  outfile: tmpBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external',
})
// The body ends with process.exit(0) (Chromium keeps a handle open), which
// skips this finally — so the cleanup also rides the exit event, or every run
// leaves an untracked bundle next to the probe.
const cleanup = () => rmSync(tmpBundle, { force: true })
process.once('exit', cleanup)
try {
  await import(pathToFileURL(tmpBundle).href)
} finally {
  cleanup()
}
