import { basename } from 'node:path'
import type { ExtractionResult } from './index'

export function extractText(filePath: string, buffer: Buffer): ExtractionResult {
  const title = basename(filePath).replace(/\.[^.]+$/, '')
  return {
    title,
    content: buffer.toString('utf-8')
  }
}
