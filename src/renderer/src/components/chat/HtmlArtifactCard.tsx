/**
 * The HTML artifact card (2026-09-23): a ```html fence in an assistant message
 * renders here instead of the code highlighter — the Doubao-pattern visual aid
 * (model emits a self-contained static HTML fragment; the chat shows it as an
 * inline sandboxed preview card with the source one tab away). The dispatch
 * lives in CodeBlock (`isHtmlFenceLang`), which every XMarkdown site in the
 * chat shares, so streaming, settled history and the TranscriptView reuses
 * (experts, tool studio, run records) all get the card without per-view wiring.
 *
 * Isolation is the security model, deliberately stronger than canvas's
 * RectFrame: the `sandbox` carries no same-origin flag, so the fragment gets
 * an opaque origin — no localStorage, no cookies, no access to `window.
 * electronAPI` or the app DOM. Scripts and forms still run (the cards are
 * meant to be interactive); the srcdoc document inherits the renderer CSP,
 * whose `script-src 'unsafe-inline'` is what lets the model's inline JS run
 * at all. `allow-popups` without `-to-escape` keeps any popup it opens
 * sandboxed too.
 *
 * Streaming: x-markdown emits the code token for an UNTERMINATED fence
 * (`streamStatus: 'loading'`), so the card can live-preview while the model
 * writes. Each srcDoc change reloads the whole frame, so during the stream
 * the snapshot advances at most every STREAM_PREVIEW_MIN_INTERVAL (the same
 * throttle shape StreamingText uses for the parse; feed() is idempotent, so
 * calling it during render is safe under StrictMode). `streaming=false` is
 * the settled render — the full text, once.
 *
 * Height: fragments are wrapped in a shell that reports its scrollHeight via
 * postMessage (load + resize + ResizeObserver); the card clamps it to
 * [CARD_MIN_HEIGHT, CARD_MAX_HEIGHT] and lets the frame scroll past the cap.
 * A full document (the model emitted `<!doctype html>`/`<html>`) is used
 * verbatim — it gets no measure script and rides the default height with
 * internal scrolling, which is what a page-shaped artifact wants anyway.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import { ChromeOutlined, CopyOutlined, ExpandOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { createTextThrottle } from './stream-throttle'
import { openInPreviewPane } from '../../stores/previewPaneStore'

const CARD_MIN_HEIGHT = 120
const CARD_MAX_HEIGHT = 480
const CARD_DEFAULT_HEIGHT = 280
const STREAM_PREVIEW_MIN_INTERVAL = 1000

/** A full HTML document the model wrote as a page, not a fragment. */
const FULL_DOCUMENT = /<!doctype html|<html[\s>]/i

/** The fence's language field selects the card: `html`, case-insensitive, and
 *  an info string's leading word (`html hl_lines` etc.) — mirroring how
 *  resolveCodeLang ignores fence parameters. */
export function isHtmlFenceLang(lang: string | undefined): boolean {
  return lang?.trim().toLowerCase().split(/\s+/)[0] === 'html'
}

/** FNV-1a + length suffix: a stable, collision-unlikely-enough file stem so
 *  re-opening the same card reuses its tmp copy instead of accumulating. */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}-${text.length.toString(16)}`
}

/** The script a FRAGMENT gets wrapped with: reports the document's scrollHeight
 *  to the card (message type is namespaced and source-checked card-side, so a
 *  hostile fragment can only move the card it lives in). */
const MEASURE_SCRIPT = `<script>(function(){var s=function(){try{parent.postMessage({type:'pm-html-card-height',height:Math.ceil(document.documentElement.scrollHeight)},'*')}catch(e){}};window.addEventListener('load',s);document.addEventListener('DOMContentLoaded',s);window.addEventListener('resize',s);if('ResizeObserver' in window){new ResizeObserver(s).observe(document.documentElement)}s()})()</script>`

/** Build the srcDoc. Fragments get a zero-margin shell + the measure script;
 *  full documents pass through byte-identical (no injection into a page the
 *  model authored whole). */
export function buildCardDocument(code: string): string {
  if (FULL_DOCUMENT.test(code)) return code
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<style>html,body{margin:0;padding:0}</style></head><body>',
    code,
    MEASURE_SCRIPT,
    '</body></html>',
  ].join('')
}

async function persistCardCopy(code: string): Promise<string | null> {
  try {
    const paths = await window.electronAPI.getDataPaths()
    // Renderer-layer writes carry no session context, so the guard applies
    // only the baseline deny roots — the app's own data dir stays writable.
    const filePath = `${paths.dataDir}/tmp/html-cards/${hashText(code)}.html`
    const res = await window.electronAPI.writeFile({ filePath, content: code })
    return res.success ? filePath : null
  } catch {
    return null
  }
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        border: 'none',
        cursor: 'pointer',
        padding: '3px 8px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: '16px',
        color: active ? 'var(--pm-text-strong)' : 'var(--pm-text-muted)',
        background: active ? 'var(--pm-hover-weak)' : 'transparent',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}

export function HtmlArtifactCard({ code, streaming }: { code: string; streaming: boolean }): React.ReactElement {
  const { t } = useTranslation()
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const [bodyHeight, setBodyHeight] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The streaming snapshot: see the header comment. Replacing srcDoc reloads
  // the frame, so freshness is quantized instead of chasing every parse tick —
  // the throttle is fed in an effect (purity rule: no ref reads / clocks in
  // render) and `shown` only advances when feed() hands out a new snapshot;
  // identical state bails the re-render out.
  const throttleRef = useRef<ReturnType<typeof createTextThrottle>>(createTextThrottle(STREAM_PREVIEW_MIN_INTERVAL))
  const [shown, setShown] = useState(code)
  /* eslint-disable react-hooks/set-state-in-effect -- quantizes the streamed fragment for the iframe; identical snapshots bail out, no cascading renders */
  useEffect(() => {
    if (!streaming) {
      setShown(code)
      return
    }
    setShown(throttleRef.current.feed(code, performance.now()))
  }, [code, streaming])
  /* eslint-enable react-hooks/set-state-in-effect */
  const doc = useMemo(() => buildCardDocument(shown), [shown])

  useEffect(() => {
    function onMessage(e: MessageEvent): void {
      if (e.source !== iframeRef.current?.contentWindow) return
      const data = e.data as { type?: string; height?: number } | null
      if (data?.type === 'pm-html-card-height' && typeof data.height === 'number') {
        setBodyHeight(Math.min(CARD_MAX_HEIGHT, Math.max(CARD_MIN_HEIGHT, data.height)))
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  const onCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500)
    } catch (err) {
      console.warn('[HtmlArtifactCard] copy failed', err)
    }
  }

  const onOpenInBrowser = async (): Promise<void> => {
    const filePath = await persistCardCopy(code)
    if (!filePath) return
    // Windows file: URIs are file:///C:/… — the same conversion the canvas
    // export does (file-ops.ts svcCopyFile).
    void window.electronAPI.openExternal(`file:///${filePath.replace(/\\/g, '/')}`)
  }

  const onOpenInPreview = async (): Promise<void> => {
    const filePath = await persistCardCopy(code)
    if (filePath) openInPreviewPane(filePath)
  }

  return (
    <div
      data-html-artifact-card=""
      style={{
        margin: '8px 0',
        border: '1px solid var(--pm-border-soft)',
        borderRadius: 10,
        background: 'var(--pm-tile-bg, var(--pm-code-bg))',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          borderBottom: '1px solid var(--pm-border-soft)',
          userSelect: 'none',
        }}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, stroke: 'var(--pm-text-secondary)' }}
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--pm-text-strong)' }}>{t('htmlCard.title')}</span>
        {streaming && <span style={{ fontSize: 11, color: 'var(--pm-text-muted)' }}>{t('htmlCard.streaming')}</span>}
        <span style={{ flex: 1 }} />
        <TabButton active={view === 'preview'} onClick={() => setView('preview')}>
          {t('htmlCard.preview')}
        </TabButton>
        <TabButton active={view === 'code'} onClick={() => setView('code')}>
          {t('htmlCard.code')}
        </TabButton>
        <span style={{ width: 1, height: 14, background: 'var(--pm-border-soft)' }} />
        <Button size="small" type="text" icon={<CopyOutlined />} title={copied ? t('htmlCard.copied') : t('htmlCard.copy')} onClick={() => void onCopy()} />
        <Button size="small" type="text" icon={<ChromeOutlined />} title={t('htmlCard.openInBrowser')} onClick={() => void onOpenInBrowser()} />
        <Button size="small" type="text" icon={<ExpandOutlined />} title={t('htmlCard.openInPreview')} onClick={() => void onOpenInPreview()} />
      </div>
      {view === 'preview' ? (
        // Opaque-origin sandbox: see the header comment. `#fff` matches
        // HtmlPreview — card content is designed light regardless of theme.
        <iframe
          ref={iframeRef}
          title={t('htmlCard.title')}
          sandbox="allow-scripts allow-popups allow-forms allow-modals"
          srcDoc={doc}
          style={{
            display: 'block',
            width: '100%',
            height: bodyHeight ?? CARD_DEFAULT_HEIGHT,
            border: 'none',
            background: '#fff',
          }}
        />
      ) : (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'var(--pm-code-bg)',
            color: 'var(--pm-text-body)',
            fontSize: 12.5,
            lineHeight: 1.55,
            maxHeight: CARD_MAX_HEIGHT,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {code}
        </pre>
      )}
    </div>
  )
}
