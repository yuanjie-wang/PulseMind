// OOPIF heal probe — real Electron main process + real CDP + real views.
//
// What jsdom/vitest cannot see and this probe pins, on the exact stack the
// app-view backend runs (WebContentsView sandbox:true, connectOverCDP over
// the app's own DevTools port):
//
//   1. The defect: a CDP connection that adopts a tab whose cross-origin
//      iframes already exist goes blind — page.frames() misses the frame,
//      the AI snapshot omits its content, and there is no ref to address.
//      (Frames born AFTER a connect are adopted normally — this is why
//      freshly created tabs work and only adopted ones go blind.)
//   2. The heal: the shipped healOopifBlindPage() diffs Electron's frame
//      list against Playwright's, reloads the blind page, and full control
//      returns — snapshot, frame-prefixed ref, and a click landing in the
//      frame once the tab is docked again.
//   3. The healthy baseline: a docked tab created through the faithful
//      newTab order (connect FIRST, navigate after) controls cross-origin
//      iframes end to end — the everyday path was never broken.
//   4. The negative: a page with no cross-origin frames is NOT reloaded —
//      its sentinel survives the heal call.
//
// The second CDP client connects while the first is still alive: that is
// the one (re)adopt shape Electron+Playwright support deterministically.
// A connect AFTER the previous client closed/died hangs in Playwright's
// connectOverCDP init whenever a composited view (or any window created
// between the connects) exists — upstream interop, see AGENTS.md.
//
// Usage: node scripts/probe-appview-oopif.mjs
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// The bundle must sit INSIDE the project for the external playwright-core
// require() to resolve under the electron binary.
const bundle = join(here, 'probe-appview-oopif.bundle.cjs')

await build({
  entryPoints: [join(here, 'probe-appview-oopif.body.mjs')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron', 'playwright-core'],
})

const cleanup = () => rmSync(bundle, { force: true })
process.once('exit', cleanup)

const electron = join(here, '..', 'node_modules', '.bin', 'electron')
const proc = spawn(electron, [bundle], { stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
proc.stdout.on('data', (d) => {
  out += d.toString()
  process.stdout.write(d)
})
proc.stderr.on('data', (d) => process.stderr.write(d))
const code = await new Promise((resolve) => proc.on('exit', resolve))
cleanup()
process.exit(code ?? (out.includes('PASS:') ? 0 : 1))
