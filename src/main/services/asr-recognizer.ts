/**
 * ASR 转写编排器（PLAN-voice-input §3.4）。
 *
 * 职责边界：加载器（asr-engine.ts）定位引擎，worker（asr-worker.ts）做推理，
 * 这里只管生命周期——懒加载、串行、空闲释放、失败不缓存。纪律照抄 ocr.ts：
 *
 *  - worker_threads 承载推理（SenseVoice 全模型驻留 + 持续 CPU），主进程事件
 *    循环不碰模型；
 *  - 与 OCR 共用 inference-queue 串行闸（两个内存大户绝不并发）；
 *  - 首次转写才建 worker，空闲 5 分钟 terminate（IDLE_RELEASE_MS 同款）；
 *  - 加载失败不缓存——下次调用重试（模型可能刚导入）。
 *
 * 音频契约：渲染端完成「下混单声道 + 重采样 16k」，这里收到的是 16k 单声道
 * Float32 PCM；sampleRate 不符直接给可读错误（防渲染端回归静默出乱码）。
 * 模型目录由调用方（asr.handler → model-manager）给出，本模块不管安装语义。
 */

import { join } from 'node:path'
import { cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { enqueueInference } from './inference-queue'
import { loadAsrAddon, resolveAsrEngineDir, verifyEngineSha, type AsrEngineDir } from './asr-engine'

const IDLE_RELEASE_MS = 5 * 60_000
/** init 超时：int8 模型建 recognizer 实测秒级，60s 给慢机留足余量 */
const INIT_TIMEOUT_MS = 60_000
/** 单次转写超时：5s 音频热路径 ≤10s（M0-5 预算），120s 兜底防 worker 挂死 */
const TRANSCRIBE_TIMEOUT_MS = 120_000

export interface AsrTranscribeOptions {
  /** SenseVoice language hint：auto（默认）/zh/en/ja/ko/yue */
  language?: string
  /** ITN 数字规整，默认开 */
  useItn?: boolean
}

export interface AsrTranscribeResult {
  text: string
  /** 主进程侧全程耗时（含 worker 唤醒），诊断用 */
  ms: number
}

export interface AsrEngineStatus {
  engine: AsrEngineDir | null
  /** 引擎定位/校验失败时的可读文案（engine 为 null 时必有值） */
  engineError: string | null
  platform: string
  numThreads: number
  /** worker 是否活着（懒加载后为 true，空闲释放后为 false） */
  workerAlive: boolean
}

type PendingResolver = {
  resolve: (r: string) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

let engine: AsrEngineDir | null = null
/** 定位结果（文件齐、版本已知）；与 engine 的区别是**没有 dlopen** */
let located: AsrEngineDir | null = null
/** addon 是否已在本进程 dlopen 成功（转写前置才置真） */
let enginePrepared = false
let engineError: string | null = null
let worker: Worker | null = null
/** 当前 worker 的身份：换模型目录或语言都要重建 */
let workerKey: string | null = null
let initPromise: Promise<Worker> | null = null
let idleTimer: NodeJS.Timeout | null = null
let pending = new Map<number, PendingResolver>()
let nextId = 1

function workerPath(): string {
  // bundle 后 __dirname = out/main，worker 与主 bundle 同目录（build.js 单独 entry）
  return join(__dirname, 'asr-worker.js')
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
 * 转写前置：定位 → sha 门（异步流式，让出事件循环）→ dlopen。
 * **全仓只有这条路径加载 addon**。
 * 失败不置 enginePrepared，下次转写自动重试（模型/引擎可能刚修好）。
 */
async function prepareEngine(): Promise<AsrEngineDir> {
  const dir = locateEngine()
  if (engine && enginePrepared) return engine
  if (dir.hasManifest) {
    const sha = await verifyEngineSha(dir.dir)
    if (!sha.ok) {
      const msg = `语音引擎文件校验失败（安装包损坏）：${sha.bad.join('; ')}。请重新安装应用。`
      engineError = msg
      throw new Error(msg)
    }
  }
  // addon 在主进程 require 一次：失败即「引擎不可用」的可读错误
  loadAsrAddon(dir.dir)
  engine = dir
  enginePrepared = true
  engineError = null
  return engine
}

function rejectAllPending(message: string): void {
  const old = pending
  pending = new Map()
  for (const p of old.values()) {
    clearTimeout(p.timer)
    p.reject(new Error(message))
  }
}

async function spawnWorker(modelDir: string, language: string, useItn: boolean): Promise<Worker> {
  // 引擎定位 + sha 门 + dlopen 都在这里完成（失败给可读错误，不进 worker）
  const eng = await prepareEngine()
  const numThreads = Math.max(1, Math.min(4, cpus().length))
  return new Promise<Worker>((resolve, reject) => {
    let settled = false
    const w = new Worker(workerPath())
    const initTimer = setTimeout(() => {
      if (settled) return
      settled = true
      void w.terminate()
      reject(new Error('语音引擎初始化超时（60s）——模型过大或磁盘过慢，请重试'))
    }, INIT_TIMEOUT_MS)

    const onMessage = (msg: unknown): void => {
      const m = msg as { type: string; id?: number; text?: string; message?: string }
      if (m.type === 'ready') {
        if (!settled) {
          settled = true
          clearTimeout(initTimer)
          resolve(w)
        }
        return
      }
      if (m.type === 'init-error') {
        if (!settled) {
          settled = true
          clearTimeout(initTimer)
          void w.terminate()
          reject(new Error(m.message || '语音引擎初始化失败'))
        }
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
    w.on('message', onMessage)
    w.on('error', (err) => {
      rejectAllPending(`语音引擎崩溃：${err.message}`)
      void disposeAsr()
    })
    w.on('exit', (code) => {
      // 主动 dispose 的退出码 0 也会走到这里；pending 已被 dispose 清空
      if (code !== 0) rejectAllPending(`语音引擎异常退出（code ${code}）`)
      if (worker === w) {
        worker = null
        workerKey = null
      }
    })
    w.postMessage({
      type: 'init',
      engineDir: eng.dir,
      modelDir,
      numThreads,
      language,
      useInverseTextNormalization: useItn ? 1 : 0,
    })
  })
}

async function ensureWorker(modelDir: string, language: string, useItn: boolean): Promise<Worker> {
  const key = `${modelDir}|${language}|${useItn ? 1 : 0}`
  if (worker && workerKey === key) return worker
  // 身份变了：旧 worker 整个换掉（模型不同必须重建 recognizer）
  if (worker && workerKey !== key) {
    const old = worker
    worker = null
    workerKey = null
    await old.terminate().catch(() => undefined)
  }
  if (!initPromise) {
    initPromise = spawnWorker(modelDir, language, useItn).then(
      (w) => {
        worker = w
        workerKey = key
        initPromise = null
        touchIdleTimer()
        return w
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

/** 释放 worker 与空闲计时；下次调用重新懒加载 */
export async function disposeAsr(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  rejectAllPending('语音引擎已释放，请重试')
  const current = worker
  worker = null
  workerKey = null
  initPromise = null
  if (current) await current.terminate().catch(() => undefined)
}

export function getAsrEngineStatus(workerAlive = !!worker): AsrEngineStatus {
  // 状态查询只「定位」，**绝不 dlopen、绝不算 sha**（review 20261122 B3）。
  // 此前这里调 resolveEngine，而它内含 loadAsrAddon —— 设置页/引导卡/每个
  // InputArea 挂载都会问一次状态，等于为一次问询把 34MB 引擎 + ORT 常驻进
  // 主进程（这份句柄还永不用于推理，推理在 worker 里另 require 一份）。
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
 * 转写一段 16k 单声道 PCM。串行闸与 OCR 共享；worker 按需懒加载。
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
    const w = await ensureWorker(modelDir, opts.language ?? 'auto', opts.useItn !== false)
    touchIdleTimer()
    const id = nextId++
    // structured clone 已在 IPC 边界拷贝过，这里 transfer 走零拷贝
    const transferList = [samples.buffer as ArrayBuffer]
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('转写超时（120s）——引擎可能已挂死，重试一次或重启应用'))
      }, TRANSCRIBE_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      w.postMessage({ type: 'transcribe', id, samples, sampleRate }, transferList)
    })
    return { text, ms: Date.now() - started }
  })
}
