import { basename } from 'node:path'
import { MarkItDown } from 'markitdown-js'
import type { ExtractionResult } from './index'

let _md: MarkItDown | null = null
function getConverter(): MarkItDown {
  if (!_md) _md = new MarkItDown()
  return _md
}

function frontmatter(title: string, filePath: string, extra: Record<string, string | number> = {}): string {
  const lines = ['---', `title: "${title.replace(/"/g, '\\"')}"`, `source: "${filePath.replace(/"/g, '\\"')}"`, `extracted: "${new Date().toISOString()}"`]
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k}: ${v}`)
  }
  lines.push('---\n')
  return lines.join('\n')
}

export async function extractWithMarkitdown(filePath: string, includeFrontmatter = true): Promise<ExtractionResult | null> {
  const title = basename(filePath).replace(/\.[^.]+$/, '')
  const md = getConverter()

  const result = await md.convert(filePath)
  if (!result || !result.textContent) return null

  return {
    title,
    content: includeFrontmatter ? frontmatter(title, filePath) + result.textContent : result.textContent,
  }
}

/** Check if `markitdown-js` supports a given file extension. */
export function isExtensionSupported(ext: string): boolean {
  // markitdown-js handles these internally
  return [
    '.txt', '.md', '.csv',
    '.html', '.htm',
    '.pdf',
    '.docx',
    '.pptx',
    '.xlsx', '.xls',
    '.xml',
    '.json',
    '.epub',
    '.zip',
    '.msg',
    '.rss', '.atom',
    '.ipynb',
  ].includes(ext)
}
