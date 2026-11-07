#!/usr/bin/env node
// 打包态 OCR 冒烟：Resources/ort-web 三件套能加载、三个模型能建会话。
// 用 plain node 而非 ELECTRON_RUN_AS_NODE —— onnxruntime-web 是纯 WASM，不绑
// Electron ABI；plain node 跑得起来恰好证明它真的没有原生依赖（这正是换掉
// onnxruntime-node 的目的：它的 Windows 二进制静态带 DirectML EP，dlopen 阶段
// 就要加载 DirectML.dll，Win10 1809 上 1114 且无法用 executionProviders 规避）。
'use strict'

const { existsSync, readdirSync, readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const { pathToFileURL } = require('node:url')

function parseArgs (argv) {
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
  console.error('usage: node scripts/smoke-packed-ocr.js --app-out <dir> --platform <linux|win32|darwin> --arch <x64|arm64>')
  process.exit(2)
}

// mac 的资源在 <out>/PulseMind.app/Contents/Resources，win/linux 在 <out>/resources
const resDirOf = (base) => {
  const apps = existsSync(base) ? readdirSync(base).filter((d) => d.endsWith('.app')) : []
  const candidates = [
    ...apps.map((d) => join(base, d, 'Contents', 'Resources')),
    ...['resources', 'Resources'].map((d) => join(base, d))
  ]
  return candidates.find((p) => existsSync(p)) || join(base, 'resources')
}
const resDir = resDirOf(appOut)
const ortDir = join(resDir, 'ort-web')
const modelsDir = join(resDir, 'ocr-models')
const fail = (msg) => {
  console.error(`[smoke-packed-ocr] FAIL: ${msg}`)
  process.exit(1)
}

// 1) 依赖已彻底换掉：onnxruntime-node 若还在包内就是 59MB 白背 + DirectML 崩点
const legacy = join(resDir, 'app.asar.unpacked', 'node_modules', 'onnxruntime-node')
if (existsSync(legacy)) fail(`onnxruntime-node still packed at ${legacy} — dependency switch is incomplete`)

// 2) WASM 运行时三件套：引擎 js + glue mjs + wasm 本体必须同目录
const required = ['ort.node.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']
for (const f of required) {
  if (!existsSync(join(ortDir, f))) fail(`missing ${f} in ${ortDir}`)
}
for (const f of ['det.onnx', 'rec.onnx', 'cls.onnx', 'keys.txt']) {
  if (!existsSync(join(modelsDir, f))) fail(`missing ${f} in ${modelsDir}`)
}

console.log(`[smoke-packed-ocr] ${platform}/${arch}  res=${resDir}`)
console.log(`  ort-web: ${required.join(', ')}`)

// 3) 真建会话：只断言「能加载」，不校验精度（精度由 tests/ocr-core.test.ts 钉）
;(async () => {
  const ort = require(join(ortDir, 'ort.node.min.js'))
  // Windows 的盘符路径（D:\…）会被 Node 的 ESM loader 当成协议 scheme
  // （ERR_UNSUPPORTED_ESM_URL_SCHEME: Received protocol 'd:'），而 ort 内部
  // 正是用 import() 去拉 ort-wasm-simd-threaded.mjs 的 —— 裸路径前缀
  // `ortDir + sep` 因此只在 POSIX 上侥幸可用。改成 ort 1.23 支持的
  // wasmPaths 对象形态（{ mjs }，取值时自动解 .href），wasm 二进制则读进
  // 内存经 wasmBinary 直供：两条路都不再碰裸盘符路径，两个平台一致。
  ort.env.wasm.wasmPaths = { mjs: pathToFileURL(join(ortDir, 'ort-wasm-simd-threaded.mjs')) }
  ort.env.wasm.wasmBinary = readFileSync(join(ortDir, 'ort-wasm-simd-threaded.wasm'))
  ort.env.wasm.numThreads = 1 // CI 单线程最稳，避免 SharedArrayBuffer 差异
  ort.env.wasm.proxy = false
  for (const m of ['det.onnx', 'rec.onnx', 'cls.onnx']) {
    const t0 = Date.now()
    const session = await ort.InferenceSession.create(
      readFileSync(join(modelsDir, m)),
      { executionProviders: ['wasm'] }
    )
    const outs = session.outputNames
    if (!outs || !outs.length) fail(`${m} created but exposes no outputs`)
    console.log(`  ${m.padEnd(9)} ok  ${String(Date.now() - t0).padStart(4)}ms  out[${outs.join(',')}]`)
  }
  const chars = readFileSync(join(modelsDir, 'keys.txt'), 'utf8').split('\n').filter(Boolean).length
  if (chars < 6000) fail(`keys.txt has only ${chars} chars — dictionary is truncated`)
  console.log(`  keys.txt  ${chars} chars`)
  console.log('PACKED-ORT-OK')
})().catch((e) => {
  console.error(`[smoke-packed-ocr] FAIL: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
