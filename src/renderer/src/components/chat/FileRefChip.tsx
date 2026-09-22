import React, { type ReactNode, useState, useEffect } from 'react'
import { Tooltip } from 'antd'
import { XMarkdown } from '@ant-design/x-markdown'
import Latex from '@ant-design/x-markdown/plugins/Latex'
import { CodeBlock } from './CodeBlock'
import { LocalImage, IMAGE_EXTS, getExt } from './LocalImage'
import { stringToHue } from '../../../../shared/hash-color'
import { openInPreviewPane } from '../../stores/previewPaneStore'

// Match [file:/path/to/file] or [folder:/path/to/folder], optionally with |timestamp
const FILE_REF_RE = /\[(file|folder):([^\]]+?)(?:\|([^\]]*))?\]/g

// Match markdown image syntax with file:// protocol: ![](file:///path) or ![](file://path)
const MD_IMAGE_FILE_RE = /!\[[^\]]*\]\(file:\/{1,3}([^)]+)\)/g

// Match markdown file links: [text](file:///path) or [text](file://path)
const MD_FILE_LINK_RE = /(?<!!)\[([^\]]*?)\]\(file:\/{1,3}([^)]+)\)/g

// Match markdown http/https links: [text](http://...) or [text](https://...)
const MD_HTTP_LINK_RE = /(?<!!)\[([^\]]*?)\]\((https?:\/\/[^)]+)\)/g

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
  return stringToHue(ext.slice(0, 2))
}

/** The chip's watermark letter: the extension's hue, muted. Lightness and alpha
 *  ride the sheet (`--pm-chip-letter-*`) so the same hue reads as a watermark on
 *  white and on a dark card; the hue itself is data and stays here. */
function extToColor(ext: string): string {
  return `hsla(${extToHue(ext)}, 30%, var(--pm-chip-letter-l), var(--pm-chip-letter-a))`
}

/** The chip's paper, tinted by the extension's hue: white → the hue at 95% in
 *  light, the card grey → the hue at 16% in dark. Only the hue and the two
 *  saturations live here — everything a mode flip moves is in the sheet, which
 *  is why neither chip needs to subscribe to the mode. */
function chipGradients(hue: number): { bg: string; hover: string } {
  return {
    bg: `linear-gradient(to right, var(--pm-chip-from), hsl(${hue}, 30%, var(--pm-chip-tint-l)))`,
    hover: `linear-gradient(to right, var(--pm-chip-from-hover), hsl(${hue}, 25%, var(--pm-chip-tint-l-hover)))`,
  }
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

/** Exported for the preview pane's markdown renderer — same chip pipeline. */
export function preprocessText(text: string): string {  const unwrapped = unwrapRef(text)

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
    const domain = getDomain(url)
    const labelAttr = label.replace(/"/g, '&quot;')
    const urlAttr = url.replace(/"/g, '&quot;')
    return `<web-chip data-url="${urlAttr}" data-domain="${domain}" data-label="${labelAttr}">${labelAttr}</web-chip>`
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
  const dataType = (attrs.dataType || attrs['data-type'] || 'file') as string
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
  const { bg: bgGradient, hover: hoverBgGradient } = chipGradients(extToHue(ext))
  const name = getBaseName(path)
  const timeText = birthtime || dataTime

  return (
    <Tooltip title={path}>
      <span
        onClick={() => {
          // Files open the in-app preview pane (PLAN-preview-pane); folders
          // still go to the system file manager.
          if (dataType === 'folder') openInOs(path)
          else openInPreviewPane(path)
        }}
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
          border: '1px solid var(--pm-chip-border)'
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
            color: 'var(--pm-ink)'
          }}>
            {name}
          </span>
          {timeText && (
            <span style={{
              fontSize: 11,
              color: 'var(--pm-text-muted)',
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
  const { bg: bgGradient, hover: hoverBgGradient } = chipGradients(extToHue('web'))

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
          border: '1px solid var(--pm-chip-border)'
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
            color: 'var(--pm-ink)'
          }}>
            {domain}
          </span>
          {label && label !== domain && (
            <span style={{
              fontSize: 11,
              color: 'var(--pm-text-muted)',
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
  /** Marked config forwarded to the internal XMarkdown; defaults to XMD_CONFIG. */
  config?: React.ComponentProps<typeof XMarkdown>['config']
}

export function FileRefChip({ text, textRenderer, xmarkdownStyle, config = XMD_CONFIG }: FileRefChipProps): React.ReactElement {
  // Check if text contains any file/folder references or ![](file://...) patterns.
  // Use match() instead of test(): with the global flag, test() carries lastIndex
  // state between calls, whereas match() always starts from index 0.
  const hasRefs = !!text.match(FILE_REF_RE) || !!text.match(MD_IMAGE_FILE_RE) || !!text.match(MD_FILE_LINK_RE) || !!text.match(MD_HTTP_LINK_RE)

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
      config={config}
      style={xmarkdownStyle}
    />
  )
}
