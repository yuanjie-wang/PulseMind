import React, { useState } from 'react'
import { createPortal } from 'react-dom'
import { ImageViewer } from './ImageViewer'

export const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

export function getExt(filePath: string): string | null {
  const q = filePath.indexOf('?')
  const h = filePath.indexOf('#')
  const clean = q >= 0 ? filePath.slice(0, q) : h >= 0 ? filePath.slice(0, h) : filePath
  // Cross-platform: find last segment after / or \
  const sep = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
  const basename = sep >= 0 ? clean.slice(sep + 1) : clean
  const dot = basename.lastIndexOf('.')
  return dot > 0 && dot < basename.length - 1 ? basename.slice(dot + 1).toLowerCase() : null
}

export function LocalImage(props: React.ImgHTMLAttributes<HTMLImageElement> & Record<string, unknown>): React.ReactElement {
  const { src, children, domNode, streamStatus, ...rest } = props
  const [viewerOpen, setViewerOpen] = useState(false)

  // Handle both <img src="..."> (from XMarkdown) and <local-image data-path="..."> (from FileRefChip)
  const filePath = src || (rest.dataPath as string) || (rest['data-path'] as string) || ''

  // Map ~/.pulsemind/tmp/ paths to local-file:// protocol, also handle file://
  // Matches both /.pulsemind/tmp/xxx, /Users/xxx/.pulsemind/tmp/xxx,
  // and Windows C:\Users\xxx\.pulsemind\tmp\xxx
  let resolvedSrc = filePath
  if (resolvedSrc && /[\/\\]\.pulsemind[\/\\]tmp[\/\\]/.test(resolvedSrc)) {
    if (!resolvedSrc.startsWith('local-file://')) {
      resolvedSrc = `local-file://${resolvedSrc.replace(/\\/g, '/')}`
    }
  } else if (resolvedSrc?.startsWith('file:')) {
    resolvedSrc = resolvedSrc.replace(/^file:\/{1,3}/, 'local-file:///')
  }

  return (
    <>
      <img
        {...rest}
        src={resolvedSrc}
        style={{
          ...(rest.style || {}),
          maxWidth: '100%',
          maxHeight: '50vh',
          border: '1px solid #e0e0e0',
          borderRadius: '4px',
          cursor: 'pointer',
          transition: 'opacity 0.15s'
        }}
        onClick={() => setViewerOpen(true)}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.85' }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = '1' }}
      />
      {viewerOpen && resolvedSrc && createPortal(
        <ImageViewer src={resolvedSrc} onClose={() => setViewerOpen(false)} />,
        document.body
      )}
    </>
  )
}
