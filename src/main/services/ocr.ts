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
import { join } from 'node:path'
import {
  computeSegments,
  cropRgb,
  ctcDecode,
  dbPostProcess,
  dedupeJoin,
  filterNoiseLines,
  readingOrderLines,
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
    // wasmPaths 只读不写（见 loadOrtWeb）；warmUpOcr 把它报给打包冒烟核对
    wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean }
  }
}

export interface OcrBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrCallOptions {
  /**
   * 识别前裁剪，**原图（文件）像素坐标**——与 lines[].box 同一坐标系，所以
   * 可以直接拿整图识别里某行的 box 来裁它。坐标钳制进图界（bbox 取整带来的
   * 贴边越界不必重试），倒置/过小才报错。裁剪不改变 box 的坐标系：结果里
   * 的框仍然是全图坐标（回声 crop 区域供核对）。与 tile 互斥。
   */
  crop?: OcrBox
  /**
   * det 检测输入长边上限（默认 DET_LIMIT=960）。密表小字漏检时调高
   * （≤2000）；耗时与内存随像素面积平方级上涨（960→1920 约 4 倍）。
   */
  detLimit?: number
  /**
   * 分带识别（conv_20261116210413 round4-5：竖长截图整图 det 被压到 0.34x，
   * 36px 的字只剩 12px，同一个字在 12px/36px 下稳定读成两个不同结果——
   * det_limit 上限 2000 也救不了 1320 宽的图）。开启后按横带切分、每带 det
   * 提到 ~1:1；**接受区间按带分区**（每行文字的 y 中心恰属一个带），结果
   * 结构性零重复、无需去重。box 坐标系不变（仍是全图原图像素）。与 crop
   * 互斥。代价：det 次数 = 带数（约 3-4 倍 det 耗时）。
   */
  tile?: boolean
}

export interface OcrLine {
  text: string
  score: number
  /**
   * 检测框，**原图（文件）像素坐标**。det 在缩放图上算框，先映射回解码尺寸、
   * 再乘 decode 比例回到文件原尺寸（crop 时再平移回全图）——调用方拿到的
   * 坐标可直接喂给任何按文件像素工作的工具（裁剪、标注），不用再自己换算。
   */
  box: OcrBox
}

export interface OcrResult {
  text: string
  lines: OcrLine[]
  /**
   * 被判为界面噪声而丢弃的行（见 filterNoiseLines）。
   * 保留内容而非只留计数：误杀只能靠人看被丢的东西才能发现。
   */
  dropped: OcrLine[]
  /** 解码后实际参与识别的尺寸：超过 MAX_DECODE_SIDE 的边先被降采样 */
  width: number
  height: number
  /** 文件原始像素尺寸（EXIF 不旋转，与解码同一 orientation）——lines[].box 的坐标系 */
  originalWidth: number
  originalHeight: number
  /** det 检测实际的工作尺寸（≤detLimit）：「输入被内部缩放」的唯一可见出口 */
  detWidth: number
  detHeight: number
  /** 实际生效的裁剪区域（原图坐标，已钳制进界）——请求带了 crop 时回声 */
  crop?: OcrBox
  /** tile 生效时的分带回声：bands = 实际 det 次数 */
  tile?: { bands: number }
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
/** 慢调用落 logs/main.log 的门槛（正常：A4 300dpi 约 1.4–1.8s、截图 0.5–0.7s） */
const OCR_SLOW_LOG_MS = 8_000

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
 * ORT 的运行时三件套，必须同目录：loadOrtWeb 不给 ORT 任何路径，ORT 按
 * ort.node.min.js 自己的位置相对找另外两件。缺一件不会在这里报错，而是在
 * 建会话时变成一句看不出原因的 "no available backend found"。
 */
export const ORT_WEB_FILES = [
  'ort.node.min.js',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm'
] as const

/**
 * 定位 onnxruntime-web 的 dist 目录（三件套同目录）。打包态在 Resources/ort-web
 * （extraResources，不能进 asar：Emscripten 要真实文件）；开发态在 node_modules。
 * __dirname 在 bundle 后是 out/main（主进程）或 out/main/storage/extractors
 * （extract-worker），所以逐级向上找。
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
    if (ORT_WEB_FILES.every(f => existsSync(join(d, f)))) return d
  }
  throw new Error(
    `onnxruntime-web not found — looked for ${ORT_WEB_FILES.join(' + ')} in: ${candidates.join(' | ')}`
  )
}

let ortModule: OrtModule | null = null

/**
 * 懒加载 WASM 版 ORT（CJS require：Electron 打补丁后能落到 asar.unpacked，
 * ESM 动态 import 不行 —— 与本项目其他主进程依赖一致）。
 * 用 ort.node.min.js（package.json 的 node 入口）而非 ort.min.js：多线程走
 * worker_threads 而不是 Web Worker。numThreads 实测 1→4 提速约 2.6 倍。
 * 注意 ORT 文档写的是「Node.js 只支持单线程 wasm」：多线程是实测可用、超出官方
 * 承诺的配置，打包冒烟按同一线程数在三个平台上建会话，就是为了替它兜底。
 *
 * 不设 env.wasm.wasmPaths，让 ORT 按自己文件的位置找另外两件。装机 Windows 上
 * "no available backend found. ERR: [wasm] … ERR_UNSUPPORTED_ESM_URL_SCHEME …
 * Received protocol 'f:'" 的根因就是给了路径；2026-11-09 实测过四种写法：
 *  - 绝对路径 `dir + sep`：ORT 拿它拼 import() 的参数，Windows 盘符 `F:` 被 ESM
 *    loader 当成 URL scheme；POSIX 的 `/…` 侥幸可用，但路径带 # 一样坏。
 *  - 字面相对路径 './'：.mjs 找得到，.wasm 却按「进程工作目录」去读——装机后工作
 *    目录不可预期，ENOENT，而且这个异常会逃逸成未捕获错误，能直接带崩进程。
 *  - file:// URL：可用，但多一层手工转换，没有必要。
 *  - 不设（本写法）：ORT 在 Node 下执行 import('./ort-wasm-simd-threaded.mjs')，
 *    Node 按 ort.node.min.js 自己的位置解析；.wasm 与 pthread worker 再由 .mjs 的
 *    import.meta.url 派生。全程没有手拼路径，三个平台走同一条路——前提是三件套
 *    同目录（resolveOrtWebDir 保证），且 ort.node.min.js 必须像这样在运行时从该
 *    目录 require，不能被打进 bundle（那样相对位置就成了 out/main）。
 * 另外：ORT 初始化失败会被它自己锁死，同一进程里重试只会得到 "previous call to
 * 'initializeWebAssembly()' failed"，主进程的 ocr 工具要重启应用才能恢复。
 */
function loadOrtWeb (): OrtModule {
  if (ortModule) return ortModule
  const dir = resolveOrtWebDir()
  const ort = require(join(dir, 'ort.node.min.js')) as OrtModule
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

export interface OcrWarmUp {
  /** 实际选中的目录：冒烟据此断言用的是包内资源，而不是某个回落候选 */
  ortWebDir: string
  modelsDir: string
  /** ORT 当前的 wasmPaths（应为 undefined——见 loadOrtWeb）与生效线程数（多线程不可用时 ORT 会把它改回 1） */
  wasmPaths: unknown
  numThreads: number
  outputs: { det: string[]; rec: string[]; cls: string[] }
  /** 字典条数（keys.txt 去空行） */
  chars: number
}

/**
 * 把三个模型的会话建好（之后的懒加载 / 空闲释放照旧）。打包冒烟
 * （scripts/smoke-packed-ocr.js）经它驱动与产品完全相同的 ORT 配置——冒烟若
 * 自己抄一份配置就会「门禁绿、产品崩」：11-09 的 Windows CI 冒烟仍是绿的，装机
 * 却报盘符错误——冒烟自配了 file:// URL + 单线程，产品走的是另一套。
 */
export async function warmUpOcr (): Promise<OcrWarmUp> {
  return enqueue(async () => {
    const s = await getSessions()
    touchIdleTimer()
    const { wasm } = loadOrtWeb().env
    return {
      ortWebDir: resolveOrtWebDir(),
      modelsDir: resolveModelsDir(),
      wasmPaths: wasm.wasmPaths,
      numThreads: wasm.numThreads ?? 1,
      outputs: {
        det: [...s.det.outputNames],
        rec: [...s.rec.outputNames],
        cls: [...s.cls.outputNames]
      },
      chars: s.chars.length
    }
  })
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
export async function recognizeImage (filePath: string, opts: OcrCallOptions = {}): Promise<OcrResult> {
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
    // 原始尺寸：只读图片头，不解码。不加 .rotate()，与下方 raw 解码保持同一
    // orientation——box 坐标系（原图）因此和这两处一致。
    const meta = await sharp(filePath).metadata()
    const origW = meta.width ?? 0
    const origH = meta.height ?? 0

    // crop：原图坐标钳制进界（bbox 取整带来的贴边越界不必重试一轮），四个数
    // 都必须是有限数字——LLM 传来的 JSON，NaN/字符串直接给可读错误。
    let cropRegion: OcrBox | null = null
    let pipe = sharp(filePath).removeAlpha()
    if (opts.crop) {
      if (opts.tile === true) throw new Error('ocr 的 tile 与 crop 二选一——分带覆盖全图，裁剪请单独调用')
      const c = opts.crop
      const nums = [c.x0, c.y0, c.x1, c.y1]
      if (!nums.every(n => typeof n === 'number' && Number.isFinite(n))) {
        throw new Error(`ocr crop 需要四个有限数字 x0/y0/x1/y1（原图像素坐标），收到 [${nums.join(', ')}]`)
      }
      const x0 = Math.max(0, Math.min(Math.round(c.x0), origW))
      const y0 = Math.max(0, Math.min(Math.round(c.y0), origH))
      const x1 = Math.max(0, Math.min(Math.round(c.x1), origW))
      const y1 = Math.max(0, Math.min(Math.round(c.y1), origH))
      if (x1 - x0 < 8 || y1 - y0 < 4) {
        throw new Error(`ocr crop 无效：[${c.x0},${c.y0},${c.x1},${c.y1}] 在 ${origW}x${origH} 的图上裁不出有效区域（x1>x0、y1>y0，坐标是原图像素）`)
      }
      cropRegion = { x0, y0, x1, y1 }
      // extract 在 resize 之前 = 按输入（原图）坐标裁，之后才套 MAX_DECODE_SIDE
      pipe = pipe.extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    }

    const { data: rgb, info } = await pipe
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
    // 框坐标的回图比例：解码尺寸 → 框所属坐标系（原图全图）。有 crop 时比例
    // 分母是**裁剪区**的文件尺寸，push 时再平移回全图——box 坐标系与裁剪无关。
    const spanW = cropRegion ? cropRegion.x1 - cropRegion.x0 : origW
    const spanH = cropRegion ? cropRegion.y1 - cropRegion.y0 : origH
    const kx = W > 0 && spanW > 0 ? spanW / W : 1
    const ky = H > 0 && spanH > 0 ? spanH / H : 1

    // --- det ---
    // detLimit：钳进 [320, 2000]，默认 DET_LIMIT；非有限数字回落默认，不给 LLM
    // 传来的垃圾值一次炸掉 sharp 的机会。
    const detLimit = typeof opts.detLimit === 'number' && Number.isFinite(opts.detLimit)
      ? Math.max(320, Math.min(Math.round(opts.detLimit), 2000))
      : DET_LIMIT

    interface DetBox { x0: number; y0: number; x1: number; y1: number }
    let boxes: DetBox[] = []
    let tileBands = 0
    // det 实际工作尺寸（tile 时取首带的——除末带外各带同尺寸，回声语义不变）
    let detW = 0
    let detH = 0

    if (opts.tile === true) {
      // tile 分带：每带 det 提到 ~1:1（effDet 至少盖住带宽），接受区间按带
      // 分区——每行文字的 y 中心恰属一个带，结果零重复、无需去重。
      const effDet = Math.min(2000, Math.max(detLimit, W))
      const bandH = Math.max(320, Math.floor(effDet * 0.85))
      const ov = Math.floor(bandH * 0.2)
      const step = bandH - ov
      const starts: number[] = []
      for (let y = 0; y < H; y += step) starts.push(y)
      tileBands = starts.length
      for (const [i, y0] of starts.entries()) {
        // det 区域向下多带一份 overlap：被本带「拥有」的行（中心 < 下一带起点）
        // 必须完整落在区域内，避免带缘裁出半行
        const y1 = Math.min(H, y0 + bandH + ov)
        const bh = y1 - y0
        const bandImg = cropRgb(rgb, W, H, 0, y0, W, y1)
        const bscale = Math.min(1, effDet / Math.max(W, bh))
        const bdw = Math.max(32, Math.round((W * bscale) / 32) * 32)
        const bdh = Math.max(32, Math.round((bh * bscale) / 32) * 32)
        if (i === 0) { detW = bdw; detH = bdh }
        const detImg = resizeBilinear(bandImg, W, bh, bdw, bdh)
        const detOut = await s.det.run({
          x: new ort.Tensor('float32', toTensorData(detImg, bdw, bdh, 'det'), [1, 3, bdh, bdw])
        })
        const prob = detOut[s.det.outputNames[0]].data
        const rx = bdw / W
        const ry = bdh / bh
        // 接受区间 = [y0, 下一带起点)：与其它带的接受区间共同恰分 [0, H)
        const acceptEnd = i + 1 < starts.length ? starts[i + 1] : H
        for (const b of dbPostProcess(prob, bdw, bdh)) {
          const bx0 = Math.max(0, Math.floor(b.x0 / rx))
          const by0 = Math.max(0, Math.floor(b.y0 / ry)) + y0
          const bx1 = Math.min(W, Math.ceil(b.x1 / rx))
          const by1 = Math.min(bh, Math.ceil(b.y1 / ry)) + y0
          if (bx1 - bx0 < 4 || by1 - by0 < 4) continue
          const cy = (by0 + by1) / 2
          if (cy < y0 || cy >= acceptEnd) continue
          boxes.push({ x0: bx0, y0: by0, x1: bx1, y1: by1 })
        }
      }
      boxes.sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0)
    } else {
      // 整图路径（缺省）：与历史行为逐字节一致，勿动
      const scale = Math.min(1, detLimit / Math.max(W, H))
      const dw = Math.max(32, Math.round((W * scale) / 32) * 32)
      const dh = Math.max(32, Math.round((H * scale) / 32) * 32)
      detW = dw; detH = dh
      const detImg = resizeBilinear(rgb, W, H, dw, dh)
      const detOut = await s.det.run({
        x: new ort.Tensor('float32', toTensorData(detImg, dw, dh, 'det'), [1, 3, dh, dw])
      })
      const prob = detOut[s.det.outputNames[0]].data
      const rx = dw / W
      const ry = dh / H
      boxes = dbPostProcess(prob, dw, dh)
        .map(b => ({
          x0: Math.max(0, Math.floor(b.x0 / rx)),
          y0: Math.max(0, Math.floor(b.y0 / ry)),
          x1: Math.min(W, Math.ceil(b.x1 / rx)),
          y1: Math.min(H, Math.ceil(b.y1 / ry))
        }))
        .filter(b => b.x1 - b.x0 >= 4 && b.y1 - b.y0 >= 4)
        .sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2 || a.x0 - b.x0)
    }

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
      const ox = cropRegion ? cropRegion.x0 : 0
      const oy = cropRegion ? cropRegion.y0 : 0
      lines.push({
        text,
        score: picked ? scoreSum / picked : 0,
        // 解码空间的框 → 裁剪区文件尺寸 → 平移回全图（见 OcrLine.box 的契约）
        box: {
          x0: Math.round(box.x0 * kx) + ox,
          y0: Math.round(box.y0 * ky) + oy,
          x1: Math.round(box.x1 * kx) + ox,
          y1: Math.round(box.y1 * ky) + oy
        }
      })
    }

    touchIdleTimer()
    // 界面碎片（X / <返回 / 它 / 小 / 21）会被 det 当成文字行，分数低、长度短。
    // 不过滤就会原样喂给 LLM，在医疗/合同这类场景里可能被当成正文。
    const { kept, dropped } = filterNoiseLines(lines)
    // 阅读顺序：det 的框按 y 中心排序，同一行的键值 y 中心差 1-2px 时值的列会
    // 排到键前面——纯文本与 lines 数组都按「行聚类→行内按 x」重排（见
    // ocr-core 的 readingOrderLines），下游不解析 bbox 也不会静默拿错数据。
    const orderedKept = readingOrderLines(kept)
    const orderedDropped = readingOrderLines(dropped)
    // 慢调用诊断（conv_20261116210413 第三轮：同图 1.85s→12.9s 的回归报告——
    // 推理代码零改动、隔离复测 HEAD 比当前还慢，指向 ORT WASM 线程/机器状态
    // 而非代码。GUI 启动无终端，耗时异常只有落进 logs/main.log 才可事后归因：
    // 这行给出 det 工作尺寸与行数，能区分「冷会话」「线程未起」「分辨率放大」。
    const tookMs = Date.now() - started
    if (tookMs > OCR_SLOW_LOG_MS) {
      void import('../main-log').then(({ logMain }) => {
        logMain('WARN', 'ocr', `slow recognize: ${tookMs}ms det=${detW}x${detH}${tileBands > 1 ? ` tile=${tileBands}bands` : ''} decode=${W}x${H} lines=${orderedKept.length} dropped=${orderedDropped.length} crop=${cropRegion ? 'yes' : 'no'}`)
      }).catch(() => { /* 诊断日志尽力而为 */ })
    }
    return {
      text: orderedKept.map(l => l.text).join('\n'),
      lines: orderedKept,
      dropped: orderedDropped,
      width: W,
      height: H,
      originalWidth: origW,
      originalHeight: origH,
      detWidth: detW,
      detHeight: detH,
      ...(cropRegion ? { crop: cropRegion } : {}),
      ...(tileBands > 0 ? { tile: { bands: tileBands } } : {}),
      ms: Date.now() - started
    }
  })
}
