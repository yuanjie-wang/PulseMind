// ── Helper: save screenshot images from MCP results to ~/.pulsemind/tmp/screenshot/ ──

function isBase64Image(s: string): boolean {
  return s.length > 1000 && (s.startsWith('/9j/') || s.startsWith('iVBOR') || s.startsWith('UklGR'))
}

/** Find absolute paths ending with image extensions in a string. Supports both Unix and Windows paths. */
const IMAGE_PATH_RE = /((?:[A-Za-z]:)?[\/\\][^\s"'`,\]}]+\.(?:png|jpg|jpeg|webp|gif))/gi

export async function saveImagesInText(text: string): Promise<string> {
  // 1. Save any base64 images
  const base64Result = await saveBase64Images(text)
  // 2. Find all absolute image file paths and copy them
  const paths = new Set<string>()
  let m: RegExpExecArray | null
  const re = new RegExp(IMAGE_PATH_RE.source, 'gi')
  while ((m = re.exec(base64Result)) !== null) paths.add(m[1])
  if (paths.size === 0) return base64Result

  const replacements = new Map<string, string>()
  await Promise.all(Array.from(paths).map(async (p) => {
    const r = await window.electronAPI.copyFileToTmp(p)
    if (r.success) replacements.set(p, r.path)
  }))

  let result = base64Result
  for (const [oldPath, newPath] of replacements) {
    result = result.replaceAll(oldPath, newPath)
  }
  return result
}

export async function saveBase64Images(text: string): Promise<string> {
  // Match quoted base64 image strings (JPEG /9j/, PNG iVBOR, WebP UklGR)
  const BASE64_IMG_RE = /"(?:\/9j\/[A-Za-z0-9+/=]{100,}|iVBOR[A-Za-z0-9+/=]{100,}|UklGR[A-Za-z0-9+/=]{100,})"/g
  let result = text
  let m: RegExpExecArray | null
  const re = new RegExp(BASE64_IMG_RE.source, 'g')
  const toReplace: Array<{ from: string; to: string }> = []
  while ((m = re.exec(text)) !== null) {
    const data = m[0].slice(1, -1) // strip surrounding quotes
    const r = await window.electronAPI.saveBase64Image(data)
    if (r.success) {
      const displayPath = r.path.replace(/\\/g, '/')
      toReplace.push({ from: m[0], to: `"${displayPath}"` })
    }
  }
  for (const { from, to } of toReplace) {
    result = result.replaceAll(from, to)
  }
  return result
}

export function stripImageData(obj: unknown): unknown {
  if (typeof obj === 'string') {
    if (isBase64Image(obj)) return `[Image data stripped: ${Math.round(obj.length / 1024)} KB]`
    return obj
  }
  if (Array.isArray(obj)) return obj.map(stripImageData)
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) result[key] = stripImageData(value)
    return result
  }
  return obj
}
