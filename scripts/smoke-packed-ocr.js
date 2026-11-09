#!/usr/bin/env node
// 打包态 OCR 冒烟：Resources/ort-web 三件套能加载、三个模型能建会话。
// 用 plain node 而非 ELECTRON_RUN_AS_NODE —— onnxruntime-web 是纯 WASM，不绑
// Electron ABI；plain node 跑得起来恰好证明它真的没有原生依赖（这正是换掉
// onnxruntime-node 的目的：它的 Windows 二进制静态带 DirectML EP，dlopen 阶段
// 就要加载 DirectML.dll，Win10 1809 上 1114 且无法用 executionProviders 规避）。
'use strict'

const { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { isAbsolute, join, relative, resolve } = require('node:path')

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

// 2.5) 裸依赖必须自洽在包内。ort.node.min.js 会 require('onnxruntime-common')，而本
// 脚本是在仓库里跑的：Node 沿目录向上就能找到仓库自己的 node_modules，替漏包兜底——
// 于是「仓库里绿、装机后 Cannot find module」这类漏包永远抓不到（0.5.0 的 ort-web 只
// 带了三个文件、漏掉 onnxruntime-common，就是这么发出去的）。这里把 ort.node.min.js
// 的每个裸 require 都解析一遍，并要求结果落在 appOut 之内。
const bareReqs = [
  ...new Set(
    [...readFileSync(join(ortDir, 'ort.node.min.js'), 'utf8').matchAll(/require\("([^".][^"]*)"\)/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('node:'))
  )
]
if (!bareReqs.length) fail('ort.node.min.js 里没扫到裸 require —— 匹配规则失效，这道门禁已无意义')
// appOut 与 require.resolve 的结果必须按**真实路径**比：require.resolve 会解掉符号
// 链接，而 mac 的 /tmp 正是指向 /private/tmp 的链接，直接前缀比对会把包内的合法路径
// 误判成包外。
const appOutReal = realpathSync(appOut)
for (const spec of bareReqs) {
  let resolved
  try {
    resolved = require.resolve(spec, { paths: [ortDir] })
  } catch {
    fail(`${spec} 无法解析 —— ort.node.min.js 会在 require 阶段崩（extraResources 漏带？）`)
  }
  const rel = relative(appOutReal, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    fail(`${spec} 解析到包外：${resolved} —— 仓库 node_modules 替它兜底，装机环境必然 Cannot find module`)
  }
  console.log(`  dep ${spec} -> ${rel}`)
}

console.log(`[smoke-packed-ocr] ${platform}/${arch}  res=${resDir}`)
console.log(`  ort-web: ${required.join(', ')}`)

// 3) 真建会话，而且由产品代码本身来建：把 src/main/services/ocr.ts 现场打成 bundle，
// 经 PULSEMIND_ORT_WEB / PULSEMIND_OCR_MODELS 指向包内资源，调它的 warmUpOcr()。
// 不要在这里另配 ORT —— 9103325 只把本脚本的 wasmPaths 改成 file:// URL，Windows
// 冒烟转绿，ocr.ts 仍给 ORT 裸盘符前缀（`F:\…\`），装机后 OCR 照样报
// ERR_UNSUPPORTED_ESM_URL_SCHEME（Received protocol 'f:'），直到 11-09 的 CI 都还是绿的。
// 线程数也随产品（≤4，pthread 走 worker_threads；Emscripten 会 unref 它们，进程照常
// 退出）——ORT 文档说 Node 只支持单线程，这条冒烟就是多线程在各平台上的实证。
// bundle 放系统临时目录：ocr.ts 的回落候选沿 __dirname 向上找 node_modules，放进
// 仓库就会被仓库自己的 onnxruntime-web 兜底；另外断言它选中的正是包内这两个目录。
// 只断言「能加载」，不校验精度（精度由 tests/ocr-core.test.ts 钉）
;(async () => {
  const work = mkdtempSync(join(tmpdir(), 'pm-smoke-ocr-'))
  try {
    const bundle = join(work, 'ocr.js')
    require('esbuild').buildSync({
      entryPoints: [join(__dirname, '..', 'src', 'main', 'services', 'ocr.ts')],
      outfile: bundle,
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'cjs',
      external: ['sharp'],
      tsconfig: join(__dirname, '..', 'tsconfig.node.json'),
      logLevel: 'error'
    })
    process.env.PULSEMIND_ORT_WEB = ortDir
    process.env.PULSEMIND_OCR_MODELS = modelsDir
    const t0 = Date.now()
    const w = await require(bundle).warmUpOcr()
    const same = (a, b) => realpathSync(a) === realpathSync(b)
    if (!same(w.ortWebDir, ortDir)) fail(`ocr.ts picked ort-web at ${w.ortWebDir}, not the packed ${ortDir}`)
    if (!same(w.modelsDir, modelsDir)) fail(`ocr.ts picked models at ${w.modelsDir}, not the packed ${modelsDir}`)
    // ocr.ts 刻意不给 ORT 任何路径（ORT 按 ort.node.min.js 的位置相对找另外两件，见
    // 其 loadOrtWeb 注释）。谁给它塞回路径，这里先红——别等 Windows 装机才发现。
    if (w.wasmPaths !== undefined) {
      fail(`ocr.ts set env.wasm.wasmPaths = ${JSON.stringify(w.wasmPaths)} —— must stay unset (see ocr.ts loadOrtWeb)`)
    }
    console.log(`  wasm      resolved next to ort.node.min.js (wasmPaths unset)  threads=${w.numThreads}`)
    for (const m of ['det', 'rec', 'cls']) {
      const outs = w.outputs[m]
      if (!outs || !outs.length) fail(`${m}.onnx created but exposes no outputs`)
      console.log(`  ${(m + '.onnx').padEnd(9)} ok  out[${outs.join(',')}]`)
    }
    if (w.chars < 6000) fail(`keys.txt has only ${w.chars} chars — dictionary is truncated`)
    console.log(`  keys.txt  ${w.chars} chars`)
    console.log(`  sessions  ${Date.now() - t0}ms`)
    console.log('PACKED-ORT-OK')
  } finally {
    // 清理失败不判红：临时 bundle 不是被测对象
    try {
      rmSync(work, { recursive: true, force: true })
    } catch {}
  }
})().catch((e) => {
  console.error(`[smoke-packed-ocr] FAIL: ${e && e.stack ? e.stack : e}`)
  process.exit(1)
})
