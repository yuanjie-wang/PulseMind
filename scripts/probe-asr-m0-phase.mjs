/**
 * Phase body for probe-asr-m0.mjs — run by the Electron binary under
 * ELECTRON_RUN_AS_NODE. Modes:
 *   main      — load the devDep addon via `sherpa-onnx-node`, transcribe zh.wav
 *               (gate 1) and measure RTF cold/hot ×10 with numThreads=4 (gate 5),
 *               probing language + ITN behaviour along the way.
 *   isolated  — load the addon straight out of an isolated directory (gate 4:
 *               packaged layout, dylibs next to the .node, no DYLD_* allowed).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const [modelDir, zhWav, mode, isolatedDir] = process.argv.slice(2)
const require = createRequire(import.meta.url)

function readWave (path) {
  // Minimal RIFF reader — 16-bit PCM mono/stereo, downmix + assert 16k after resample
  // is NOT done here: the test wavs from sherpa-onnx are already 16k mono.
  const buf = readFileSync(path)
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a RIFF/WAVE file: ${path}`)
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
    else if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('wav missing fmt/data chunk')
  const bytesPer = fmt.bits / 8
  const frames = Math.floor(data.length / (bytesPer * fmt.channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < fmt.channels; c++) {
      const p = (i * fmt.channels + c) * bytesPer
      acc += fmt.bits === 16 ? data.readInt16LE(p) / 32768 : data[p] / 255
    }
    samples[i] = acc / fmt.channels
  }
  return { samples, sampleRate: fmt.sampleRate }
}

if (mode === 'isolated') {
  // Gate 4: load the .node straight from the isolated dir. dylibs sit next to
  // it; the addon's baked LC_RPATH=@loader_path must resolve them. If the
  // process needed DYLD_LIBRARY_PATH this require throws.
  const addon = require(join(isolatedDir, 'sherpa-onnx.node'))
  if (typeof addon.createOfflineRecognizer !== 'function') {
    throw new Error('isolated addon loaded but API missing')
  }
  console.log('  ✓ isolated addon loaded (no DYLD_*)')
  process.exit(0)
}

// ---- mode === 'main' ----
const sherpa = require('sherpa-onnx-node')
const wave = readWave(zhWav)
const seconds = wave.samples.length / wave.sampleRate
console.log(`  wav: ${seconds.toFixed(2)}s @ ${wave.sampleRate}Hz ${statSync(zhWav).size} bytes`)

const modelPath = join(modelDir, 'model.int8.onnx')
const tokensPath = join(modelDir, 'tokens.txt')
if (!existsSync(modelPath) || !existsSync(tokensPath)) {
  console.error(`model missing in ${modelDir}: need model.int8.onnx + tokens.txt`)
  process.exit(2)
}

const NUM_THREADS = Math.min(4, require('node:os').cpus().length)
function buildConfig (language) {
  return {
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: modelPath,
        language,
        useInverseTextNormalization: 1
      },
      tokens: tokensPath,
      numThreads: NUM_THREADS,
      debug: 0,
      provider: 'cpu'
    }
  }
}

let t0 = Date.now()
const recognizer = new sherpa.OfflineRecognizer(buildConfig('auto'))
console.log(`  recognizer created (cold init): ${Date.now() - t0}ms, threads=${NUM_THREADS}`)

function transcribeOnce (language) {
  const stream = recognizer.createStream()
  stream.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
  const s = Date.now()
  recognizer.decode(stream)
  const ms = Date.now() - s
  const res = recognizer.getResult(stream)
  return { ms, text: res.text }
}

// cold run
const cold = transcribeOnce('auto')
console.log(`  cold: ${cold.ms}ms (RTF x${(cold.ms / 1000 / seconds).toFixed(2)}) text="${cold.text}"`)
if (!cold.text || cold.text.trim().length === 0) {
  console.error('FAIL: empty transcription')
  process.exit(1)
}

// hot ×10
const hot = []
for (let i = 0; i < 10; i++) hot.push(transcribeOnce('auto'))
const avg = hot.reduce((a, b) => a + b.ms, 0) / hot.length
const max = Math.max(...hot.map(h => h.ms))
const rtf = avg / 1000 / seconds
console.log(`  hot ×10: avg=${avg.toFixed(0)}ms max=${max}ms → RTF x${rtf.toFixed(2)} (budget: ≤2.0 → ${seconds * 2}s per 5s audio)`)
console.log(`  gate5 hot ≤2×realtime: ${rtf <= 2 ? 'PASS' : 'FAIL'}`)

// language pinning + ITN behaviour (settle M0 params)
const recognizerZh = new sherpa.OfflineRecognizer(buildConfig('zh'))
const streamZh = recognizerZh.createStream()
streamZh.acceptWaveform({ samples: wave.samples, sampleRate: wave.sampleRate })
recognizerZh.decode(streamZh)
const zhText = recognizerZh.getResult(streamZh).text
console.log(`  language=zh: "${zhText}"`)

// digits: ITN check — speak numbers; the bundled zh.wav content is unknown, so
// only report the two outputs side by side; text containing ASCII digits ⇒ ITN on.
console.log(`  ITN check: auto="${cold.text}" zh="${zhText}" ascii-digits=${/\d/.test(cold.text)}`)

if (rtf > 2) process.exit(1)
console.log('MAIN_PHASE_OK')
