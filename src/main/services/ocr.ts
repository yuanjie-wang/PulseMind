/**
 * OCR 服务（PP-OCRv4 / onnxruntime-web WASM）。
 *
 * 三个约束决定了这里的写法：
 *  1. 内存：RSS 增量实测短图 +126MB、A4 300dpi +226MB。所以 session 懒加载，
 *     空闲 5 分钟释放；同时只允许一个任务在跑（无闸时两页并发直接翻倍）。
 *  2. 启动：ORT + 15.4MB 模型不该在没人 OCR 的启动里付钱，因此 ORT 用
 *     require 懒加载（CJS 才能落到 asar.unpacked，见文件内注释）。
 *  3. 路径：WASM 版要两样真实文件——模型 .onnx 与 ort-wasm-*.wasm 引擎，
 *     都落在 extraResources → process.resourcesPath，不能进 asar。
 *  4. 为什么不用 onnxruntime-node：它的 Windows 二进制把 DirectML EP 静态编进
 *     onnxruntime.dll，onnxruntime_binding.node 在 dlopen 阶段就要能加载
 *     DirectML.dll 并让它的 DllMain 成功。Windows 10 1809(17763) 等系统上报
 *     1114（DLL init failed），**换 executionProviders 无用**——那是装载期错误，
 *     早于任何 Session 存在（实测：1.20.1 的 DirectML.dll 同样失败）。WASM 版
 *     没有任何原生依赖，代价是 A4 约 1.0~1.3s（native 实测 0.5s）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, sep } from 'node:path'
import {
  computeSegments,
  cropRgb,
  ctcDecode,
  dbPostProcess,
  dedupeJoin,
  filterNoiseLines,
  resizeBilinear,
  toTensorData
} from './ocr-core'

/** 只声明用到的部分，不依赖 onnxruntime 的类型（避免 tsc 被可选依赖绊住） */
interface SessionLike {
  run (feeds: Record<string, unknown>): Promise<
    Record<string, { data: Float32Array; dims: readonly number[] }>
  >
  outputNames: readonly string[]
  release?: () => void | Promise<void>
}

interface Sessions {
  det: SessionLike
  rec: SessionLike
  cls: SessionLike
  chars: string[]
}

interface OrtModule {
  InferenceSession: {
    create (
      model: Uint8Array,
      options?: { executionProviders?: string[] }
    ): Promise<SessionLike>
  }
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => unknown
  env: {
    wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean }
  }
}

export interface OcrLine {
  text: string
  score: number
}

export interface OcrResult {
  text: string
  lines: OcrLine[]
  /**
   * 被判为界面噪声而丢弃的行（见 filterNoiseLines）。
   * 保留内容而非只留计数：误杀只能靠人看被丢的东西才能发现。
   */
  dropped: OcrLine[]
  width: number
  height: number
  ms: number
}

const DET_LIMIT = 960
const REC_H = 48
/**
 * rec 输入宽度上限。实测 320 会把 2240px 的合同行压 8 倍、准字率从 93.67% 砸到
 * 50.35%；放开到 2000（整行一次过）最优。超长行仍按 computeSegments 切段兜底。
 */
const REC_MAX_W = 2000
const IDLE_RELEASE_MS = 5 * 60_000
/** 超过这个尺寸先降采样，避免超大扫描件把 sharp 的解码内存打爆 */
const MAX_DECODE_SIDE = 4000

let sessions: Sessions | null = null
let loading: Promise<Sessions> | null = null
let idleTimer: NodeJS.Timeout | null = null
let queue: Promise<unknown> = Promise.resolve()

/** 模型目录：打包态在 resourcesPath 下，开发态在仓库 resources/ 下 */
export function resolveModelsDir (): string {
  const candidates: string[] = []
  const override = process.env.PULSEMIND_OCR_MODELS
  if (override) candidates.push(override)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'ocr-models'))
  // __dirname 在 bundle 后是 out/main，向上两级回到仓库根
  candidates.push(join(__dirname, '..', '..', 'resources', 'ocr-models'))

  for (const dir of candidates) {
    if (existsSync(join(dir, 'det.onnx')) && existsSync(join(dir, 'rec.onnx'))) return dir
  }
  return candidates[candidates.length - 1]
}

export function isOcrSupported (): boolean {
  const dir = resolveModelsDir()
  return ['det.onnx', 'rec.onnx', 'cls.onnx', 'keys.txt'].every(f => existsSync(join(dir, f)))
}

function touchIdleTimer (): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    void disposeOcr()
  }, IDLE_RELEASE_MS)
  // 空闲释放不该吊住进程退出
  idleTimer.unref?.()
}

/**
 * 定位 onnxruntime-web 的 dist 目录（ort.node.min.js + ort-wasm-simd-threaded.wasm
 * 必须同目录）。打包态在 Resources/ort-web（extraResources，不能进 asar：Emscripten
 * 要真实文件）；开发态在 node_modules。__dirname 在 bundle 后是 out/main（主进程）
 * 或 out/main/storage/extractors（extract-worker），所以逐级向上找。
 */
function resolveOrtWebDir (): string {
  const candidates: string[] = []
  const override = process.env.PULSEMIND_ORT_WEB
  if (override) candidates.push(override)
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  if (resourcesPath) candidates.push(join(resourcesPath, 'ort-web'))
  let dir = __dirname
  for (let i = 0; i < 5; i++) {
    candidates.push(join(dir, 'node_modules', 'onnxruntime-web', 'dist'))
    dir = join(dir, '..')
  }
  for (const d of candidates) {
    if (existsSync(join(d, 'ort.node.min.js'))) return d
  }
  throw new Error(
    `onnxruntime-web not found — looked for ort.node.min.js in: ${candidates.join(' | ')}`
  )
}

let ortModule: OrtModule | null = null

/**
 * 懒加载 WASM 版 ORT（CJS require：Electron 打补丁后能落到 asar.unpacked，
 * ESM 动态 import 不行 —— 与本项目其他主进程依赖一致）。
 * 用 ort.node.min.js（package.json 的 node 入口）而非 ort.min.js：多线程走
 * worker_threads 而不是 Web Worker。numThreads 实测 1→4 提速约 2.6 倍。
 */
function loadOrtWeb (): OrtModule {
  if (ortModule) return ortModule
  const dir = resolveOrtWebDir()
  const ort = require(join(dir, 'ort.node.min.js')) as OrtModule
  ort.env.wasm.wasmPaths = dir + sep
  ort.env.wasm.numThreads = Math.max(1, Math.min(4, cpus().length))
  // proxy:true 会把推理塞进 worker 线程并复制张量，主进程反而不阻塞但多一层拷贝。
  // 这里的并发闸已经保证单任务，保持直接调用。
  ort.env.wasm.proxy = false
  ortModule = ort
  return ort
}

/** WASM 下模型必须以字节喂入：Emscripten 的虚拟 FS 看不到宿主路径 */
function createSession (ort: OrtModule, file: string): Promise<SessionLike> {
  return ort.InferenceSession.create(readFileSync(file), { executionProviders: ['wasm'] })
}

async function loadSessions (): Promise<Sessions> {
  const dir = resolveModelsDir()
  if (!isOcrSupported()) {
    throw new Error(
      `OCR models missing in "${dir}". Expected det.onnx / rec.onnx / cls.onnx / keys.txt.`
    )
  }
  const ort = loadOrtWeb()
  const [det, rec, cls] = await Promise.all([
    createSession(ort, join(dir, 'det.onnx')),
    createSession(ort, join(dir, 'rec.onnx')),
    createSession(ort, join(dir, 'cls.onnx'))
  ])
  // 末尾空行会让类别索引整体错位：0=blank, 1..N=字典, N+1=space
  const chars = readFileSync(join(dir, 'keys.txt'), 'utf8')
    .split('\n')
    .map(s => s.replace(/\r$/, ''))
    .filter(s => s.length > 0)
  return { det, rec, cls, chars }
}

async function getSessions (): Promise<Sessions> {
  if (sessions) return sessions
  if (!loading) {
    loading = loadSessions().then(
      s => {
        sessions = s
        loading = null
        return s
      },
      err => {
        // 失败不缓存，下次调用可以重试（比如模型刚拷进来）
        loading = null
        throw err
      }
    )
  }
  return loading
}

/** 释放 session 与其原生内存；下次调用会重新懒加载 */
export async function disposeOcr (): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  const current = sessions
  sessions = null
  loading = null
  if (!current) return
  for (const s of [current.det, current.rec, current.cls]) {
    try {
      // 有则用，没有就交给 GC —— 不假设某个具体版本提供了 release()
      await s.release?.()
    } catch {
      /* 释放失败不影响后续重建 */
    }
  }
}

/** 串行闸：OCR 是内存大户，并发没有收益 */
function enqueue<T> (fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

function rotate180 (rgb: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(rgb.length)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + (w - 1 - x)) * 3
      const d = (y * w + x) * 3
      out[d] = rgb[s]
      out[d + 1] = rgb[s + 1]
      out[d + 2] = rgb[s + 2]
    }
  }
  return out
}

/**
 * 识别一张图片（任意 sharp 能解码的格式）。
 * 抛错只在模型不可用或图片无法解码时发生；识别不出文字返回空 text。
 */
export async function recognizeImage (filePath: string): Promise<OcrResult> {
  return enqueue(async () => {
    const started = Date.now()
    const s = await getSessions()
    touchIdleTimer()

    const ort = loadOrtWeb()
    // 运行时：require('sharp') 就是构造函数本身（实测 .default 是 undefined）。
    // 类型：sharp 的声明走 ESM 形态（命名空间不可调用，只有 default 可调用），
    // 两边形态不一致，只能断言。⚠️ 不要"顺着类型"改成取 .default —— 运行时会
    // 抛出 "sharp is not a function"。
    const sharp = require('sharp') as unknown as typeof import('sharp').default
    const { data: rgb, info } = await sharp(filePath)
      .removeAlpha()
      .resize({
        width: MAX_DECODE_SIDE,
        height: MAX_DECODE_SIDE,
        fit: 'inside',
        withoutEnlargement: true
      })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const W = info.width
    const H = info.height

    // --- det ---
    const scale = Math.min(1, DET_LIMIT / Math.max(W, H))
    const dw = Math.max(32, Math.round((W * scale) / 32) * 32)
    const dh = Math.max(32, Math.round((H * scale) / 32) * 32)
    const detImg = resizeBilinear(rgb, W, H, dw, dh)
    const detOut = await s.det.run({
      x: new ort.Tensor('float32', toTensorData(detImg, dw, dh, 'det'), [1, 3, dh, dw])
    })
    const prob = detOut[s.det.outputNames[0]].data
    const rx = dw / W
    const ry = dh / H
    const boxes = dbPostProcess(prob, dw, dh)
      .map(b => ({
        x0: Math.max(0, Math.floor(b.x0 / rx)),
        y0: Math.max(0, Math.floor(b.y0 / ry)),
        x1: Math.min(W, Math.ceil(b.x1 / rx)),
        y1: Math.min(H, Math.ceil(b.y1 / ry))
      }))
      .filter(b => b.x1 - b.x0 >= 4 && b.y1 - b.y0 >= 4)
      .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0)

    const lines: OcrLine[] = []

    for (const box of boxes) {
      const bw = box.x1 - box.x0
      const bh = box.y1 - box.y0
      let crop = cropRgb(rgb, W, H, box.x0, box.y0, box.x1, box.y1)

      // --- cls：判断是否 180° 倒置 ---
      const clsImg = resizeBilinear(crop, bw, bh, 192, REC_H)
      const clsOut = await s.cls.run({
        x: new ort.Tensor('float32', toTensorData(clsImg, 192, REC_H, 'det'), [1, 3, REC_H, 192])
      })
      const cdata = clsOut[s.cls.outputNames[0]].data
      if (cdata[1] > cdata[0] && cdata[1] > 0.9) crop = rotate180(crop, bw, bh)

      // --- rec：超宽行切段，接缝去重 ---
      const segs = computeSegments(bw, bh, REC_H, REC_MAX_W)
      let text = ''
      let scoreSum = 0
      let picked = 0
      for (const seg of segs) {
        const sw = seg.ex - seg.sx
        const recW = Math.min(REC_MAX_W, Math.max(16, Math.round((REC_H * sw) / bh)))
        const segImg =
          segs.length === 1 ? crop : cropRgb(crop, bw, bh, seg.sx, 0, seg.ex, bh)
        const recImg = resizeBilinear(segImg, sw, bh, recW, REC_H)
        const recOut = await s.rec.run({
          x: new ort.Tensor('float32', toTensorData(recImg, recW, REC_H, 'rec'), [1, 3, REC_H, recW])
        })
        const ro = recOut[s.rec.outputNames[0]]
        const classes = ro.dims[2]
        const decoded = ctcDecode(ro.data, ro.dims[1], classes, s.chars)
        text += dedupeJoin(text, decoded.text)
        scoreSum += decoded.score
        picked++
      }
      if (!text.trim()) continue
      lines.push({ text, score: picked ? scoreSum / picked : 0 })
    }

    touchIdleTimer()
    // 界面碎片（X / <返回 / 它 / 小 / 21）会被 det 当成文字行，分数低、长度短。
    // 不过滤就会原样喂给 LLM，在医疗/合同这类场景里可能被当成正文。
    const { kept, dropped } = filterNoiseLines(lines)
    return {
      text: kept.map(l => l.text).join('\n'),
      lines: kept,
      dropped,
      width: W,
      height: H,
      ms: Date.now() - started
    }
  })
}
