const { build } = require('esbuild')
const pkg = require('../package.json')

/** Dependencies that must remain in node_modules at runtime (native modules, electron, etc.) */
const EXTERNAL = [
  'electron',
  ...Object.keys(pkg.dependencies || {})
]

async function main() {
  // Main process
  await build({
    entryPoints: ['src/main/index.ts'],
    outdir: 'out/main',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
    tsconfig: 'tsconfig.node.json'
  })
  console.log('✓ Main process built → out/main/index.js')

  // Extraction worker (forked child process, separate entry)
  await build({
    entryPoints: ['src/main/storage/extractors/extract-worker.ts'],
    outdir: 'out/main',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: EXTERNAL,
    tsconfig: 'tsconfig.node.json'
  })
  console.log('✓ Extract worker built → out/main/storage/extractors/extract-worker.js')

  // Preload script
  await build({
    entryPoints: ['src/preload/index.ts'],
    outdir: 'out/preload',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    tsconfig: 'tsconfig.node.json'
  })
  console.log('✓ Preload built        → out/preload/index.js')
}

main().catch((err) => {
  console.error('\n❌ Build failed:', (err instanceof Error ? err.message : String(err)).split('\n')[0])
  if (process.env.DEBUG) console.error(err)
  process.exit(1)
})
