/**
 * 图片文本提取器：把 OCR 接进统一提取链（storage/extractors）。
 *
 * 存在的意义是补盲区——在注册它之前，仓库对 .png/.jpg 根本没有提取器，
 * 落到 tryMarkitdown 后拿不到可用文本；扫描件合同、手机拍的票据、代码截图
 * 全都在这里断掉。
 */

import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type { ExtractionResult } from './index'

/** 超过这个体积基本是照片/原图，OCR 的成本（+126~235MB RSS）不划算 */
export const MAX_OCR_BYTES = 30 * 1024 * 1024

export const IMAGE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.tif',
  '.tiff'
]

function frontmatter (title: string, filePath: string, extra: Record<string, string | number> = {}): string {
  const lines = [
    '---',
    `title: "${title.replace(/"/g, '\\"')}"`,
    `source: "${filePath.replace(/"/g, '\\"')}"`,
    `extracted: "${new Date().toISOString()}"`,
    'ocr: "pp-ocrv4"'
  ]
  for (const [k, v] of Object.entries(extra)) lines.push(`${k}: ${typeof v === 'string' ? `"${v}"` : v}`)
  lines.push('---\n')
  return lines.join('\n')
}

export async function extractImage (filePath: string): Promise<ExtractionResult> {
  const title = basename(filePath).replace(/\.[^.]+$/, '')

  let size = 0
  try {
    size = statSync(filePath).size
  } catch {
    /* 交给下游 OCR 报错，这里只做体积判断 */
  }
  if (size > MAX_OCR_BYTES) {
    throw new Error(
      `Image "${basename(filePath)}" is ${(size / 1024 / 1024).toFixed(1)}MB, over the OCR limit of ${MAX_OCR_BYTES / 1024 / 1024}MB.`
    )
  }

  const { recognizeImage } = await import('../../services/ocr')
  const result = await recognizeImage(filePath)

  const body = result.text.trim()
  const extra: Record<string, string | number> = {
    width: result.width,
    height: result.height,
    lines: result.lines.length
  }
  if (result.lines.length) {
    // 最低行置信度：保留行的最低分，调用方可用它做质量门禁
    extra.minScore = Math.min(...result.lines.map(l => l.score)).toFixed(3)
  }
  if (result.dropped.length) {
    // 被当作界面碎片丢掉的行数，出问题时可据此判断是否误杀
    extra.dropped = result.dropped.length
  }

  return {
    title,
    content:
      frontmatter(title, filePath, extra) +
      (body || '_图片中未检测到文字_')
  }
}
