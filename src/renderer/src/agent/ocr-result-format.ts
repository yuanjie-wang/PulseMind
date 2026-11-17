// ── OCR tool result formatting: THE model-facing body, built once ──
// The ocr executor (tool-executors.ts) used to inline this string — the header
// grew a det/original size line and a per-line bbox section, so the shape now
// lives here as a pure function: unit-testable without ONNX or sharp, and the
// one place to change wording when the result shape moves again.
//
// Pure, zero-dependency — the input is a structural type (not the bridge
// interface) so a legacy IPC payload missing the newer optional fields still
// formats honestly.

export interface OcrFormatBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface OcrFormatLine {
  text: string
  score: number
  /** 原图（文件）像素坐标；legacy 结果可能缺席 */
  box?: OcrFormatBox
}

export interface OcrFormatResult {
  text: string
  lines: OcrFormatLine[]
  dropped: OcrFormatLine[]
  /** 解码后参与识别的尺寸（>4000 边先降采样） */
  width: number
  height: number
  /** 文件原始尺寸——lines[].box 的坐标系（缺席 = legacy 结果） */
  originalWidth?: number
  originalHeight?: number
  /** det 检测实际工作尺寸（≤960）——「输入被内部缩放」的唯一可见出口 */
  detWidth?: number
  detHeight?: number
  /** 实际生效的裁剪区（原图坐标）——box 不受它影响，仍是全图坐标 */
  crop?: OcrFormatBox
  /** tile 分带回声：bands = 实际 det 次数（1:1 检测） */
  tile?: { bands: number }
  ms: number
}

export interface OcrFormatOptions {
  filePath: string
  /** 附每行几何（表格/版面任务用）——ocr 工具的 include_layout 参数 */
  includeLayout?: boolean
  /** 附被噪声过滤丢掉的行——ocr 工具的 include_dropped 参数 */
  includeDropped?: boolean
}

const BOX_NOTE = 'bbox = x0,y0,x1,y1 in image pixels'

function lineText(l: OcrFormatLine, withBox: boolean): string {
  const box = withBox && l.box ? `[${l.box.x0},${l.box.y0},${l.box.x1},${l.box.y1}] ` : ''
  return `${box}${l.text} (${l.score.toFixed(3)})`
}

/** The model-facing OCR result: metadata header → text → optional geometry →
 *  optional dropped lines. Header always shows the size chain the image went
 *  through (original → decode → det) so silent internal scaling is visible. */
export function formatOcrResult(result: OcrFormatResult, opts: OcrFormatOptions): string {
  const sizes: string[] = []
  const hasOriginal = result.originalWidth != null && result.originalHeight != null && result.originalWidth > 0
  if (hasOriginal) {
    sizes.push(`${result.originalWidth}x${result.originalHeight}`)
    const decoded = `${result.width}x${result.height}`
    if (decoded !== `${result.originalWidth}x${result.originalHeight}`) sizes.push(`decode ${decoded}`)
  } else {
    sizes.push(`${result.width}x${result.height}`)
  }
  if (result.detWidth != null && result.detHeight != null) sizes.push(`det ${result.detWidth}x${result.detHeight}`)

  const minScore = result.lines.length ? Math.min(...result.lines.map(l => l.score)) : 0
  const header = [
    '--- OCR Metadata ---',
    `path: ${opts.filePath}`,
    `image: ${sizes.join(' → ')}`,
    ...(result.crop
      ? [`crop: [${result.crop.x0},${result.crop.y0},${result.crop.x1},${result.crop.y1}] (boxes stay in full-image coordinates)`]
      : []),
    ...(result.tile
      ? [`tile: ${result.tile.bands} bands (detection at ~1:1, no whole-image downscale)`]
      : []),
    `lines: ${result.lines.length}${result.dropped.length ? ` (${result.dropped.length} noise lines dropped)` : ''}`,
    `elapsed: ${result.ms}ms`,
    result.lines.length ? `minScore: ${minScore.toFixed(3)}` : 'minScore: —',
  ].join('\n')

  const parts: string[] = [header, '', result.text.trim() || '_图片中未检测到文字_']

  // 两档置信提示（conv_20261116210413 第三轮实测：0.949 的错读 L-9 从 0.9 阈值
  // 漏过）。<0.9 = Low confidence（噪声过滤线，与 ocr-core filterNoiseLines 的
  // scoreFloor 同源）；0.90–0.96 = Borderline（模型提议的可疑档：正确行也常落
  // 在这段，但实测错读恰好藏在这里——多列几行的 token 成本远低于一次错误交付）。
  // 都带 bbox，可直接喂 crop 复核。
  const LOW_SCORE = 0.9
  const BORDERLINE_HIGH = 0.96
  const lowConf = result.lines.filter(l => l.score < LOW_SCORE)
  if (lowConf.length > 0) {
    parts.push('', `### Low confidence (score < ${LOW_SCORE}, 考虑复核)`, ...lowConf.map(l => lineText(l, true)))
  }
  const borderline = result.lines.filter(l => l.score >= LOW_SCORE && l.score < BORDERLINE_HIGH)
  if (borderline.length > 0) {
    parts.push('', `### Borderline (score ${LOW_SCORE}–${BORDERLINE_HIGH}, 可疑)`, ...borderline.map(l => lineText(l, true)))
  }

  if (opts.includeLayout && result.lines.length) {
    parts.push('', `### Lines (${BOX_NOTE})`, ...result.lines.map(l => lineText(l, true)))
  }
  if (opts.includeDropped && result.dropped.length) {
    // 误杀只能靠人看被丢的东西才能发现，按需原样列出，不折叠成计数。
    // box 有则带上：表格里被丢的单字单元格和保留行共享 y 带，几何一眼可见。
    parts.push('', `### Dropped as noise (${BOX_NOTE})`, ...result.dropped.map(l => lineText(l, true)))
  }
  return parts.join('\n')
}
