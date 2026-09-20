const { build } = require('esbuild')
const { copyFileSync } = require('node:fs')
const pkg = require('../package.json')

/** Dependencies that must remain in node_modules at runtime (native modules, electron, etc.) */
const EXTERNAL = [
  'electron',
  // ESM-only deps: the main bundle is CJS and require() of an ES module throws
  // ERR_REQUIRE_ESM at launch — bundle them instead so esbuild converts them.
  ...Object.keys(pkg.dependencies || {}).filter((name) => name !== 'marked')
]

/** Shared esbuild options for all Node-side targets (main, worker, preload) */
function nodeTarget(external) {
  return {
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external,
    tsconfig: 'tsconfig.node.json'
  }
}

async function main() {
  // Main process
  await build({
    entryPoints: ['src/main/index.ts'],
    outdir: 'out/main',
    ...nodeTarget(EXTERNAL)
  })
  console.log('✓ Main process built → out/main/index.js')

  // Extraction worker (forked child process, separate entry)
  await build({
    entryPoints: ['src/main/storage/extractors/extract-worker.ts'],
    outdir: 'out/main',
    ...nodeTarget(EXTERNAL)
  })
  console.log('✓ Extract worker built → out/main/storage/extractors/extract-worker.js')

  // Preload script
  await build({
    entryPoints: ['src/preload/index.ts'],
    outdir: 'out/preload',
    ...nodeTarget(['electron'])
  })
  console.log('✓ Preload built        → out/preload/index.js')

  // docx→PDF conversion page — loaded by the hidden conversion window
  // (src/main/office-export/docx-to-pdf.ts) via file:// out/docx2pdf/index.html.
  // Browser target, IIFE: docx-preview is bundled INTO the page, so the main
  // process keeps no runtime docx-preview dependency and the page needs no
  // node_modules at all (it runs sandboxed from inside app.asar when packaged).
  await build({
    entryPoints: ['src/renderer/docx2pdf/index.ts'],
    outdir: 'out/docx2pdf',
    bundle: true,
    minify: true,
    platform: 'browser',
    target: 'chrome120',
    format: 'iife'
  })
  // The HTML is not an esbuild entry — copy it next to the bundle it names.
  copyFileSync('src/renderer/docx2pdf/index.html', 'out/docx2pdf/index.html')
  console.log('✓ docx2pdf page built  → out/docx2pdf/index.html')
}

main().catch((err) => {
  console.error('\n❌ Build failed:', (err instanceof Error ? err.message : String(err)).split('\n')[0])
  if (process.env.DEBUG) console.error(err)
  process.exit(1)
})
