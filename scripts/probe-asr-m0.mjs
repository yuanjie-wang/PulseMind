/**
 * M0 technical-validation probe for PLAN-voice-input (2026-11-19).
 *
 * Runs under the Electron binary in ELECTRON_RUN_AS_NODE mode — same V8 and
 * same N-API ABI as the real main process, which is exactly what M0 gate 1
 * needs ("Electron 加载 N-API addon"). No esbuild bundling yet: M0 exercises
 * the devDep `sherpa-onnx-node` + `sherpa-onnx-darwin-arm64` directly.
 *
 * Gates covered here:
 *   1. Electron loads the N-API addon and transcribes correctly (no ABI error).
 *   4. mac rpath: the addon ships with LC_RPATH=@loader_path, so an isolated
 *      directory (addon + dylibs copied out of node_modules, NO DYLD_LIBRARY_PATH)
 *      must load — this is the packaged `resources/asr-engine/<plat>-<arch>` layout.
 *   5. SenseVoice RTF: 5s zh wav, cold + hot ×10, numThreads=4 → hot ≤ 2× realtime;
 *      also settles language / useInverseTextNormalization behaviour.
 *
 * Usage: node scripts/probe-asr-m0.mjs <modelDir> <zhWav> [isolatedDir]
 * Set PULSEMIND_ASR_M0_ISOLATED=1 to run the isolated-layout gate in a child
 * process (the parent must not carry DYLD_LIBRARY_PATH either way).
 */
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const results = []
function check (name, pass, detail = '') {
  results.push({ name, pass: !!pass })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  return !!pass
}

function main () {
  const [modelDir, zhWav] = process.argv.slice(2)
  if (!modelDir || !zhWav || !existsSync(modelDir) || !existsSync(zhWav)) {
    console.error('usage: node scripts/probe-asr-m0.mjs <modelDir> <zhWav>')
    process.exit(2)
  }

  console.log('M0 gate 1+5: load addon in Electron (ELECTRON_RUN_AS_NODE), transcribe zh.wav')
  const phaseMain = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'probe-asr-m0-phase.mjs'), modelDir, zhWav, 'main'],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 300_000 }
  )
  console.log(phaseMain.stdout)
  if (phaseMain.status !== 0) console.error(phaseMain.stderr)
  check('gate1+5: addon loads + correct transcription + RTF budget', phaseMain.status === 0)

  console.log('\nM0 gate 4: isolated layout (packaged shape, no DYLD_*)')
  const isolated = mkdtempSync(join(tmpdir(), 'pulsemind-asr-m0-'))
  const platArch = `${process.platform}-${process.arch}`
  const src = join(import.meta.dirname, '..', 'node_modules', `sherpa-onnx-${platArch}`)
  for (const f of readdirSync(src)) {
    if (f.endsWith('.node') || f.endsWith('.dylib')) cpSync(join(src, f), join(isolated, f))
  }
  check('gate4: isolated dir populated', ['sherpa-onnx.node', 'libonnxruntime.dylib'].every(f => existsSync(join(isolated, f))))

  // Child process WITHOUT DYLD_LIBRARY_PATH (and PWD pointing at the isolated
  // dir is irrelevant — addon resolution goes through the explicit path).
  const phaseIso = spawnSync(
    process.execPath,
    [join(import.meta.dirname, 'probe-asr-m0-phase.mjs'), modelDir, zhWav, 'isolated', isolated],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DYLD_LIBRARY_PATH: '', DYLD_FALLBACK_LIBRARY_PATH: '' },
      encoding: 'utf8',
      timeout: 300_000,
      cwd: tmpdir()
    }
  )
  console.log(phaseIso.stdout)
  if (phaseIso.status !== 0) console.error(phaseIso.stderr)
  check('gate4: isolated layout loads without DYLD_*', phaseIso.status === 0)
  rmSync(isolated, { recursive: true, force: true })

  const failed = results.filter(r => !r.pass)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main()
