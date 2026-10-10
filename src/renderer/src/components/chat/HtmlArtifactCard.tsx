/**
 * The HTML artifact card (2026-09-23): a ```html fence in an assistant message
 * renders here instead of the code highlighter — the Doubao-pattern visual aid
 * (model emits a self-contained static HTML fragment; the chat shows it as an
 * inline sandboxed preview card with the source one tab away). The dispatch
 * lives in CodeBlock (`isHtmlFenceLang`), which every XMarkdown site in the
 * chat shares, so streaming, settled history and the TranscriptView reuses
 * (experts, tool studio, run records) all get the card without per-view wiring.
 *
 * Isolation is the security model: the `sandbox` carries no same-origin flag,
 * so the fragment gets an opaque origin — no localStorage, no cookies, no
 * access to `window.electronAPI` or the app DOM. Scripts and forms still run
 * (the cards are meant to be interactive). The frame is served a
 * `local-file:` URL over a tmp copy (review 2026-09-25 P1), not srcdoc: the
 * page's `script-src` lost 'unsafe-inline', and a srcdoc document INHERITS
 * the parent CSP, which would kill the model's inline JS. blob: was the first
 * migration and is wrong — measured in `scripts/probe-csp-inheritance.mjs`,
 * a blob: child FIRES its load event and still refuses its inline script
 * (the creator's policy applies), so the blob path died exactly where srcdoc
 * would have. `local-file:` is the app's own protocol (protocol.handle in
 * main, the preview pane's) and does NOT inherit — same probe, same sandbox
 * flags. The copy is content-addressed (hashText), so an unchanged document
 * maps to the same path and a re-render never reloads the frame; tmp-cleanup
 * sweeps the directory (7 days — the copy is re-written on the next mount
 * anyway). SSR/jsdom have no `electronAPI` write, so they render the srcdoc
 * fallback below and the effect never replaces it. `allow-popups` without
 * `-to-escape` stays deliberately: it is the only path an in-card
 * `target=_blank` link has to the window open handler → scheme-gated
 * `shell.openExternal` in main, and popped frames remain sandboxed because
 * `-to-escape` is absent.
 *
 * Streaming: x-markdown emits the code token for an UNTERMINATED fence
 * (`streamStatus: 'loading'`), so the card can live-preview while the model
 * writes. Each snapshot swap reloads the whole frame, so during the stream
 * the snapshot advances at most every STREAM_PREVIEW_MIN_INTERVAL (the same
 * throttle shape StreamingText uses for the parse; feed() is idempotent, so
 * calling it during render is safe under StrictMode). `streaming=false` is
 * the settled render — the full text, once.
 *
 * Height: EVERY card reports its document's scrollHeight via postMessage
 * (load + resize + ResizeObserver) and the card clamps it to
 * [CARD_MIN_HEIGHT, CARD_MAX_HEIGHT], letting the frame scroll past the cap.
 * Fragments carry the measure script in their generated shell; a full
 * document (the model emitted `<!doctype html>`/`<html>`) keeps its markup
 * and gets the script injected before `</body>`. Full documents used to pass
 * through verbatim and rode the default height clipped — models emit full
 * documents for simple cards constantly, so the card showed 280px of a much
 * taller page (user report 2026-10-08: 高度展示不完整).
 *
 * Both shapes get their meta CSP stripped on the served copy: local-file has
 * no response headers, so meta is the only CSP vector, and a strict one would
 * kill the model's own inline scripts AND the measure script — height back to
 * the default, clipped (the preview pane strips for the same reason).
 *
 * Chrome (2026-10-09 user ruling): the header bar is hover chrome, not
 * content — at rest the card is a bare rounded iframe with NO border (the
 * border never appears, hovered or not); hovering floats the five controls
 * (preview/code tabs + copy/browser/pane) in a toolbar OUTSIDE the card's
 * top-right corner, and a streaming badge rides the top-left. When a clipping
 * ancestor's top edge leaves no headroom (the transcript scroller — the card
 * the user just scrolled into the upper viewport), the chrome flips to the
 * card's INSIDE top corners (`.pm-html-card-flip`), or the scroller cuts it
 * off. Inline styles cannot express hover state, so the chrome rides one
 * injected sheet (`.pm-html-card-*`, the CommandCard pulseKeyframe
 * precedent); the root's overflow:clip lives on `.pm-html-card-body`
 * instead, or it would clip the outside toolbar.
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from 'antd'
import { ChromeOutlined, CopyOutlined, ExpandOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { createTextThrottle } from './stream-throttle'
import { openInPreviewPane } from '../../stores/previewPaneStore'
import { buildCardDocument, HTML_ARTIFACT_SANDBOX } from '../../../../shared/preview/html-inject'
import { localFileUrl } from '../../../../shared/preview/local-file-url'

// buildCardDocument (with the measure script and the full-document test) moved
// to shared/preview/html-inject — the extension panel's card builds the same
// frame document, and the panel may not import this file (it would drag antd
// into the content-script bundle). Re-exported here for the existing tests.
export { buildCardDocument }

const CARD_MIN_HEIGHT = 120
const CARD_MAX_HEIGHT = 800
const CARD_DEFAULT_HEIGHT = 280
const STREAM_PREVIEW_MIN_INTERVAL = 1000
/** How long the toolbar survives the pointer fully leaving the card — the
 *  dropdown exit-intent grace that makes the outside toolbar reachable by a
 *  fast flick (see CARD_CHROME_CSS). */
const CHROME_LEAVE_GRACE_MS = 150
/** Headroom (px) the outside toolbar needs above the card; when the card sits
 *  closer to a clipping ancestor's top (the transcript scroller — the user
 *  just scrolled the card into the upper viewport), the chrome flips to the
 *  card's INSIDE top corners instead, or the scroller cuts it off — reported
 *  as 「被前一个消息块遮挡」. */
const CHROME_FLIP_HEADROOM_PX = 48

/** useLayoutEffect in the browser (swap the blob URL in before paint), the
 *  plain effect under SSR/node — a server render of a layout effect warns and
 *  runs nothing anyway. The card is browser-only; the alias exists for the
 *  renderToStaticMarkup test that mounts it. */
const useFrameLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

/** Whether frames here can be served from disk: the renderer preload exposes
 *  `writeFile`, SSR/jsdom do not. Evaluated at module load — the bridge
 *  exists before page scripts — and it is what splits a local-file frame
 *  (browser) from the srcdoc fallback (everything else). */
const CAN_PERSIST = typeof window !== 'undefined' && typeof window.electronAPI?.writeFile === 'function'

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

/** Write `content` to the content-addressed tmp html-cards dir and return the
 *  absolute path; null when the write (or dataPaths) fails — the frame treats
 *  that as "fall back to srcdoc". Shared by the frame (the built document) and
 *  the header buttons (the raw fence code), hence the generic name. */
export async function persistHtmlCopy(content: string): Promise<string | null> {
  try {
    const paths = await window.electronAPI.getDataPaths()
    // Renderer-layer writes carry no session context, so the guard applies
    // only the baseline deny roots — the app's own data dir stays writable.
    const filePath = `${paths.dataDir}/tmp/html-cards/${hashText(content)}.html`
    const res = await window.electronAPI.writeFile({ filePath, content })
    return res.success ? filePath : null
  } catch {
    return null
  }
}

/** Absolute fs path → the local-file: URL. Windows drive letters ride the
 *  URL hostname (local-file://C:/…), which serveLocalFile's
 *  resolveLocalFilePath reads back — same conversion LocalImage uses. */
export function toLocalFileUrl(filePath: string): string {
  return localFileUrl(filePath)
}

/** The card's rest/hover chrome (see the header comment). Hover state is JS,
 *  not `:hover`: a pure CSS gate flips `pointer-events` in the SAME frame the
 *  card loses hover, so one mouse event that jumps past the toolbar's hit box
 *  (a fast flick covers 30px+) leaves the pointer parked on a pass-through
 *  toolbar that can never re-hover — a deadlock the probe reproduced. The
 *  `.pm-html-card-on` class is applied by the component with a 150ms
 *  leave-grace (the dropdown exit-intent pattern): the toolbar stays
 *  interactive through the gap, and re-entering cancels the hide. No hover
 *  border (2026-10-09 ruling): the root keeps a constant 1px transparent
 *  border so the card's box never shifts. `.pm-html-card-float` sits at
 *  `bottom: 100%` — entirely above the card, never clipped by it. */
const CARD_CHROME_CSS = `
.pm-html-card-body { border-radius: 10px; overflow: hidden; }
.pm-html-card-float { position: absolute; bottom: 100%; right: 0; padding-bottom: 6px; opacity: 0; pointer-events: none; transition: opacity 0.15s ease; z-index: 30; }
.pm-html-card-on .pm-html-card-float { opacity: 1; pointer-events: auto; }
.pm-html-card-toolbar { display: flex; align-items: center; gap: 4px; padding: 2px 6px; background: var(--pm-tile-bg, var(--pm-code-bg)); border: 1px solid var(--pm-border-soft); border-radius: 8px; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.14); }
.pm-html-card-stream { position: absolute; bottom: 100%; left: 0; padding-bottom: 6px; pointer-events: none; z-index: 30; }
.pm-html-card-flip .pm-html-card-float { bottom: auto; top: 6px; }
.pm-html-card-flip .pm-html-card-stream { bottom: auto; top: 6px; }
`
let cardChromeInjected = false
if (typeof document !== 'undefined' && !cardChromeInjected) {
  const el = document.createElement('style')
  el.textContent = CARD_CHROME_CSS
  document.head.appendChild(el)
  cardChromeInjected = true
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

  // Hover chrome with a leave-grace (CARD_CHROME_CSS has the why). mouseenter
  // /mouseleave don't fire when the pointer moves between descendants, so
  // crossing from the iframe into the toolbar never toggles; only fully
  // exiting the card starts the grace, and re-entering cancels it.
  const [chromeOn, setChromeOn] = useState(false)
  const [chromeFlipped, setChromeFlipped] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Per-hover room check: the outside toolbar needs CHROME_FLIP_HEADROOM_PX
   *  above the card, and every clipping/scrolling ancestor's top edge (the
   *  transcript scroller) cuts what crosses it — inside corners when tight.
   *  Also the LIVE re-measure while the chrome is up: scrolling under a
   *  stationary pointer (the wheel over the card fires no mouseenter) drifts
   *  the card toward the scroller's top edge and strands a hover-time
   *  decision — the stale outside toolbar gets clipped, the exact occlusion
   *  the flip exists to avoid. Same-value setState bails, so settled wheel
   *  ticks cost no re-render. */
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
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = null
    measureChromeFlip()
    setChromeOn(true)
  }, [measureChromeFlip])
  const chromeLeave = useCallback(() => {
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = setTimeout(() => setChromeOn(false), CHROME_LEAVE_GRACE_MS)
  }, [])
  // Capture-phase scroll: scroll events don't bubble, and the scroller is an
  // ancestor of the card.
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
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    },
    [],
  )

  // The streaming snapshot: see the header comment. Replacing the frame's
  // document (each blob URL swap) reloads the frame, so freshness is
  // quantized instead of chasing every parse tick —
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

  // Serve the frame from a local-file: URL over a tmp copy (header comment:
  // srcdoc — and blob:, measured — inherit the renderer CSP and kill the
  // model's inline JS). A layout effect so the first URL lands before paint
  // wherever the async write allows; until it does, the frame carries neither
  // src nor srcDoc (about:blank — better than a srcdoc frame that loads with
  // its scripts refused and then reloads). Stale resolutions are dropped by
  // the cleanup flag; the file itself is content-addressed and swept by
  // tmp-cleanup, so there is no URL lifetime to manage here.
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [persistFailed, setPersistFailed] = useState(false)
  useFrameLayoutEffect(() => {
    if (!CAN_PERSIST) return // no write path: the srcdoc fallback is the render
    let stale = false
    void persistHtmlCopy(doc).then((filePath) => {
      if (stale) return
      if (filePath) {
        setPersistFailed(false)
        setFrameUrl(toLocalFileUrl(filePath))
      } else {
        setPersistFailed(true) // write unavailable → srcdoc fallback below
      }
    })
    return () => {
      stale = true
    }
  }, [doc])

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
    const filePath = await persistHtmlCopy(code)
    if (!filePath) return
    // Windows file: URIs are file:///C:/… — the same conversion
    // file-ops.ts svcCopyFile does.
    void window.electronAPI.openExternal(`file:///${filePath.replace(/\\/g, '/')}`)
  }

  const onOpenInPreview = async (): Promise<void> => {
    const filePath = await persistHtmlCopy(code)
    if (filePath) openInPreviewPane(filePath)
  }

  return (
    <div
      ref={rootRef}
      data-html-artifact-card=""
      className={`pm-html-card${chromeOn ? ' pm-html-card-on' : ''}${chromeFlipped ? ' pm-html-card-flip' : ''}`}
      onMouseEnter={chromeEnter}
      onMouseLeave={chromeLeave}
      style={{
        position: 'relative',
        margin: '8px 0',
        border: '1px solid transparent',
        borderRadius: 10,
      }}
    >
      {streaming && (
        <div className="pm-html-card-stream">
          <span
            style={{
              fontSize: 11,
              color: 'var(--pm-text-muted)',
              background: 'var(--pm-tile-bg, var(--pm-code-bg))',
              border: '1px solid var(--pm-border-soft)',
              borderRadius: 999,
              padding: '2px 8px',
            }}
          >
            {t('htmlCard.streaming')}
          </span>
        </div>
      )}
      <div className="pm-html-card-float">
        <div className="pm-html-card-toolbar" style={{ userSelect: 'none' }}>
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
      </div>
      <div className="pm-html-card-body">
        {view === 'preview' ? (
          // Opaque-origin sandbox: see the header comment. `#fff` matches
          // HtmlPreview — card content is designed light regardless of theme.
          <iframe
            ref={iframeRef}
            title={t('htmlCard.title')}
            sandbox={HTML_ARTIFACT_SANDBOX}
            src={frameUrl ?? undefined}
            srcDoc={frameUrl === null && (!CAN_PERSIST || persistFailed) ? doc : undefined}
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
    </div>
  )
}
