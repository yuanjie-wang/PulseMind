/**
 * Browser-extension build (PLAN-browser-extension M0.5).
 *
 * Independent of the Electron builds: the extension is plain browser TS
 * bundled with esbuild into `out/extension/`, ready to load unpacked via
 * chrome://extensions. Manifest/options html are copied verbatim.
 */
const { build } = require('esbuild')
const { cpSync, mkdirSync, rmSync } = require('node:fs')

const OUT = 'out/extension'

/** Shared esbuild options for all extension entries (MV3 service workers and
 *  extension pages want classic scripts → iife). */
function browserTarget() {
  return {
    bundle: true,
    minify: false,
    platform: 'browser',
    target: ['chrome114'],
    format: 'iife',
    tsconfig: 'tsconfig.extension.json',
    logLevel: 'warning',
  }
}

async function main() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  // Background service worker
  await build({
    entryPoints: ['src/extension/background/index.ts'],
    outfile: `${OUT}/background.js`,
    ...browserTarget(),
  })
  console.log('✓ Extension background → out/extension/background.js')

  // Options page
  await build({
    entryPoints: ['src/extension/options/index.ts'],
    outfile: `${OUT}/options.js`,
    ...browserTarget(),
  })
  cpSync('src/extension/options/options.html', `${OUT}/options.html`)
  console.log('✓ Extension options    → out/extension/options.js')

  // Static assets
  cpSync('src/extension/manifest.json', `${OUT}/manifest.json`)
  console.log('✓ Extension manifest   → out/extension/manifest.json')
  console.log('\nLoad unpacked: chrome://extensions → 开发者模式 → 加载已解压 → out/extension')
}

main().catch((err) => {
  console.error('\n❌ Extension build failed:', (err instanceof Error ? err.message : String(err)).split('\n')[0])
  if (process.env.DEBUG) console.error(err)
  process.exit(1)
})
