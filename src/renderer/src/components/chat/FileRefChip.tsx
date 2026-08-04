import React, { type ReactNode, useState, useEffect } from 'react'
import { Tooltip } from 'antd'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { CodeBlock } from './CodeBlock'
import { LocalImage, IMAGE_EXTS, getExt } from './LocalImage'

// Match [file:/path/to/file] or [folder:/path/to/folder], optionally with |timestamp
const FILE_REF_RE = /\[(file|folder):([^\]]+?)(?:\|([^\]]*))?\]/g

// Match markdown image syntax with file:// protocol: ![](file:///path) or ![](file://path)
const MD_IMAGE_FILE_RE = /!\[[^\]]*\]\(file:\/{1,3}([^)]+)\)/g

// Match markdown file links: [text](file:///path) or [text](file://path)
const MD_FILE_LINK_RE = /(?<!!)\[([^\]]*?)\]\(file:\/{1,3}([^)]+)\)/g

// Match markdown http/https links: [text](http://...) or [text](https://...)
// Optionally consumes a following [page_id: N] line and embeds it as a data attribute
// on the WebChip so it's not visible to the user but preserved for the LLM.
const MD_HTTP_LINK_RE = /(?<!!)\[([^\]]*?)\]\((https?:\/\/[^)]+)\)(?:\s*\[chrome:\s*pageId=(\d+)\])?/g

function getBaseName(path: string): string {
  return path.replace(/^.*[/\\]/, '') || path
}

function getFileExtension(path: string): string {
  // Cross-platform: find last segment after / or \
  const sep = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const basename = sep >= 0 ? path.slice(sep + 1) : path
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ''
}

/** Hash first 2 chars of extension → hue in [0, 360). */
function extToHue(ext: string): number {
  const s = ext.slice(0, 2)
  let hash = 0
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash) + s.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

function extToColor(ext: string): string {
  return `hsla(${extToHue(ext)}, 30%, 85%, 0.5)`
}

function openInOs(path: string): void {
  window.electronAPI.openFolder(path).catch(() => {
    // Fallback: ignore silently — file may not exist
  })
}

function openUrl(url: string): void {
  window.electronAPI.openExternal(url).catch(() => {})
}

function getDomain(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

// ── Pre-process: replace [file:...] / [folder:...] with <file-chip> HTML tags ──

/** Strip backticks / ** / * that wrap [file:...] or [folder:...] */
function unwrapRef(text: string): string {
  return text.replace(/(?:`+|_{0,2}\*{1,2})?(\[(?:file|folder):[^\]]+\])(?:`+|_{0,2}\*{1,2})?/g, '$1')
}

function preprocessText(text: string): string {
  const unwrapped = unwrapRef(text)

  // Step 1: convert ![](file://path) → <local-image> (images) or [file:path] (files)
  const withFileRefs = unwrapped.replace(MD_IMAGE_FILE_RE, (...args) => {
    const rawPath = args[1].trim()
    const ext = getExt(rawPath)
    const path = rawPath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(rawPath) ? rawPath : `/${rawPath}`
    if (ext && IMAGE_EXTS.has(ext)) {
      // Use custom <local-image> tag to bypass markdown parser's file:// filtering
      return `<local-image data-path="local-file://${path}"></local-image>`
    }
    return `[file:${path}]`
  })

  // Step 1.5: [text](file:///path) → file/folder chip (always, including images)
  const withMdLinks = withFileRefs.replace(MD_FILE_LINK_RE, (...args) => {
    const rawPath = args[2].trim()
    const path = rawPath.startsWith('/') || /^[A-Za-z]:[/\\]/.test(rawPath) ? rawPath : `/${rawPath}`
    const isFolder = !getFileExtension(path)
    return `[${isFolder ? 'folder' : 'file'}:${path}]`
  })

  // Step 1.6: [text](http(s)://url) → <web-chip> (WebChip for http/https links)
  const withWebLinks = withMdLinks.replace(MD_HTTP_LINK_RE, (...args) => {
    const label = args[1].trim()
    const url = args[2]
    const pageId = args[3]
    const domain = getDomain(url)
    const labelAttr = label.replace(/"/g, '&quot;')
    const urlAttr = url.replace(/"/g, '&quot;')
    const pageIdAttr = pageId ? ` data-page-id="${pageId}"` : ''
    return `<web-chip data-url="${urlAttr}" data-domain="${domain}" data-label="${labelAttr}"${pageIdAttr}>${labelAttr}</web-chip>`
  })

  // Step 2: existing [file:...] / [folder:...] → <file-chip> HTML
  return withWebLinks.replace(FILE_REF_RE, (...args) => {
    const type = args[1]
    const path = args[2]
    const time = args[3]
    const name = getBaseName(path)
    const nameAttr = name.replace(/"/g, '&quot;')
    const pathAttr = path.replace(/"/g, '&quot;')
    const ext = type === 'file' ? getFileExtension(path) : 'folder'
    const letter = type === 'file' && ext ? ext[0].toUpperCase() : 'F'
    const timeAttr = time ? ` data-time="${time}"` : ''
    return `<file-chip data-type="${type}" data-path="${pathAttr}" data-ext="${ext}" data-letter="${letter}"${timeAttr}>${nameAttr}</file-chip>`
  })
}

// ── React component for <file-chip> ──────────────────────────────────

export function FileChipComponent(attrs: Record<string, any>): React.ReactElement {
  const path = (attrs.dataPath || attrs['data-path'] || '') as string
  const ext = (attrs.dataExt || attrs['data-ext'] || '') as string
  const letter = (attrs.dataLetter || attrs['data-letter'] || 'F') as string
  const dataTime = (attrs.dataTime || attrs['data-time']) as string | undefined
  const [birthtime, setBirthtime] = useState<string | null>(null)

  // Fetch file birthtime
  useEffect(() => {
    if (!path) return
    window.electronAPI.getFileStat(path).then(stat => {
      if (stat?.birthtime) {
        const d = new Date(stat.birthtime)
        const t = d.toLocaleString(undefined, {
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit'
        })
        setBirthtime(t)
      }
    }).catch(() => {})
  }, [path])

  const letterColor = extToColor(ext)
  const hue = extToHue(ext)
  const bgGradient = `linear-gradient(to right, #ffffff, hsl(${hue}, 30%, 95%))`
  const hoverBgGradient = `linear-gradient(to right, #fafafa, hsl(${hue}, 25%, 92%))`
  const name = getBaseName(path)
  const timeText = birthtime || dataTime

  return (
    <Tooltip title={path}>
      <span
        onClick={() => openInOs(path)}
        style={{
          display: 'inline-flex',
          position: 'relative',
          width: 250,
          maxWidth: '100%',
          height: 80,
          borderRadius: 8,
          background: bgGradient,
          cursor: 'pointer',
          margin: '2px 4px',
          userSelect: 'none',
          verticalAlign: 'middle',
          transition: 'background 0.15s',
          border: '1px solid #E6E6E6'
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = hoverBgGradient }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = bgGradient }}
      >
        {/* Left side: filename + optional time */}
        <span style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          flex: 1,
          minWidth: 0,
          height: '100%',
          padding: '0 8px 0 12px',
          position: 'relative',
          zIndex: 2
        }}>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: 900,
            color: '#000000'
          }}>
            {name}
          </span>
          {timeText && (
            <span style={{
              fontSize: 11,
              color: '#999',
              marginTop: 2
            }}>
              {timeText}
            </span>
          )}
        </span>
        {/* Letter: bottom-right aligned */}
        <span style={{
          position: 'absolute',
          right: 8,
          bottom: 4,
          fontSize: 56,
          fontWeight: 900,
          color: letterColor,
          lineHeight: 1,
          fontFamily: 'monospace',
          transform: 'rotate(20deg) scaleX(1.2)',
          zIndex: 1,
        }}>
          {letter}
        </span>
      </span>
    </Tooltip>
  )
}

// ── React component for <web-chip> ────────────────────────────────────

function WebChip(attrs: Record<string, any>): React.ReactElement {
  const url = (attrs.dataUrl || attrs['data-url'] || '') as string
  const domain = (attrs.dataDomain || attrs['data-domain'] || '') as string
  const label = (attrs.dataLabel || attrs['data-label'] || '') as string
  const letter = 'W'
  const letterColor = extToColor('web')
  const hue = extToHue('web')
  const bgGradient = `linear-gradient(to right, #ffffff, hsl(${hue}, 30%, 95%))`
  const hoverBgGradient = `linear-gradient(to right, #fafafa, hsl(${hue}, 25%, 92%))`

  return (
    <Tooltip title={url}>
      <span
        onClick={() => openUrl(url)}
        style={{
          display: 'inline-flex',
          position: 'relative',
          width: 250,
          maxWidth: '100%',
          height: 80,
          borderRadius: 8,
          background: bgGradient,
          cursor: 'pointer',
          margin: '2px 4px',
          userSelect: 'none',
          verticalAlign: 'middle',
          transition: 'background 0.15s',
          border: '1px solid #E6E6E6'
        }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = hoverBgGradient }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = bgGradient }}
      >
        <span style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          flex: 1,
          minWidth: 0,
          height: '100%',
          padding: '0 8px 0 12px',
          position: 'relative',
          zIndex: 2
        }}>
          <span style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 13,
            fontWeight: 900,
            color: '#000000'
          }}>
            {domain}
          </span>
          {label && label !== domain && (
            <span style={{
              fontSize: 11,
              color: '#999',
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}>
              {label}
            </span>
          )}
        </span>
        <span style={{
          position: 'absolute',
          right: 8,
          bottom: 4,
          fontSize: 56,
          fontWeight: 900,
          color: letterColor,
          lineHeight: 1,
          fontFamily: 'monospace',
          transform: 'rotate(20deg) scaleX(1.2)',
          zIndex: 1,
        }}>
          {letter}
        </span>
      </span>
    </Tooltip>
  )
}

// ── XMarkdown components map (includes file-chip) ─────────────────────

const XMD_COMPONENTS: Record<string, React.ComponentType<any>> = {
  code: CodeBlock,
  img: LocalImage,
  'file-chip': FileChipComponent,
  'local-image': LocalImage,
  'web-chip': WebChip,
}

const XMD_CONFIG = { extensions: Latex() }

// ── FileRefChip ───────────────────────────────────────────────────────

interface FileRefChipProps {
  text: string
  /** Optional renderer for plain text (no file refs). Defaults to XMarkdown. */
  textRenderer?: (text: string) => ReactNode
  /** Extra style forwarded to the internal XMarkdown root div. */
  xmarkdownStyle?: React.CSSProperties
}

export function FileRefChip({ text, textRenderer, xmarkdownStyle }: FileRefChipProps): React.ReactElement {
  // Check if text contains any file/folder references or ![](file://...) patterns
  FILE_REF_RE.lastIndex = 0
  MD_IMAGE_FILE_RE.lastIndex = 0
  MD_FILE_LINK_RE.lastIndex = 0
  MD_HTTP_LINK_RE.lastIndex = 0
  const hasRefs = FILE_REF_RE.test(text) || MD_IMAGE_FILE_RE.test(text) || MD_FILE_LINK_RE.test(text) || MD_HTTP_LINK_RE.test(text)

  // No refs — render as before
  if (!hasRefs) {
    return textRenderer ? <>{textRenderer(text)}</> : <span style={{ whiteSpace: 'pre-wrap' }}>{text}</span>
  }

  // Has refs — pre-process text and render through XMarkdown with file-chip component
  const html = preprocessText(text)
  return (
    <XMarkdown
      content={html}
      components={XMD_COMPONENTS}
      config={XMD_CONFIG}
      style={xmarkdownStyle}
    />
  )
}
