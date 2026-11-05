'use strict'

// 打包产物的 OCR 运行时冒烟：验证 afterPack 剥离后的 onnxruntime 二进制**仍能跑**。
//
// 为什么需要：strip-ort-foreign-arch 会删掉 352MB 的执行提供器库（CUDA/TensorRT/
// shared），并把异平台/异架构/冗余 dylib 一并清掉。electron-builder 退出码 0 只说明
// 打包完成，不说明裁完的二进制还能加载 —— 0.4.2 win portable 就是这么发出去的。
//
// 为什么不直接 require 打包目录：app.asar.unpacked 里只有 .node/.dylib（asarUnpack
// 命中的部分），JS 包装层（index.js）在 app.asar 内部，plain node 读不了 asar。
// 因此拼一个临时包：JS 包装层取自本仓 node_modules（与 lock 同版本），bin/ 目录
// **整体使用打包产物**——被测的正是那份被裁过的二进制。
//
// 用 plain node 而非 ELECTRON_RUN_AS_NODE：onnxruntime-node 走 N-API（napi-v6，
// ABI 稳定），Node 20 与 Electron 33 都能加载；而 Electron 二进制在 CI 容器里
// 依赖 libgtk/libnss，缺库会失败得与本次改动无关（假阴性）。
//
// 用法：node scripts/smoke-packed-ocr.js --app-out dist/linux-unpacked \
//          --platform linux --arch x64

const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

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

const resDirOf = (base) => ['resources', 'Resources'].map((d) => join(base, d)).find((p) => existsSync(p)) || join(base, 'resources')
const unpacked = join(resDirOf(appOut), 'app.asar.unpacked')
const ortPacked = join(unpacked, 'node_modules', 'onnxruntime-node')
const modelsDir = join(resDirOf(appOut), 'ocr-models')
const fail = (msg) => {
  console.error(`[smoke-packed-ocr] FAIL: ${msg}`)
  process.exit(1)
}
if (!existsSync(ortPacked)) fail(`onnxruntime-node not unpacked at ${ortPacked}`)
if (!existsSync(modelsDir)) fail(`ocr-models missing at ${modelsDir}`)

// 1) 打包产物自洽：bin 下不得残留异平台/异架构目录，也不得残留 provider 库
const binRoot = join(ortPacked, 'bin', 'napi-v6')
const leftOver = readdirSync(binRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name !== platform)
  .map((e) => e.name)
if (leftOver.length) fail(`foreign platform dir(s) left in napi-v6: ${leftOver.join(', ')}`)

const archDir = join(binRoot, platform, arch)
if (!existsSync(archDir)) fail(`no binary dir for ${platform}/${arch}`)
const archFiles = readdirSync(archDir)
const providerLeft = archFiles.filter((f) => /providers?/i.test(f))
if (providerLeft.length) fail(`execution-provider lib(s) not stripped: ${providerLeft.join(', ')}`)
console.log(`[smoke-packed-ocr] packed bin ok: ${platform}/${arch} -> ${archFiles.join(', ')}`)

// 2) 拼临时包：JS 包装层取本仓，bin/ 用打包产物
const repoOrt = resolve(__dirname, '..', 'node_modules', 'onnxruntime-node')
const repoCommon = resolve(__dirname, '..', 'node_modules', 'onnxruntime-common')
if (!existsSync(repoOrt) || !existsSync(repoCommon)) {
  fail('repo node_modules lacks onnxruntime-node/onnxruntime-common (run npm ci first)')
}
const scratch = mkdtempSync(join(tmpdir(), 'pm-ocr-smoke-'))
const staged = join(scratch, 'node_modules')
mkdirSync(staged, { recursive: true })
cpSync(repoOrt, join(staged, 'onnxruntime-node'), {
  recursive: true,
  filter: (src) => !src.includes(`${join('onnxruntime-node', 'bin')}`),
})
cpSync(repoCommon, join(staged, 'onnxruntime-common'), { recursive: true })
cpSync(join(binRoot, platform), join(staged, 'onnxruntime-node', 'bin', 'napi-v6', platform), { recursive: true })

process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

// 3) 真建会话：三个模型各跑一次
main().catch((e) => fail(e && e.message ? e.message : String(e)))

async function main () {
  const ort = require(join(staged, 'onnxruntime-node'))
  const keys = readFileSync(join(modelsDir, 'keys.txt'), 'utf8').split('\n')
  const charCount = keys.filter((k) => k.length > 0).length
  console.log(`[smoke-packed-ocr] ort ${ort.version || ort.env?.versions?.common || '?'} | keys ${charCount}`)
  if (charCount < 6000) fail(`keys.txt looks truncated (${charCount} entries)`)

  for (const name of ['det', 'rec', 'cls']) {
    const modelPath = join(modelsDir, `${name}.onnx`)
    if (!existsSync(modelPath)) fail(`model missing: ${modelPath}`)
    const t0 = Date.now()
    // 用静态工厂 create()：与 src/main/services/ocr.ts:120 的调用形态一致。
    // （`new ort.InferenceSession()` 返回的是 Promise，属性要 await 后才有，
    // 直接读 inputNames 会拿到 undefined —— 本地自检踩过一次。）
    const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] })
    const ms = Date.now() - t0
    const input = session.inputNames.join(',')
    const size = (statSync(modelPath).size / 1048576).toFixed(1)
    console.log(`[smoke-packed-ocr]   ${name}.onnx  ${size}MB  ok ${ms}ms  in[${input}]  out[${session.outputNames.join(',')}]`)
    session.release?.()
  }

  console.log('[smoke-packed-ocr] PACKED-ORT-OK')
}
