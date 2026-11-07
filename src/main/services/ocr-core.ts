/**
 * PP-OCRv4 后处理核心 —— 纯函数，无原生依赖（不 import sharp / onnxruntime）。
 * 这样单测能在纯 Node 下跑，不需要 Electron ABI 或模型文件。
 *
 * 三块内容：
 *   1. 图像：双线性缩放 / 裁切 / CHW 张量展开
 *   2. det：DB 后处理（二值化 → 连通域 → 过滤 → unclip）
 *   3. rec：CTC 贪心解码 + 长行切段（含接缝去重）
 */

export interface OcrBox {
  x0: number
  y0: number
  x1: number
  y1: number
  score: number
}

export interface CtcResult {
  text: string
  score: number
}

export interface ScoredLine {
  text: string
  score: number
}

export interface LineFilterOptions {
  /** 低于此分数才可能被丢 */
  scoreFloor?: number
  /** 去空白后长度不超过此值才可能被丢 */
  maxShortLen?: number
}

export interface Segment {
  sx: number
  ex: number
}

/** det/cls 用 ImageNet 均值方差；rec 用 (x/255-0.5)/0.5。口径混用会整体失真。 */
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const

export function toTensorData (
  rgb: Uint8Array,
  width: number,
  height: number,
  mode: 'det' | 'rec'
): Float32Array {
  const n = width * height
  const out = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = rgb[i * 3 + c] / 255
      out[c * n + i] = mode === 'rec' ? (v - 0.5) / 0.5 : (v - MEAN[c]) / STD[c]
    }
  }
  return out
}

export function resizeBilinear (
  src: Uint8Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number
): Uint8Array {
  const dst = new Uint8Array(dw * dh * 3)
  const xr = sw / dw
  const yr = sh / dh
  for (let y = 0; y < dh; y++) {
    const fy = Math.min(sh - 1, Math.max(0, (y + 0.5) * yr - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(sh - 1, y0 + 1)
    const wy = fy - y0
    for (let x = 0; x < dw; x++) {
      const fx = Math.min(sw - 1, Math.max(0, (x + 0.5) * xr - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(sw - 1, x0 + 1)
      const wx = fx - x0
      const o = (y * dw + x) * 3
      for (let c = 0; c < 3; c++) {
        const p00 = src[(y0 * sw + x0) * 3 + c]
        const p01 = src[(y0 * sw + x1) * 3 + c]
        const p10 = src[(y1 * sw + x0) * 3 + c]
        const p11 = src[(y1 * sw + x1) * 3 + c]
        dst[o + c] = Math.round(
          p00 * (1 - wy) * (1 - wx) + p01 * (1 - wy) * wx + p10 * wy * (1 - wx) + p11 * wy * wx
        )
      }
    }
  }
  return dst
}

export function cropRgb (
  src: Uint8Array,
  sw: number,
  sh: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
): Uint8Array {
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const dst = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.max(0, y0 + y))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.max(0, x0 + x))
      const si = (sy * sw + sx) * 3
      const di = (y * w + x) * 3
      dst[di] = src[si]
      dst[di + 1] = src[si + 1]
      dst[di + 2] = src[si + 2]
    }
  }
  return dst
}

export interface DbOptions {
  thresh?: number
  boxThresh?: number
  minSize?: number
  unclipRatio?: number
}

/**
 * DB 后处理。返回 det 输入尺度下的轴对齐框。
 * 注意：只取轴对齐 bbox，没有 minAreaRect；倾斜文本会带入背景，
 * 换来的是不需要凸包 + 旋转卡壳，纯 JS 可移植。
 */
export function dbPostProcess (
  prob: Float32Array,
  width: number,
  height: number,
  opts: DbOptions = {}
): OcrBox[] {
  const thresh = opts.thresh ?? 0.3
  const boxThresh = opts.boxThresh ?? 0.6
  const minSize = opts.minSize ?? 4
  const unclipRatio = opts.unclipRatio ?? 1.6

  const total = width * height
  const bin = new Uint8Array(total)
  for (let i = 0; i < total; i++) bin[i] = prob[i] > thresh ? 1 : 0

  const seen = new Uint8Array(total)
  const stack = new Int32Array(total)
  const boxes: OcrBox[] = []

  for (let start = 0; start < total; start++) {
    if (!bin[start] || seen[start]) continue
    // 迭代泛洪：递归在大图上会爆栈
    let sp = 0
    stack[sp++] = start
    seen[start] = 1
    let minX = width
    let minY = height
    let maxX = -1
    let maxY = -1
    let sum = 0
    let count = 0
    while (sp > 0) {
      const p = stack[--sp]
      const py = (p / width) | 0
      const px = p - py * width
      sum += prob[p]
      count++
      if (px < minX) minX = px
      if (px > maxX) maxX = px
      if (py < minY) minY = py
      if (py > maxY) maxY = py
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue
          const nx = px + dx
          if (nx < 0 || nx >= width) continue
          const q = ny * width + nx
          if (bin[q] && !seen[q]) {
            seen[q] = 1
            stack[sp++] = q
          }
        }
      }
    }
    const bw = maxX - minX + 1
    const bh = maxY - minY + 1
    if (bw < minSize || bh < minSize) continue
    const score = sum / count
    if (score < boxThresh) continue
    // unclip：外扩距离 = 面积 × ratio / 周长
    const dist = (bw * bh * unclipRatio) / (2 * (bw + bh))
    boxes.push({
      x0: Math.max(0, Math.round(minX - dist)),
      y0: Math.max(0, Math.round(minY - dist)),
      x1: Math.min(width - 1, Math.round(maxX + dist)),
      y1: Math.min(height - 1, Math.round(maxY + dist)),
      score
    })
  }
  return boxes
}

/**
 * CTC 贪心解码。
 * 类别布局：0 = blank，1..chars.length = 字典字符，chars.length+1 = 空格。
 */
export function ctcDecode (
  pred: Float32Array,
  steps: number,
  classes: number,
  chars: readonly string[]
): CtcResult {
  let prev = -1
  let text = ''
  let scoreSum = 0
  let picked = 0
  for (let t = 0; t < steps; t++) {
    const off = t * classes
    let best = 0
    let bestP = pred[off]
    for (let c = 1; c < classes; c++) {
      const p = pred[off + c]
      if (p > bestP) {
        bestP = p
        best = c
      }
    }
    if (best !== 0 && best !== prev) {
      text += best <= chars.length ? chars[best - 1] : ' '
      scoreSum += bestP
      picked++
    }
    prev = best
  }
  return { text, score: picked ? scoreSum / picked : 0 }
}

/**
 * 长行切段。
 * rec 的输入宽度上限是 320；一行 2240px 直接压到 320 是 8 倍横向压缩，
 * 实测准字率从 ~94% 掉到 50%。所以超宽行必须切段再逐段识别。
 */
export function computeSegments (
  width: number,
  height: number,
  recHeight: number,
  maxWidth: number,
  overlapRatio = 0.08
): Segment[] {
  if (width <= 0 || height <= 0) return []
  const wantW = Math.round((recHeight * width) / height)
  if (wantW <= maxWidth) return [{ sx: 0, ex: width }]

  const n = Math.ceil(wantW / maxWidth)
  const segW = Math.ceil(width / n)
  const overlap = Math.round(segW * overlapRatio)
  const segs: Segment[] = []
  for (let i = 0; i < n; i++) {
    const sx = Math.max(0, i * segW - (i ? overlap : 0))
    const ex = Math.min(width, (i + 1) * segW + (i < n - 1 ? overlap : 0))
    if (ex - sx >= 4) segs.push({ sx, ex })
  }
  return segs
}

/**
 * 接缝去重：段间有重叠，新段开头可能重复上一段末尾的字。
 * 返回真正需要追加的部分。
 */
export function dedupeJoin (acc: string, add: string, maxOverlap = 4): string {
  const limit = Math.min(maxOverlap, add.length, acc.length)
  for (let k = limit; k > 0; k--) {
    if (acc.endsWith(add.slice(0, k))) return add.slice(k)
  }
  return add
}

/**
 * 低置信度短碎片过滤。
 *
 * 双条件是刻意的，两个单条件都会出事（数据来自 51 张真实体检报告截图、1917 行）：
 *  - 只按分数丢 → 误杀真内容。实测正文分数低到 0.72（「参考值：21.0~-31.0mmol/L」
 *    0.906、「阴性(-)」0.933、「载脂蛋白CII」0.851）；纯分数档 0.94 会丢掉 34 行
 *    长正文，整行检验参考值直接消失。
 *  - 只按长度丢 → 把「钾」这类 1 个字的结果项一起清掉。
 * 两者同时成立才丢，默认档实测：丢 344/1917 行（17.9%），其中长度>=5 的 0 条、
 * 分数>=0.96 的 0 条，即未观测到真内容损失。
 *
 * 已知残留：界面噪声里「X」(0.922)、「<返回」(0.896) 会存活 —— 收紧到 0.94/len<=4
 * 能清掉它们，但会连「钾」0.912、「3.81」0.930 这类真实化验值一起丢。宁可留噪声。
 */
export function filterNoiseLines<T extends ScoredLine> (
  lines: readonly T[],
  opts: LineFilterOptions = {}
): { kept: T[]; dropped: T[] } {
  const floor = opts.scoreFloor ?? 0.9
  const maxLen = opts.maxShortLen ?? 2
  const kept: T[] = []
  const dropped: T[] = []
  for (const line of lines) {
    const compact = line.text.replace(/\s+/g, '')
    if (compact.length <= maxLen && line.score < floor) dropped.push(line)
    else kept.push(line)
  }
  return { kept, dropped }
}
