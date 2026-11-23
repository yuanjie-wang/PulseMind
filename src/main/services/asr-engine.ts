/**
 * ASR 引擎加载器（sherpa-onnx 原生 addon，随包分发）。
 *
 * 分发纪律（PLAN-voice-input §3.2 / P4）：引擎是 extraResources，绝不进 asar，
 * 也绝不进 `dependencies`（electron-builder 会照单全收）。每个安装包只背本
 * 平台本架构一份（resources/asr-engine/<platform>-<arch>/），模型才是动态件。
 *
 * 失败可解释（P1）：加载前先过平台门（目录名 = process.platform + process.arch）
 * 与文件门，加载失败把 dlopen 的裸错误包进可读文案——绝不把
 * "libonnxruntime.dylib not found" 这类机器话直接丢给上层。
 *
 * mac 的 dylib 解析依赖 addon 自带的 LC_RPATH=@loader_path（官方包已烘焙，
 * M0-4 实测独立目录免 DYLD_* 可载）；win 靠 process.dlopen 的
 * LOAD_WITH_ALTERED_SEARCH_PATH（同目录 dll 可解析）；linux 由 prepare 脚本
 * patchelf --set-rpath '$ORIGIN' 烘焙。
 *
 * linux 还多一件：随包的私有 C++ 运行库 `libpmcxx.so.6`（方案 ①，2026-11-23）。
 * 引擎对象的 DT_NEEDED 已被 prepare 改到这个私有 SONAME —— 因为 glibc 按
 * SONAME 去重，同名的 libstdc++.so.6 副本永远不会被打开。加载器只负责确认它
 * 在不在（缺了就是装了一半的包）。
 */

import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizePathInput } from '../../shared/path-input'

export interface AsrEngineDir {
  dir: string
  /** 引擎来源：打包资源 / dev 依赖 / env 显式指定 */
  source: 'env' | 'resources' | 'dev'
  /** manifest.json（prepare-asr-engine.js 生成）的版本号；dev 回落 = npm 包版本或 unknown */
  version: string
  /** 引擎目录是否带 manifest.json（= prepare 脚本产出；sha 门据此决定跑不跑） */
  hasManifest: boolean
}

/** 每个平台的必备文件（与 prepare-asr-engine.js 的拷贝清单同源，见 PLAN §3.2） */
const REQUIRED_FILES: Record<string, string[]> = {
  darwin: ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib'],
  win32: ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll'],
  linux: ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so'],
}

/**
 * 只有 prepare 产出的目录才带的附加件（linux 的私有 C++ 运行库）。
 *
 * 它**不能**写进 REQUIRED_FILES：dev 回落指向 node_modules 里厂商的平台包，
 * 那份只有「要系统 libstdc++」的 NEEDED，没有这个私有副本 —— 塞进必备清单
 * 会让 Linux dev 态永远报「引擎不完整」。
 *
 * 判据用 manifest.json（prepare 输出的标记，与 sha 门同一个信号）：有它就该有
 * 私有运行库，缺了是装了一半的包，早报比 dlopen 的 version not found 好读。
 */
const PRIVATE_RUNTIME: Record<string, string[]> = {
  linux: ['libpmcxx.so.6'],
}

/** 导出给测试：平台与 manifest 是两个可独立验证的输入，不该为了可测性伪造 process.platform */
export function privateRuntimeFiles(dir: string, platform = process.platform): string[] {
  if (!existsSync(join(dir, 'manifest.json'))) return []
  return PRIVATE_RUNTIME[platform] ?? []
}

export function asrPlatformArch(): string {
  return `${process.platform}-${process.arch}`
}

/**
 * npm 平台包的名字段：厂商在 Windows 上用 `win`（sherpa-onnx-win-x64），
 * 而目录名与 resources 布局沿用 process.platform 的 `win32`（打包 filter
 * 的 `win32-${arch}/**` 依赖它）。dev 回落找包与错误文案都用这一个拼写。
 */
export function asrPackageArch(): string {
  return `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`
}

function requiredFiles(platform = process.platform): string[] {
  return REQUIRED_FILES[platform] ?? REQUIRED_FILES.linux
}

/** dev 态的回落：node_modules 里的同名 devDep（out/main 向上走到仓库根） */
function devCandidates(): string[] {
  const out: string[] = []
  let dir = __dirname
  for (let i = 0; i < 6; i++) {
    out.push(join(dir, 'node_modules', `sherpa-onnx-${asrPackageArch()}`))
    dir = join(dir, '..')
  }
  return out
}

function hasAllFiles(dir: string, files: string[]): boolean {
  return files.every((f) => existsSync(join(dir, f)))
}

function readManifestVersion(dir: string): string | null {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return null
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : null
  } catch {
    return null
  }
}

/**
 * 定位随包引擎目录。三级回落（照抄 resolveOrtWebDir 的纪律）：
 *   1. PULSEMIND_ASR_ENGINE env —— 直接指向平台目录（dev/探针/冒烟）
 *   2. process.resourcesPath/asr-engine/<platform>-<arch> —— 打包态
 *   3. node_modules/sherpa-onnx-<pkg-platform>-<arch> —— dev 态（win32 → win）
 *
 * 每级候选都必须同时满足：目录存在 + 必备文件齐全。找不到时错误里列出
 * 「有哪些平台目录在场」——装错平台/架构的用户能直接看到差别。
 */
export function resolveAsrEngineDir(): AsrEngineDir {
  const want = asrPlatformArch()
  const files = requiredFiles()

  const candidates: Array<{ dir: string; source: AsrEngineDir['source'] }> = []
  const override = process.env.PULSEMIND_ASR_ENGINE
  // env 只做拼写归一（file: URI 剥壳）——不引 guard.ts 的重链（audit-store →
  // 整个存储层），冒烟的现场 bundle 也要能独立打包。
  if (override) candidates.push({ dir: normalizePathInput(override), source: 'env' })
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push({ dir: join(resourcesPath, 'asr-engine', want), source: 'resources' })
  for (const dir of devCandidates()) candidates.push({ dir, source: 'dev' })

  for (const c of candidates) {
    if (hasAllFiles(c.dir, files) && hasAllFiles(c.dir, privateRuntimeFiles(c.dir))) {
      return {
        dir: c.dir,
        source: c.source,
        version: readManifestVersion(c.dir) ?? readDevPackageVersion(c.dir) ?? 'unknown',
        // sha 门不在 resolve 里跑（每次校验 34MB 太贵）——只在转写前置
        // （asr-recognizer 的 prepareEngine）对 hasManifest 的目录调一次。
        hasManifest: existsSync(join(c.dir, 'manifest.json')),
      }
    }
  }

  // 全部落空 —— 区分「完全没有」与「有但平台不对」，给可读文案
  const scannedRoots = [...(resourcesPath ? [join(resourcesPath, 'asr-engine')] : []), ...devCandidates().map((d) => join(d, '..'))]
  const present = new Set<string>()
  for (const root of scannedRoots) {
    try {
      // 只列目录名，不存在时 readdir 直接跳过
      for (const entry of readdirSync(root)) {
        if (/^(darwin|win32|linux)-(x64|arm64|ia32)$/.test(entry)) present.add(entry)
      }
    } catch {
      /* root absent */
    }
  }
  const got = present.size > 0 ? `（在场：${[...present].join(', ')}）` : ''
  const priv = PRIVATE_RUNTIME[process.platform] ?? []
  // 私有运行库不并进「期望文件」：dev 回落本来就该没有它（厂商包只写系统
  // libstdc++ 的 NEEDED），并列会让 Linux 开发机以为自己缺件
  const privNote = priv.length > 0 ? `；打包态还须带 ${priv.join(' + ')}（私有 C++ 运行库）` : ''
  throw new Error(
    `语音引擎未安装或不完整：本机需要 ${want} 的 sherpa-onnx 引擎${got}。` +
      `期望文件：${files.join(' + ')}${privNote}。安装包损坏请重新安装；开发态请安装 devDep sherpa-onnx-${asrPackageArch()}。`,
  )
}

function readDevPackageVersion(dir: string): string | null {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * 流式 sha256（1MB 块）。引擎包 34MB 级，整文件 readFileSync 会同步占满主进程
 * 事件循环数秒（review 20261122 B3）；流在块间天然让出，同 model-manager 纪律。
 */
async function sha256FileStreamed(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 })
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * 引擎 sha 门：对 manifest.json.files 逐文件校验（prepare 脚本产出的清单）。
 * 异步 + 流式：调用方是转写前置路径（asr-recognizer 的 prepareEngine），
 * 绝不能再让一次状态查询在主进程上同步算完 34MB。
 */
export async function verifyEngineSha(dir: string): Promise<{ ok: boolean; bad: string[] }> {
  const manifestPath = join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return { ok: true, bad: [] }
  let files: Record<string, string> = {}
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files?: Record<string, string> }
    files = parsed.files ?? {}
  } catch {
    return { ok: false, bad: ['manifest.json (unreadable)'] }
  }
  const bad: string[] = []
  for (const [name, expected] of Object.entries(files)) {
    const p = join(dir, name)
    if (!existsSync(p)) {
      bad.push(`${name} (missing)`)
      continue
    }
    const actual = await sha256FileStreamed(p)
    if (actual !== expected) bad.push(`${name} (sha256 mismatch, expected ${expected.slice(0, 12)}… got ${actual.slice(0, 12)}…)`)
  }
  return { ok: bad.length === 0, bad }
}

/**
 * 加载 addon 本体。dlopen 错误包成可读文案（P1：绝不裸抛）。
 * 平台门在 resolveAsrEngineDir 已过，这里只负责 require 与错误翻译。
 * requireFn 是测试缝（真 dlopen 由 probe-asr-m0 / smoke-packed-asr 验证）。
 */
export function loadAsrAddon(dir: string, requireFn: NodeRequire = require): unknown {
  try {
    // 直接 require .node 文件本体，绕过 node_modules 解析（打包态无 node_modules）
    const nodePath = join(dir, 'sherpa-onnx.node')
    const addon = requireFn(nodePath)
    if (!addon || typeof addon.createOfflineRecognizer !== 'function') {
      throw new Error('addon loaded but createOfflineRecognizer missing — 版本不配对，请重新安装应用')
    }
    return addon
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('createOfflineRecognizer missing')) throw e
    throw new Error(
      `语音引擎加载失败（${asrPlatformArch()}）：${msg}。` +
        `常见原因：安装包不完整、杀毒软件拦截了 sherpa-onnx.node，或引擎与系统库不兼容（重装应用或反馈日志）。`,
    )
  }
}
