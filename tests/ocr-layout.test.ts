// OCR 结果的几何与缩放可见性（conv_20261116210413 反思的 #1/#3，2026-11-16）：
// det 的检测框在 ocr.ts 内部本来就有（dbPostProcess → 映射回解码尺寸 → 供裁剪），
// 之前只保留 {text, score} 就扔了——模型做表格提取只能写脚本暴力反推版面；
// 内部两处静默缩放（decode ≤4000、det ≤960）也从不报告，模型把「放大裁图被
// 缩回去导致漏检」误归因成「识别器不友好」，同一个错犯三次。
//
// 这份文件钉两层：formatOcrResult 的真实输出形状（可独立单测的纯函数），以及
// 从 ocr.ts → svcOcrImage → IPC 类型 → executor → 工具 schema/instructions 的
// 接线扫描（少一环就是「字段有了但模型看不见」）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatOcrResult, type OcrFormatResult } from '../src/renderer/src/agent/ocr-result-format'

const root = join(__dirname, '..')
const src = (p: string) => readFileSync(join(root, p), 'utf8')

const base: OcrFormatResult = {
  text: '单选1-1\n单选1-2',
  lines: [
    { text: '单选1-1', score: 0.98, box: { x0: 12, y0: 34, x1: 456, y1: 58 } },
    { text: '单选1-2', score: 0.55, box: { x0: 12, y0: 70, x1: 456, y1: 94 } },
  ],
  dropped: [{ text: '4', score: 0.71, box: { x0: 480, y0: 34, x1: 500, y1: 58 } }],
  width: 1950,
  height: 106,
  originalWidth: 1950,
  originalHeight: 106,
  detWidth: 960,
  detHeight: 52,
  ms: 1234,
}

describe('formatOcrResult', () => {
  it('header shows the size chain; decode tier absent when original == decoded', () => {
    const out = formatOcrResult(base, { filePath: '/tmp/table.png' })
    expect(out).toContain('image: 1950x106 → det 960x52')
    expect(out).not.toContain('decode')
    expect(out).toContain('lines: 2 (1 noise lines dropped)')
    expect(out).toContain('elapsed: 1234ms')
    expect(out).toContain('minScore: 0.550')
    expect(out).toContain('path: /tmp/table.png')
    // 正文在头部之后
    expect(out.indexOf('--- OCR Metadata ---')).toBeLessThan(out.indexOf('单选1-1'))
  })

  it('decode tier appears only when the image was actually shrunk at decode', () => {
    const out = formatOcrResult({ ...base, width: 4000, height: 2400, originalWidth: 5000, originalHeight: 3000, detWidth: 960, detHeight: 576 }, { filePath: 'x' })
    expect(out).toContain('image: 5000x3000 → decode 4000x2400 → det 960x576')
  })

  it('legacy payload without original/det still formats honestly', () => {
    const legacy: OcrFormatResult = { text: 'hi', lines: [{ text: 'hi', score: 0.9 }], dropped: [], width: 800, height: 600, ms: 5 }
    const out = formatOcrResult(legacy, { filePath: 'x' })
    expect(out).toContain('image: 800x600')
    expect(out).not.toContain('→ det')
  })

  it('include_layout appends the per-line bbox section', () => {
    const out = formatOcrResult(base, { filePath: 'x', includeLayout: true })
    expect(out).toContain('### Lines (bbox = x0,y0,x1,y1 in image pixels)')
    expect(out).toContain('[12,34,456,58] 单选1-1 (0.980)')
    expect(out).toContain('[12,70,456,94] 单选1-2 (0.550)')
  })

  it('layout is opt-in: no bbox section by default', () => {
    const out = formatOcrResult(base, { filePath: 'x' })
    expect(out).not.toContain('### Lines')
    expect(out).not.toContain('[12,34,456,58]')
  })

  it('include_dropped lists dropped lines with their boxes', () => {
    const out = formatOcrResult(base, { filePath: 'x', includeDropped: true })
    expect(out).toContain('### Dropped as noise (bbox = x0,y0,x1,y1 in image pixels)')
    expect(out).toContain('[480,34,500,58] 4 (0.710)')
  })

  it('empty recognition still renders the placeholder', () => {
    const out = formatOcrResult({ ...base, text: '', lines: [], dropped: [] }, { filePath: 'x' })
    expect(out).toContain('_图片中未检测到文字_')
    expect(out).toContain('minScore: —')
  })

  it('a tile run echoes its bands in the header', () => {
    const out = formatOcrResult({ ...base, tile: { bands: 3 } }, { filePath: 'x' })
    expect(out).toContain('tile: 3 bands (detection at ~1:1, no whole-image downscale)')
    // 不带 tile 时该行不出现
    expect(formatOcrResult(base, { filePath: 'x' })).not.toContain('tile:')
  })

  it('an echoed crop rides the header, with the full-image box invariant spelled out', () => {
    const out = formatOcrResult(
      { ...base, crop: { x0: 100, y0: 50, x1: 800, y1: 150 } },
      { filePath: 'x', includeLayout: true }
    )
    expect(out).toContain('crop: [100,50,800,150] (boxes stay in full-image coordinates)')
    // 裁剪后 box 仍是全图坐标——这是模型把多次裁剪结果对齐合并的承重契约
    expect(out).toContain('[12,34,456,58] 单选1-1 (0.980)')
    // 无 crop 时该行不出现
    const plain = formatOcrResult(base, { filePath: 'x' })
    expect(plain).not.toContain('crop:')
  })

  it('kept lines below 0.90 are auto-listed with boxes (no opt-in)', () => {
    // base 第二行 0.55 → 自动出现在 Low confidence 段
    const out = formatOcrResult(base, { filePath: 'x' })
    expect(out).toContain('### Low confidence (score < 0.9, 考虑复核)')
    expect(out).toContain('[12,70,456,94] 单选1-2 (0.550)')
    // 全高分时不出现该段
    const clean = formatOcrResult(
      { ...base, lines: [{ text: '单选1-1', score: 0.98, box: { x0: 12, y0: 34, x1: 456, y1: 58 } }] },
      { filePath: 'x' }
    )
    expect(clean).not.toContain('Low confidence')
  })

  it('borderline tier 0.90-0.96 catches the misread class that 0.9 let through', () => {
    // conv_20261116210413 第三轮实测：L-9 (0.949) 是错读，0.9 阈值漏过它
    const out = formatOcrResult(
      { ...base, lines: [{ text: 'L-9', score: 0.949, box: { x0: 10, y0: 20, x1: 60, y1: 50 } }] },
      { filePath: 'x' }
    )
    expect(out).toContain('### Borderline (score 0.9–0.96, 可疑)')
    expect(out).toContain('[10,20,60,50] L-9 (0.949)')
    expect(out).not.toContain('Low confidence') // 0.949 ≥ 0.9，不进低置信段
    // 0.97 既不进 Borderline 也不进 Low confidence
    const clean = formatOcrResult(
      { ...base, lines: [{ text: 'x', score: 0.97, box: { x0: 1, y0: 2, x1: 3, y1: 4 } }] },
      { filePath: 'x' }
    )
    expect(clean).not.toContain('Borderline')
  })
})

describe('ocr layout wiring', () => {
  it('ocr.ts fills box (mapped to original pixels) and reports original/det sizes', () => {
    const s = src('src/main/services/ocr.ts')
    // OcrLine 契约：box 字段 + 原图坐标系注释
    expect(s).toMatch(/box: OcrBox/)
    // 解码空间的框映射回原图：kx/ky 比例在 push 时应用，crop 时再平移回全图
    expect(s).toContain('Math.round(box.x0 * kx) + ox')
    expect(s).toContain('Math.round(box.y1 * ky) + oy')
    // 三层尺寸全部出场（tile 后 det 尺寸取分支外变量 detW/detH）
    expect(s).toContain('originalWidth: origW')
    expect(s).toContain('detWidth: detW')
    // 原始尺寸来自图片头（不解码），且不在解码前用 sharp 再走一遍全量管线
    expect(s).toContain('.metadata()')
    // 慢调用诊断落 logs/main.log（GUI 无终端，耗时异常只有落盘才可事后归因）
    expect(s).toContain('OCR_SLOW_LOG_MS')
    expect(s).toContain('slow recognize:')
    // crop：extract 在 resize 之前（原图坐标裁），det_limit 有界且非有限数字回落默认
    expect(s).toContain('pipe.extract(')
    expect(s).toContain('Math.max(320, Math.min(Math.round(opts.detLimit), 2000))')
    expect(s).toContain('Number.isFinite(n)')
  })

  it('svcOcrImage passes opts and the new fields through to IPC', () => {
    const s = src('src/main/services/file-ops.ts')
    expect(s).toContain('recognizeImage(guard.resolved, opts)')
    for (const field of ['originalWidth', 'originalHeight', 'detWidth', 'detHeight']) {
      expect(s).toContain(`${field}: result.${field}`)
    }
    expect(s).toMatch(/box: \{ x0: number; y0: number; x1: number; y1: number \}/)
  })

  it('IPC type declarations carry box, the size chain, and the opts param', () => {
    for (const p of ['src/shared/types/electron-bridge.ts', 'src/preload/index.ts']) {
      const s = src(p)
      expect(s).toContain('originalWidth: number')
      expect(s).toContain('detHeight: number')
      expect(s).toContain('box: { x0: number; y0: number; x1: number; y1: number }')
      expect(s).toContain('opts?: { crop?:')
      expect(s).toContain('detLimit?: number')
    }
  })

  it('the ocr executor renders through the shared formatter and threads crop/det_limit', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    expect(s).toContain("import { formatOcrResult } from './ocr-result-format'")
    expect(s).toContain('const includeLayout = t.input?.include_layout === true')
    expect(s).toContain('ocrImage(filePath, ocrOpts)')
    expect(s).toContain('det_limit')
    // 旧的内联头部构建已迁走——别让两套格式并存
    expect(s).not.toContain("'--- OCR Metadata ---'")
  })

  it('unknown params are rejected with the supported list (the verification enabler)', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    // 白名单集合 + 报错话术点名未知参数并列出支持的——模型一次调用就能自纠
    expect(s).toContain("new Set(['file_path', 'files', 'include_layout', 'include_dropped', 'crop', 'det_limit', 'tile'])")
    expect(s).toContain('ocr 不认识参数')
    expect(s).toContain('支持的参数: file_path / files / include_layout / include_dropped / crop / det_limit / tile')
  })

  it('tile: threaded through every layer, boolean-shape guarded, mutually exclusive with crop', () => {
    const exec = src('src/renderer/src/agent/tool-executors.ts')
    // 布尔形态守卫：字符串 "true" 收编、其余形态报错（与 crop/det_limit 同待遇）
    expect(exec).toMatch(/tileV === true \|\| tileV === 'true'/)
    expect(exec).toContain('tile 必须是布尔值 true/false')
    // 与 crop 互斥（executor 层 + 主进程层双兜底）
    expect(exec).toMatch(/ocrOpts\.tile === true && ocrOpts\.crop/)
    const main = src('src/main/services/ocr.ts')
    expect(main).toContain('tile 与 crop 二选一')
    // ocr.ts 分带主干：effDet 至少盖住带宽（1:1），接受区间分区零重复
    expect(main).toContain('const effDet = Math.min(2000, Math.max(detLimit, W))')
    expect(main).toContain('const acceptEnd = i + 1 < starts.length ? starts[i + 1] : H')
    expect(main).toContain('if (cy < y0 || cy >= acceptEnd) continue')
    // 分带 det 区域向下多带一份 overlap：被本带拥有的行必须完整落在区域内
    expect(main).toContain('y0 + bandH + ov')
    // 回声两层透传
    expect(main).toContain('tile: { bands: tileBands }')
    expect(src('src/main/services/file-ops.ts')).toContain('result.tile ? { tile: result.tile }')
    for (const p of ['src/shared/types/electron-bridge.ts', 'src/preload/index.ts']) {
      expect(src(p)).toContain('tile?: boolean')
      expect(src(p)).toContain('tile?: { bands: number }')
    }
  })

  it('crop garbage VALUE form (string "0,0,100,100" / array) throws at the executor (no silent full-image run)', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    // review_20261117 中1：键白名单治了「名猜错」，值形态守卫治「形态错」——
    // 字符串形态 typeof 不是 object，旧代码静默落空 → 整图照跑，模型以为裁剪生效
    expect(s).toContain('crop 必须是对象 { x0, y0, x1, y1 }')
    expect(s).toMatch(/typeof t\.input\.crop !== 'object' \|\| Array\.isArray\(t\.input\.crop\)/)
    expect(s).toMatch(/Array\.isArray\(t\.input\.crop\)\s*\n\s*\? '数组'/)
  })

  it('det_limit garbage value (non-finite after coercion) throws instead of silently falling back to 960', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    expect(s).toContain('det_limit 必须是数字')
    expect(s).toMatch(/!Number\.isFinite\(detLimitN\)/)
    // 字符串数字 "1280" 经 Number() 收编（不拒），只有转不出有限数字才报错
    expect(s).toMatch(/const detLimitN = Number\(t\.input\.det_limit\)/)
  })

  it('missing-key NaN still passes through to the main process (no rule duplication here)', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    // 缺键 → NaN 透传，ocr.ts 的 Number.isFinite 门给可读报错——形态层在 executor、
    // 数值层在主进程的分界不合并
    expect(s).toMatch(/x0: Number\(c\.x0\), y0: Number\(c\.y0\),/)
    expect(s).toMatch(/x1: Number\(c\.x1\), y1: Number\(c\.y1\),/)
    const main = src('src/main/services/ocr.ts')
    expect(main).toContain('ocr crop 需要四个有限数字 x0/y0/x1/y1')
  })

  it('files batch: per-file sections, failures isolated, 10-cap, exactly-one-of', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    expect(s).toContain('=== File ${i + 1}/${paths.length}: ${p} ===')
    expect(s).toContain('[FAILED]')
    expect(s).toContain('files 一次最多 10 张')
    expect(s).toContain('file_path 与 files 二选一')
    // 批量沿主进程串行闸逐文件走，不并行
    expect(s).toContain('for (const [i, p] of paths.entries())')
  })

  it('reading order: ocr.ts re-sorts kept AND dropped via readingOrderLines', () => {
    const s = src('src/main/services/ocr.ts')
    expect(s).toContain('readingOrderLines(kept)')
    expect(s).toContain('readingOrderLines(dropped)')
    expect(s).toMatch(/import \{[^}]*readingOrderLines[^}]*\} from '\.\/ocr-core'/)
    const core = src('src/main/services/ocr-core.ts')
    // 行容差来自中位行高（0.6×medH）——判别依据见函数注释
    expect(core).toContain('export function readingOrderLines')
    expect(core).toContain('medH * 0.6')
  })

  it('read refuses images and points at ocr (no more binary cat)', () => {
    const s = src('src/renderer/src/agent/tool-executors.ts')
    expect(s).toContain('OCR_IMAGE_EXTS')
    expect(s).toContain(".png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff")
    // 守卫在 shell cat 之前、指路 ocr
    expect(s.indexOf('OCR_IMAGE_EXTS.has(ext)')).toBeGreaterThan(0)
    expect(s).toContain('用 ocr 工具识别文字')
    // main 侧权威名单的扩展名集合与渲染端镜像一致（7 项）
    const main = src('src/main/storage/extractors/ocr-extractor.ts')
    for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff']) {
      expect(main).toContain(`'${e}'`)
      expect(s).toContain(`'${e}'`)
    }
  })

  it('the ocr tool advertises include_layout/crop/det_limit/files and the usage guidance', () => {
    const schema = src('src/renderer/src/tools/built-in-tools.ts')
    expect(schema).toContain('include_layout')
    expect(schema).toContain('bounding box')
    expect(schema).toContain('det_limit')
    expect(schema).toContain('FULL-image pixel coordinates')
    expect(schema).toContain('files:')
    expect(schema).toContain('up to 10 image paths')
    const instructions = src('src/renderer/src/tools/tool-instructions.ts')
    // 反思里最值钱的一条使用侧引导：表格先整图带 bbox 识别，再裁剪，不写脚本猜版面
    expect(instructions).toContain('include_layout: true')
    expect(instructions).toContain('先整图跑一次')
    expect(instructions).toContain('crop {x0,y0,x1,y1}')
    expect(instructions).toContain('det_limit: 1280')
    expect(instructions).toContain('裁剪重跑，不要换策略')
    expect(instructions).toContain('files: [...]')
    expect(instructions).toContain('Low confidence')
    expect(instructions).toContain('Borderline')
    expect(instructions).toContain('行序已按阅读顺序重排')
    // 第三轮实测的两个前提修正：crop 是独立一票不能当验证器；det_limit 对被压缩截图反效果
    expect(instructions).toContain('独立一票')
    expect(instructions).toContain('不要拿单次裁剪重读当验证器')
    expect(instructions).toContain('被压缩过的截图')
    // tile 使用引导：竖长截图尺度依赖误读的根治路径
    expect(instructions).toContain('tile: true')
    expect(instructions).toContain('尺度依赖误读')
  })
})
