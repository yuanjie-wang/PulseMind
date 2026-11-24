/**
 * ASR 转写编排器（PLAN-voice-input §3.4）。
 *
 * 职责边界：加载器（asr-engine.ts）定位/校验引擎，子进程宿主（asr-host.ts）
 * 管进程，worker（asr-worker.ts）做推理，这里只管生命周期——懒加载、串行、
 * 空闲释放、失败不缓存。纪律照抄 ocr.ts：
 *
 *  - 推理跑在**独立 OS 进程**里（Electron utilityProcess；纯 Node 回落线程，
 *    见 asr-host.ts）。主进程既不 dlopen addon 也不碰模型：原生层 abort /
 *    SIGSEGV / OOM-kill 只会带走子进程，应用继续活着且留下退出码与 stderr
 *    （2026-11-24 Linux「点停止即闪退、零日志」事故的修法）；
 *  - 与 OCR 共用 inference-queue 串行闸（两个内存大户绝不并发）；
 *  - 首次转写才起子进程，空闲 5 分钟释放（IDLE_RELEASE_MS 同款）；
 *  - 加载失败不缓存——下次调用重试（模型可能刚导入）。
 *
 * 音频契约：渲染端完成「下混单声道 + 重采样 16k」，这里收到的是 16k 单声道
 * Float32 PCM；sampleRate 不符直接给可读错误（防渲染端回归静默出乱码）。
 * 模型目录由调用方（asr.handler → model-manager）给出，本模块不管安装语义。
 */

import { join } from 'node:path'
import { cpus } from 'node:os'
import { enqueueInference } from './inference-queue'
import { resolveAsrEngineDir, verifyEngineSha, type AsrEngineDir } from './asr-engine'
import { spawnAsrHost, type AsrExitInfo, type AsrHost } from './asr-host'

const IDLE_RELEASE_MS = 5 * 60_000
/** init 超时：int8 模型建 recognizer 实测秒级，60s 给慢机留足余量 */
const INIT_TIMEOUT_MS = 60_000
/** 单次转写超时：5s 音频热路径 ≤10s（M0-5 预算），120s 兜底防子进程挂死 */
const TRANSCRIBE_TIMEOUT_MS = 120_000

export interface AsrTranscribeOptions {
  /** SenseVoice language hint：auto（默认）/zh/en/ja/ko/yue */
  language?: string
  /** ITN 数字规整，默认开 */
  useItn?: boolean
}

export interface AsrTranscribeResult {
  text: string
  /** 主进程侧全程耗时（含子进程唤醒与模型加载），诊断用 */
  ms: number
}

export interface AsrEngineStatus {
  engine: AsrEngineDir | null
  /** 引擎定位/校验失败时的可读文案（engine 为 null 时必有值） */
  engineError: string | null
  platform: string
  numThreads: number
  /** 推理子进程是否活着（懒加载后为 true，空闲释放/崩溃后为 false） */
  workerAlive: boolean
}

type PendingResolver = {
  resolve: (r: string) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

let located: AsrEngineDir | null = null
/** 引擎 sha 门是否已过（文件校验；dlopen 不在这里——它发生在子进程里） */
let engineVerified = false
let engineError: string | null = null
let host: AsrHost | null = null
/** 当前子进程的身份：换模型目录或语言都要重建 */
let hostKey: string | null = null
let initPromise: Promise<AsrHost> | null = null
let idleTimer: NodeJS.Timeout | null = null
let pending = new Map<number, PendingResolver>()
let nextId = 1

function workerPath(): string {
  // bundle 后 __dirname = out/main，子进程入口与主 bundle 同目录（build.js 单独 entry）。
  // env 缝只给测试/探针（与 PULSEMIND_ASR_ENGINE 同款），真机永远走同目录。
  return process.env.PULSEMIND_ASR_WORKER || join(__dirname, 'asr-worker.js')
}

function touchIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void disposeAsr()
  }, IDLE_RELEASE_MS)
  // 空闲释放不该吊住进程退出
  idleTimer.unref?.()
}

/**
 * 只「定位」引擎（文件齐不齐、版本多少），**不 dlopen、不算 sha**。
 * 状态查询走这里（review 20261122 B3）：设置页、引导卡、每个 InputArea 挂载
 * 都会问一次状态，让一次问询付出 34MB addon 常驻 + 34MB 同步 sha 是不可接受
 * 的（ocr.ts 同纪律：没人真要转写时不付这份钱）。
 */
function locateEngine(): AsrEngineDir {
  if (located) return located
  if (engineError) throw new Error(engineError)
  try {
    located = resolveAsrEngineDir()
    return located
  } catch (e) {
    engineError = e instanceof Error ? e.message : String(e)
    throw e instanceof Error ? e : new Error(engineError)
  }
}

/**
 * 转写前置：定位 → sha 门（异步流式，让出事件循环）。
 *
 * **不 dlopen**：addon 由子进程加载。主进程 dlopen 意味着引擎的任何原生崩溃
 * 都能带走整个应用，而这正是 2026-11-24 事故的形状（Linux 打包态、点停止触发
 * 首次模型加载、主日志零证据）。失败不置 engineVerified，下次转写自动重试。
 */
async function prepareEngine(): Promise<AsrEngineDir> {
  const dir = locateEngine()
  if (engineVerified) return dir
  if (dir.hasManifest) {
    const sha = await verifyEngineSha(dir.dir)
    if (!sha.ok) {
      const msg = `语音引擎文件校验失败（安装包损坏）：${sha.bad.join('; ')}。请重新安装应用。`
      engineError = msg
      throw new Error(msg)
    }
  }
  engineVerified = true
  engineError = null
  return dir
}

function rejectAllPending(message: string): void {
  const old = pending
  pending = new Map()
  for (const p of old.values()) {
    clearTimeout(p.timer)
    p.reject(new Error(message))
  }
}

function exitLabel(info: AsrExitInfo): string {
  return `code ${info.code ?? '?'}`
}

/** 启动期死亡（引擎加载/模型初始化）——把最后两行 stderr 带上，用户/我们能分辨「坏了什么」 */
function initFailureText(info: AsrExitInfo): string {
  const tail = info.stderrTail.slice(-2).join(' | ')
  const why = info.expected ? '语音引擎已停止' : `语音引擎启动失败：推理子进程退出（${exitLabel(info)}）`
  const detail = tail ? `${why}——${tail}` : why
  return `${detail}。应用本身未受影响，诊断日志：~/.pulsemind/logs/main.log`
}

/** 转写途中死亡：用户看到的是可重试的错误，而不是应用消失 */
function runtimeCrashText(info: AsrExitInfo): string {
  const why = info.expected ? '语音引擎已释放' : `语音引擎进程崩溃（${exitLabel(info)}）`
  return `${why}——应用本身未受影响，请重试；诊断日志：~/.pulsemind/logs/main.log`
}

/**
 * 起推理子进程并等它 ready。
 * 引擎 dlopen 与 228MB 模型加载都在子进程里：它们崩掉时这里 reject（可读提示），
 * 主进程不再连坐。
 */
function spawnAsrWorker(modelDir: string, language: string, useItn: boolean): Promise<AsrHost> {
  return new Promise<AsrHost>((resolve, reject) => {
    let settled = false
    let local: AsrHost | null = null
    let initTimer: NodeJS.Timeout | null = null

    const clearInitTimer = (): void => {
      if (initTimer) {
        clearTimeout(initTimer)
        initTimer = null
      }
    }
    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearInitTimer()
      if (local) void local.terminate()
      reject(err)
    }

    function onMessage(msg: unknown): void {
      const m = msg as { type: string; id?: number; text?: string; message?: string }
      if (m.type === 'ready') {
        if (!settled && local) {
          settled = true
          clearInitTimer()
          resolve(local)
        }
        return
      }
      if (m.type === 'init-error') {
        fail(new Error(`${m.message || '语音引擎初始化失败'}（应用本身未受影响）`))
        return
      }
      if (m.type === 'result' || m.type === 'error') {
        const p = m.id != null ? pending.get(m.id) : undefined
        if (p) {
          pending.delete(m.id!)
          clearTimeout(p.timer)
          if (m.type === 'result') p.resolve(m.text ?? '')
          else p.reject(new Error(m.message || '转写失败'))
        }
      }
    }

    function onExit(info: AsrExitInfo): void {
      if (!settled) {
        fail(new Error(initFailureText(info)))
      } else {
        // 在跑的转写全部失败；下次调用自会重建子进程
        rejectAllPending(runtimeCrashText(info))
      }
      if (local && host === local) {
        host = null
        hostKey = null
      }
    }

    void (async () => {
      let eng: AsrEngineDir
      try {
        eng = await prepareEngine()
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
        return
      }
      const numThreads = Math.max(1, Math.min(4, cpus().length))
      initTimer = setTimeout(() => {
        fail(new Error('语音引擎初始化超时（60s）——模型过大或磁盘过慢，请重试'))
      }, INIT_TIMEOUT_MS)
      try {
        local = await spawnAsrHost({ workerPath: workerPath(), onMessage, onExit })
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
        return
      }
      if (settled) return // 起进程途中已超时/已失败
      try {
        local.postMessage({
          type: 'init',
          engineDir: eng.dir,
          modelDir,
          numThreads,
          language,
          useInverseTextNormalization: useItn ? 1 : 0,
        })
      } catch (e) {
        fail(e instanceof Error ? e : new Error(String(e)))
      }
    })()
  })
}

async function ensureHost(modelDir: string, language: string, useItn: boolean): Promise<AsrHost> {
  const key = `${modelDir}|${language}|${useItn ? 1 : 0}`
  if (host && hostKey === key) return host
  // 身份变了：旧子进程整个换掉（模型不同必须重建 recognizer）
  if (host && hostKey !== key) {
    const old = host
    host = null
    hostKey = null
    await old.terminate().catch(() => undefined)
  }
  if (!initPromise) {
    initPromise = spawnAsrWorker(modelDir, language, useItn).then(
      (h) => {
        host = h
        hostKey = key
        initPromise = null
        touchIdleTimer()
        return h
      },
      (err) => {
        // 失败不缓存：下次调用重试
        initPromise = null
        throw err
      },
    )
  }
  return initPromise
}

/** 释放子进程与空闲计时；下次调用重新懒加载 */
export async function disposeAsr(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  rejectAllPending('语音引擎已释放，请重试')
  const current = host
  host = null
  hostKey = null
  initPromise = null
  if (current) await current.terminate().catch(() => undefined)
}

export function getAsrEngineStatus(workerAlive = !!host): AsrEngineStatus {
  // 状态查询只「定位」，**绝不 dlopen、绝不算 sha**（review 20261122 B3）。
  // 此前这里调 resolveEngine，而它内含 loadAsrAddon —— 设置页/引导卡/每个
  // InputArea 挂载都会问一次状态，等于为一次问询把 34MB 引擎 + ORT 常驻进
  // 主进程。现在引擎根本不进主进程地址空间（推理在独立子进程里）。
  // 定位失败仍要报出来（engineError 由 locateEngine 记下）。
  if (!located && !engineError) {
    try {
      locateEngine()
    } catch {
      /* engineError 已被 locateEngine 记下 */
    }
  }
  return {
    // 展示用：定位到即报（版本/平台/来源都齐），未定位到才为 null
    engine: located,
    engineError,
    platform: `${process.platform}-${process.arch}`,
    numThreads: Math.max(1, Math.min(4, cpus().length)),
    workerAlive,
  }
}

/**
 * 转写一段 16k 单声道 PCM。串行闸与 OCR 共享；子进程按需懒加载。
 * modelDir 由调用方给出（model-manager 的已装模型目录）。
 */
export async function transcribeSamples(
  samples: Float32Array,
  sampleRate: number,
  modelDir: string,
  opts: AsrTranscribeOptions = {},
): Promise<AsrTranscribeResult> {
  if (sampleRate !== 16000) {
    throw new Error(`音频采样率必须是 16000Hz（收到 ${sampleRate}）——重采样在渲染端完成，请勿绕过`)
  }
  if (!samples.length) {
    throw new Error('音频为空（0 个采样点）——没录到声音，请检查麦克风后重试')
  }
  return enqueueInference(async () => {
    const started = Date.now()
    const h = await ensureHost(modelDir, opts.language ?? 'auto', opts.useItn !== false)
    touchIdleTimer()
    const id = nextId++
    // utilityProcess 的 postMessage 不能转移 ArrayBuffer（只支持 MessagePort），
    // 传 transfer list 会直接抛——结构克隆拷贝一份，320KB/5s 可忽略。
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('转写超时（120s）——引擎可能已挂死，重试一次或重启应用'))
      }, TRANSCRIBE_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      h.postMessage({ type: 'transcribe', id, samples, sampleRate })
    })
    return { text, ms: Date.now() - started }
  })
}