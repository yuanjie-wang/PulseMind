import { extname, basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { extractText } from './text-extractor'
import { extractWithMarkitdown, isExtensionSupported } from './markitdown-extractor'

export interface ExtractionResult {
  title: string
  content: string
}

type Extractor = (filePath: string, buffer: Buffer) => ExtractionResult | Promise<ExtractionResult>

const registry = new Map<string, Extractor>()

export function registerExtractor(extensions: string[], extractor: Extractor): void {
  for (const ext of extensions) {
    registry.set(ext, extractor)
  }
}

// Register built-in extractors
registerExtractor(['.txt', '.md'], (fp, buf) => extractText(fp, buf))
registerExtractor(['.html', '.htm'], async (fp, buf) => {
  const { extractHtml } = await import('./html-extractor')
  return extractHtml(fp, buf)
})
// Plain-text formats (code files, data files, logs)
registerExtractor([
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.log', '.out',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.py', '.java', '.rs', '.go', '.rb', '.php', '.swift', '.kt',
  '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx',
  '.cs', '.fs', '.scala', '.clj', '.elm',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.css', '.scss', '.less', '.sass',
  '.sql', '.graphql', '.gql',
  '.r', '.m', '.mm', '.pl', '.pm', '.lua', '.dart',
  '.zig', '.nim', '.ex', '.exs',
  '.makefile', '.cmake',
  '.dockerfile',
  '.terraform', '.tf',
  '.patch', '.diff'
], (fp, buf) => extractText(fp, buf))

// Images → OCR (PP-OCRv4). Lazily imported: the model load costs ~650ms and
// +126~235MB RSS, so it must never run on the import path. Before this
// registration .png/.jpg had no extractor at all — scanned contracts, phone
// photos of receipts and code screenshots fell through to tryMarkitdown and
// produced nothing.
registerExtractor(
  ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.tif', '.tiff'],
  async fp => {
    const { extractImage } = await import('./ocr-extractor')
    return extractImage(fp)
  }
)

/** Detect whether buffer starts with HTML markup */
function isHtml(buffer: Buffer): boolean {
  const head = buffer.slice(0, 100).toString('utf-8').trimStart()
  return head.startsWith('<!doctype html>') ||
         head.startsWith('<html') ||
         head.startsWith('<head') ||
         head.startsWith('<!DOCTYPE html>')
}

/** Detect whether buffer starts with PDF magic bytes (%PDF) */
function isPdf(buffer: Buffer): boolean {
  return buffer.slice(0, 4).toString() === '%PDF'
}

/** Try markitdown-js for a given file path, returning null if unsupported. */
async function tryMarkitdown(filePath: string): Promise<ExtractionResult | null> {
  const ext = extname(filePath).toLowerCase()
  if (!isExtensionSupported(ext)) return null
  return extractWithMarkitdown(filePath)
}

export async function extractFile(filePath: string): Promise<ExtractionResult> {
  const ext = extname(filePath).toLowerCase()
  const buffer = readFileSync(filePath)

  // Markitdown handles: pdf, docx, pptx, xlsx, csv, xml, epub, ipynb, zip, msg, rss
  if (['.pdf', '.docx', '.pptx', '.xlsx', '.xls', '.csv', '.xml', '.epub', '.ipynb', '.zip', '.msg'].includes(ext)) {
    // Magic-byte verification: .pdf that's actually HTML → use HTML extractor
    if (ext === '.pdf' && !isPdf(buffer)) {
      if (isHtml(buffer)) {
        const { extractHtml } = await import('./html-extractor')
        return extractHtml(filePath, buffer)
      }
      throw new Error(`File "${basename(filePath)}" has .pdf extension but is not a valid PDF file.`)
    }

    const result = await tryMarkitdown(filePath)
    if (result) return result
    throw new Error(`Failed to extract content from "${basename(filePath)}"`)
  }

  // Text/markdown and HTML use their dedicated extractors
  const extractor = registry.get(ext)
  if (!extractor) {
    // Last resort: try markitdown for anything else it might support
    const result = await tryMarkitdown(filePath)
    if (result) return result
    throw new Error(`Unsupported file format: ${ext}`)
  }
  return extractor(filePath, buffer)
}

/** Derive a human-readable title from the file path */
export function deriveTitle(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, '')
}
