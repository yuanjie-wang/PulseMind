#!/usr/bin/env node
// 打包态 ASR 冒烟（PLAN-voice-input M3）：包内 asr-engine 能被产品加载器选中、
// sha 门过、真建 recognizer、真转写随包 wav 夹具。
//
// 对齐 2026-11-09 的 OCR 教训：冒烟必须**驱动产品代码**——把 src/main/services/
// asr-recognizer.ts + asr-engine.ts 现场打成 bundle（asr-worker.ts 与它同目录，
// 复刻 out/main 的布局，worker_threads 的 __dirname 解析才和产品一致），经
// PULSEMIND_ASR_ENGINE 指向包内引擎，调 transcribeSamples()。冒烟自配一套
// require('sherpa-onnx.node') 的加载逻辑 = 门禁绿装机崩的老路，不走。
//
// 用 ELECTRON_RUN_AS_NODE 跑（native addon 与主进程同 ABI；plain node 的
// N-API 也能载，但我们要证的是「Electron 里能载」）。
//
// 用法：
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/smoke-packed-asr.js \
//     --app-out <dir> --platform <darwin|win32|linux> --arch <x64|arm64> \
//     [--model-dir <sensevoice dir>] [--wav <fixture>]
// --model-dir 缺省 = 只做「包内引擎选中 + sha 门 + addon 加载」三件事（模型
// 不随包，CI 传了才做真转写段）。
'use strict'

const { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    out[argv[i].slice(2)] = argv[i + 1]
    i++
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const appOut = resolve(args['app-out'] || '')
const platform = args.platform
const arch = args.arch
if (!existsSync(appOut) || !platform || !arch) {
  console.error('usage: smoke-packed-asr.js --app-out <dir> --platform <darwin|win32|linux> --arch <x64|arm64> [--model-dir <dir>] [--wav <file>]')
  process.exit(2)
}

// mac 的资源在 <out>/PulseMind.app/Contents/Resources，win/linux 在 <out>/resources
const resDirOf = (base) => {
  const apps = existsSync(base) ? readdirSync(base).filter((d) => d.endsWith('.app')) : []
  const candidates = [...apps.map((d) => join(base, d, 'Contents', 'Resources')), ...['resources', 'Resources'].map((d) => join(base, d))]
  return candidates.find((p) => existsSync(p)) || join(base, 'resources')
}
const resDir = resDirOf(appOut)
const engineDir = join(resDir, 'asr-engine', `${platform}-${arch}`)
const fail = (msg) => {
  console.error(`[smoke-packed-asr] FAIL: ${msg}`)
  process.exit(1)
}

// 1) 引擎随包：目录 + 必备文件（与 asr-engine.ts 的 REQUIRED 清单同源）
// linux 多一条私有 C++ 运行库 libpmcxx.so.6（方案 ①）：厂商引擎要
// GLIBCXX_3.4.29，UOS 20 的系统 libstdc++ 只到 3.4.25。名字不能叫
// libstdc++.so.6 —— glibc 按 SONAME 复用已加载对象，同名副本永远打不开。
const REQUIRED =
  {
    darwin: ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib'],
    win32: ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll'],
    linux: ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so', 'libpmcxx.so.6'],
  }[platform] || []
if (!REQUIRED.length) fail(`unknown platform ${platform}`)
for (const f of REQUIRED) {
  if (!existsSync(join(engineDir, f))) fail(`missing ${f} in ${engineDir} — prepare-asr-engine.js 没跑或 extraResources filter 不匹配`)
}
if (!existsSync(join(engineDir, 'manifest.json'))) fail(`missing manifest.json in ${engineDir} — sha 门将跳过，包内引擎的完整性无证据`)

// 1b) linux：引擎对象不得还链着系统 libstdc++.so.6。残留 = 私有运行库形同虚设
//（同名 SONAME 会被复用），装机后照样 `version 'GLIBCXX_3.4.29' not found`。
// 只在打包期能抓——这类失败在构建机上永远绿（构建机的 libstdc++ 够新）。
if (platform === 'linux') {
  const stale = Buffer.from('libstdc++.so.6\0', 'latin1')
  for (const f of REQUIRED.filter((n) => n !== 'libpmcxx.so.6')) {
    if (readFileSync(join(engineDir, f)).includes(stale)) {
      fail(`${f} 仍 NEEDED libstdc++.so.6 —— 私有运行库不会被打开（SONAME 去重），UOS 上必定 version not found`)
    }
  }
}
console.log(`[smoke-packed-asr] ${platform}/${arch}  engine=${engineDir}`)

// 2) 引擎依赖不得越界：win 的 dll / mac 的 dylib / linux 的 .so 都必须在
// engineDir 内（额外平台包混进来会被 filter 滤掉，这里核对反向面）
const extras = readdirSync(engineDir).filter(
  (f) => !REQUIRED.includes(f) && f !== 'manifest.json' && (f.endsWith('.so') || f.endsWith('.dylib') || f.endsWith('.dll')),
)
if (extras.length > 0) fail(`engine dir has unexpected native files: ${extras.join(', ')} — extraResources filter 越界`)

// 3) 驱动产品代码：esbuild 现场 bundle asr-recognizer.ts + asr-worker.ts 到
// 同一临时目录（复刻 out/main 布局），PULSEMIND_ASR_ENGINE 指向包内目录。
;(async () => {
  const work = mkdtempSync(join(tmpdir(), 'pm-smoke-asr-'))
  let exitCode = 0
  try {
    const esbuild = require('esbuild')
    const nodeTarget = {
      bundle: true,
      minify: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['electron'],
      tsconfig: join(__dirname, '..', 'tsconfig.node.json'),
      logLevel: 'error',
    }
    esbuild.buildSync({
      entryPoints: [join(__dirname, '..', 'src', 'main', 'services', 'asr-recognizer.ts')],
      outfile: join(work, 'asr-recognizer.js'),
      ...nodeTarget,
    })
    esbuild.buildSync({ entryPoints: [join(__dirname, '..', 'src', 'main', 'services', 'asr-worker.ts')], outfile: join(work, 'asr-worker.js'), ...nodeTarget })
    process.env.PULSEMIND_ASR_ENGINE = engineDir
    const product = require(join(work, 'asr-recognizer.js'))

    // 3a) 产品加载器必须选中包内目录（不是 devDep 回落）
    const status = product.getAsrEngineStatus()
    const same = (a, b) => realpathSync(a) === realpathSync(b)
    if (!status.engine || !same(status.engine.dir, engineDir)) {
      fail(`product loader picked ${status.engine ? status.engine.dir : 'nothing'}, not the packed ${engineDir} — resolveAsrEngineDir 的 env 候选失效？`)
    }
    console.log(`  loader -> ${status.engine.dir} (v${status.engine.version}, verified manifest)`)

    // 3b) 打包态模型清单可达（review 20261120 H1 的回归钉）：产品的
    //     readCatalog 必须经 resourcesPath 候选读到包内 asr/models.json——
    //     清单没进包（只在 asar 里找）或候选梯断了时这里红。冒烟进程是
    //     RUN_AS_NODE 的纯 Node 形态，手动摆出打包态的 resourcesPath。
    writeFileSync(join(work, 'electron-stub.js'), "module.exports = { app: { isPackaged: true, getAppPath: () => process.cwd() } }\n")
    esbuild.buildSync({
      entryPoints: [join(__dirname, '..', 'src', 'main', 'services', 'model-manager.ts')],
      outfile: join(work, 'model-manager.js'),
      ...nodeTarget,
      // model-manager 传递依赖 storage/index → electron 的 app：给一个假体
      // （readCatalog 不触 getTemplatesDir，永不调用）。
      alias: { electron: join(work, 'electron-stub.js') },
    })
    Object.defineProperty(process, 'resourcesPath', { value: resDir, configurable: true, writable: true, enumerable: true })
    delete process.env.PULSEMIND_ASR_CATALOG // 只证打包候选梯，env 缝必须缺席
    const mm = require(join(work, 'model-manager.js'))
    const cat = mm.readCatalog('asr')
    if (!cat.catalog || cat.error) {
      fail(`packaged readCatalog failed: ${cat.error} — resources/asr 没进包（extraResources 缺条目？）或清单候选梯断了`)
    }
    if (cat.catalog.family !== 'asr' || cat.catalog.models.length === 0) {
      fail(`packaged catalog invalid: family=${cat.catalog.family}, models=${cat.catalog.models.length}`)
    }
    console.log(`  catalog -> ${cat.catalog.models.length} model(s) via packaged resourcesPath`)

    // 3c) 真转写段：CI 传了 --model-dir 才跑（模型 226MB 不随包）
    const modelDir = args['model-dir']
    if (!modelDir || !existsSync(join(modelDir, 'model.int8.onnx'))) {
      console.log('  --model-dir 缺省或无效：跳过真转写段（只验引擎加载）。CI 传缓存模型可覆盖。')
      console.log('[smoke-packed-asr] OK (engine-load + catalog only)')
      return
    }
    const wav = args.wav || join(__dirname, '..', 'resources', 'asr', 'fixtures', 'zh.wav')
    if (!existsSync(wav)) fail(`fixture wav missing: ${wav}`)
    // 最小 RIFF 读取（16k mono PCM）——与 probe-asr-m0-phase 同款
    const buf = readFileSync(wav)
    let off = 12
    let data = null
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') {
        data = buf.subarray(off + 8, off + 8 + size)
        break
      }
      off += 8 + size + (size % 2)
    }
    if (!data) fail('wav missing data chunk')
    const samples = new Float32Array(Math.floor(data.length / 2))
    for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768
    const seconds = samples.length / 16000
    const r = await product.transcribeSamples(samples, 16000, modelDir, { language: 'auto' })
    const text = (r.text || '').trim()
    // 非空 + RTF 预算（M0-5：热路径 ≤2× 实时，冒烟取 4× 宽限 CI 机器的慢盘冷启）
    const budget = Math.max(30000, seconds * 4000)
    if (!text) fail(`transcription empty after ${r.ms}ms — 引擎加载但推理失败`)
    if (r.ms > budget) fail(`transcription took ${r.ms}ms for ${seconds.toFixed(1)}s audio — beyond RTF budget`)
    const sha = createHash('sha256').update(text).digest('hex').slice(0, 12)
    console.log(`  transcribe ${seconds.toFixed(1)}s -> ${r.ms}ms "${text.slice(0, 40)}" (sha ${sha})`)
    console.log('[smoke-packed-asr] OK (engine-load + catalog + real transcription)')
  } catch (e) {
    exitCode = 1
    console.error(`[smoke-packed-asr] FAIL: ${e && e.stack ? e.stack : String(e)}`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  process.exit(exitCode)
})()
