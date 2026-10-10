/** The panel's mirror of the desktop's HtmlArtifactCard (components/chat):
 *  a ```html fence is a deliverable to preview, not code to read — the model
 *  emits a self-contained static HTML fragment (the system prompt teaches
 *  exactly that) and both surfaces show it as an inline sandboxed preview card
 *  with the source one tab away. The dispatch (splitHtmlFences in
 *  ui/markdown.ts) feeds this component from MarkdownBlock.
 *
 * What is mirrored value-for-value: the opaque-origin sandbox flags, the frame
 * document (buildCardDocument from shared/preview/html-inject — the same
 * fragment shell, full-document pass-through, meta-CSP strip and height
 * reporter), the height clamp [120, 800] driven by postMessage with a source
 * check, the 1s streaming-snapshot quantization, and the hover chrome —
 * JS-driven (mouseenter/leave + leave-grace), NOT :hover: the pointer over
 * the iframe belongs to the frame's document, so a CSS hover gate on the card
 * drops the toolbar the moment the pointer crosses onto the preview; the
 * outside toolbar flips to the inside corners when a scrolling ancestor (the
 * transcript scroller) leaves it no headroom.
 *
 * What is deliberately different: the frame rides `srcdoc` — the desktop's
 * `local-file:` URL is the app's own protocol and does not exist in a web
 * page, so a page with a strict CSP will refuse the fragment's inline scripts
 * (preview goes static, height falls back to the default; the sandbox keeps
 * it contained either way). The toolbar carries 预览/源码 + 复制 only — 在浏览器
 * 打开 / 预览面板 are desktop capabilities (electronAPI), the same reason the
 * action row here is the viewOnly variant. Strings are the desktop's own zh
 * values (i18n/locales/zh.ts htmlCard); the toolbar palette literals are the
 * light-theme resolutions of the desktop's vars (palette.ts: --pm-tile-bg
 * #fafbfc, --pm-border-soft #e8e8e8, --pm-text-strong #333, --pm-text-muted
 * #999). */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildCardDocument } from '../../shared/preview/html-inject'
import { Icon } from './icons'

const CARD_MIN_HEIGHT = 120
const CARD_MAX_HEIGHT = 800
const CARD_DEFAULT_HEIGHT = 280
const STREAM_PREVIEW_MIN_INTERVAL = 1000
const CHROME_LEAVE_GRACE_MS = 150
const CHROME_FLIP_HEADROOM_PX = 48

/** Clipboard write with the textarea fallback (pages that deny the async API
 *  to an unfocused content script). Same shape as MessageBlocks' copyText. */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      ;(document.body ?? document.documentElement).appendChild(area)
      area.select()
      const ok = document.execCommand('copy')
      area.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function HtmlArtifactCard({ code, streaming }: { code: string; streaming: boolean }): React.JSX.Element {
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const [bodyHeight, setBodyHeight] = useState<number | null>(null)
  const [copied, setCopied] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const copiedTimerRef = useRef<number | null>(null)

  // Hover chrome with a leave-grace, JS-driven — see the header comment. The
  // flip check walks the shadow-tree ancestors exactly like the desktop's:
  // every scrolling/clipping ancestor's top edge cuts an outside toolbar
  // crossing it.
  const [chromeOn, setChromeOn] = useState(false)
  const [chromeFlipped, setChromeFlipped] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chromeTimerRef = useRef<number | null>(null)
  const measureChromeFlip = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    let limit = 0
    let node: HTMLElement | null = root.parentElement
    while (node) {
      if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(node).overflowY)) {
        limit = Math.max(limit, node.getBoundingClientRect().top + node.clientTop)
      }
      node = node.parentElement
    }
    setChromeFlipped(root.getBoundingClientRect().top - limit < CHROME_FLIP_HEADROOM_PX)
  }, [])
  const chromeEnter = useCallback(() => {
    if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = null
    measureChromeFlip()
    setChromeOn(true)
  }, [measureChromeFlip])
  const chromeLeave = useCallback(() => {
    if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = window.setTimeout(() => setChromeOn(false), CHROME_LEAVE_GRACE_MS)
  }, [])
  // Scroll events don't bubble and the scroller is an ancestor; capture phase.
  useEffect(() => {
    if (!chromeOn) return
    window.addEventListener('scroll', measureChromeFlip, true)
    window.addEventListener('resize', measureChromeFlip)
    return () => {
      window.removeEventListener('scroll', measureChromeFlip, true)
      window.removeEventListener('resize', measureChromeFlip)
    }
  }, [chromeOn, measureChromeFlip])
  useEffect(
    () => () => {
      if (chromeTimerRef.current !== null) window.clearTimeout(chromeTimerRef.current)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    },
    [],
  )

  // The streaming snapshot: every srcdoc swap reloads the frame, so during the
  // stream the preview advances at most once a second; the settled render is
  // the full text, once.
  const lastSwapRef = useRef({ text: '', at: 0 })
  const [shown, setShown] = useState(code)
  useEffect(() => {
    if (!streaming) {
      setShown(code)
      return
    }
    const last = lastSwapRef.current
    if (code === last.text) return
    const now = performance.now()
    if (now - last.at >= STREAM_PREVIEW_MIN_INTERVAL) {
      lastSwapRef.current = { text: code, at: now }
      setShown(code)
    }
  }, [code, streaming])
  const doc = useMemo(() => buildCardDocument(shown), [shown])

  // Height reporting. The content script listens on the page's window — the
  // frame posts to `parent` — and the source check keeps a hostile page (or a
  // hostile fragment elsewhere on it) from moving this card.
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

  const onCopy = (): void => {
    void copyToClipboard(code).then((ok) => {
      if (!ok) return
      setCopied(true)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div
      ref={rootRef}
      data-html-artifact-card=""
      className={`pm-html-card${chromeOn ? ' pm-html-card-on' : ''}${chromeFlipped ? ' pm-html-card-flip' : ''}`}
      onMouseEnter={chromeEnter}
      onMouseLeave={chromeLeave}
    >
      {streaming && (
        <div className="pm-html-card-stream">
          <span className="pm-html-card-badge">生成中…</span>
        </div>
      )}
      <div className="pm-html-card-float">
        <div className="pm-html-card-toolbar">
          <button className={`pm-html-card-tab${view === 'preview' ? ' pm-html-card-tab-on' : ''}`} onClick={() => setView('preview')}>
            预览
          </button>
          <button className={`pm-html-card-tab${view === 'code' ? ' pm-html-card-tab-on' : ''}`} onClick={() => setView('code')}>
            源码
          </button>
          <span className="pm-html-card-sep" />
          <button className="pm-html-card-icon-btn" title={copied ? '已复制' : '复制源码'} onClick={onCopy}>
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
        </div>
      </div>
      <div className="pm-html-card-body">
        {view === 'preview' ? (
          // Opaque-origin sandbox — no allow-same-origin, so the fragment gets
          // its own origin: no cookies, no localStorage, no page DOM. Scripts
          // and forms still run (the cards are meant to be interactive);
          // `#fff` matches the desktop card (content is designed light).
          <iframe
            ref={iframeRef}
            title="HTML 预览"
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
          <pre className="pm-html-card-code">{code}</pre>
        )}
      </div>
    </div>
  )
}
