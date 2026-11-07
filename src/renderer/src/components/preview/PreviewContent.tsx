// ── Preview content dispatcher (PLAN-preview-pane §设计3; PLAN-preview-edit
// T2/T3) ── Loads the file (read guard applies main-side via UTIL_READ_FILE)
// and hands the text to the per-kind renderer — or, in edit mode, to the
// zero-dep FileEditor. Re-reads when the tab's reload tick is bumped (agent
// write/edit events) or the path changes; every re-read funnels through
// conflictDecision (stores/preview-edit.ts), which is also what keeps a
// dirty draft alive across tab switches (the component remounts, the draft
// lives in the store).

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Button, message } from 'antd'
import { RefreshCw, AlertTriangle } from 'lucide-react'
import { detectFileKind, isPreviewable, extensionOf, type FileKind } from '../../../../shared/preview/file-kind'
import { capPreviewText, previewLimitLabel } from '../../../../shared/preview/view-cap'
import { reconstructPreChangeText } from '../../../../shared/diff/reconstruct-baseline'
import { MarkdownPreview } from './MarkdownPreview'
import { CsvPreview } from './CsvPreview'
import { HtmlPreview } from './HtmlPreview'
import { FileEditor } from './FileEditor'
import { ElementEditPanel } from './ElementEditPanel'
import { XlsxPreview } from './XlsxPreview'
import { PdfPreview } from './PdfPreview'
import { PptxPreview } from './PptxPreview'
import { FallbackCard } from './FallbackCard'
import { FileInfoBar } from './FileInfoBar'
import { ImagePreview } from './ImagePreview'
import { useTranslation } from '../../i18n/useTranslation'
import { usePreviewPaneStore } from '../../stores/previewPaneStore'
import { useHtmlEditStore } from '../../stores/htmlEditStore'
import {
  makeDraftFromDisk,
  conflictDecision,
  isDirty,
  isEditableSize,
  MAX_EDITABLE_BYTES,
} from '../../stores/preview-edit'

// The one preview whose engine is a STATIC import: DocxPreview pulls
// docx-preview at module scope, while the other three `await import()` theirs
// (pdfjs-dist / exceljs / fflate) inside the load effect. PreviewPane is
// mounted by the always-open workbench shell, so without this the engine rides
// the entry chunk of a launch that may never open a .docx.
const LazyDocxPreview = React.lazy(async () => ({ default: (await import('./DocxPreview')).DocxPreview }))

/** How long the reveal flash stays before the target is consumed and the
 *  highlight drops (PLAN-ide-linkage 1b). */
const REVEAL_FLASH_MS = 1800

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; text: string; truncated: boolean }
  | { status: 'missing' }
  | { status: 'error' }

/** Kinds whose source text can be edited in place (D1): markdown / text(代码)
 *  / html(源码) / csv(文本方式). Image is read-only; office/binary keep the
 *  fallback card. */
function isEditableKind(kind: FileKind): boolean {
  return kind === 'markdown' || kind === 'text' || kind === 'csv' || kind === 'html'
}

/** Read a text file through the util bridge. Images skip the read — the
 *  <img> streams bytes straight from local-file://. Office kinds skip too:
 *  their rich renderers re-read the bytes themselves (readFileBinary), so a
 *  utf-8 read here was a guaranteed-mangled full copy nobody consumed (M11).
 *  The text is capped at MAX_PREVIEW_CHARS (view-cap.ts): the pane renders
 *  spans per line, so a multi-megabyte read was a renderer freeze — the cap
 *  and its honest notice apply to VIEW only; the editor keeps its own gate
 *  (MAX_EDITABLE_BYTES), and reveal still anchors against the capped text. */
function usePreviewFile(
  path: string,
  kind: FileKind,
  reloadTick: number,
): { state: LoadState; reload: () => void } {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(() => {
    if (kind === 'image' || kind === 'office') {
      setState({ status: 'ready', text: '', truncated: false })
      return
    }
    setState({ status: 'loading' })
    window.electronAPI
      .readFile(path)
      .then((text) => {
        if (text === null) setState({ status: 'missing' })
        else {
          // Deliberately NOT in a startTransition: the sync loading render
          // would commit first (default lane beats the transition lane), so
          // every reload visibly unmounted and remounted the editor (caught
          // by probe-preview-edit's NOT-remounted check). The ready render is
          // cheap since fast-code.ts — no transition needed.
          const capped = capPreviewText(text)
          // Publish for the agent-diff capture (2026-11-01): usePreviewPaneSync
          // snapshots this at the completion event as the PRE-change text.
          // Imperative write — nobody subscribes, zero re-render cost.
          usePreviewPaneStore.getState().noteLoadedText(path, capped.text)
          setState({ status: 'ready', text: capped.text, truncated: capped.truncated })
        }
      })
      .catch(() => setState({ status: 'error' }))
  }, [path, kind])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load() marks the pane 'loading' before its await; that state belongs to the async load
    load()
  }, [load, reloadTick])

  return { state, reload: load }
}

function ErrorCard({ missing, onRetry }: { missing: boolean; onRetry: () => void }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-muted)', fontSize: 13 }}>
      <div style={{ marginBottom: 12 }}>{missing ? t('previewPane.notFound') : t('previewPane.loadError')}</div>
      <Button size="small" icon={<RefreshCw size={12} />} onClick={onRetry}>
        {t('previewPane.retry')}
      </Button>
    </div>
  )
}

/** The view-cap notice (view-cap.ts): the text was truncated at read time.
 *  Sticky so the reason a file is cut stays visible while scrolling the part
 *  that did render. The i18n key is static — the cap constant and the label
 *  derive from the same module. */
function TruncationNotice({ show, children }: { show: boolean; children: React.ReactNode }): React.ReactElement {
  const { t } = useTranslation()
  if (!show) return <>{children}</>
  return (
    <>
      <div
        data-pm-preview-truncated
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 12px',
          background: 'var(--pm-warn-bg)',
          borderBottom: '1px solid var(--pm-warn-border)',
          fontSize: 11,
          color: 'var(--pm-warn)',
          flexShrink: 0,
        }}
      >
        <AlertTriangle size={12} style={{ flexShrink: 0 }} />
        <span style={{ flex: 1, minWidth: 0 }}>{t('previewPane.viewTruncated', { limit: previewLimitLabel() })}</span>
      </div>
      {children}
    </>
  )
}

/** The D7 banner: shown only while an external change is waiting on the
 *  user's decision. 重新加载 discards the draft; 保留我的修改 clears the
 *  mark — the next save overwrites the external change. */
function ConflictBanner({ path }: { path: string }): React.ReactElement {
  const { t } = useTranslation()
  const store = usePreviewPaneStore.getState()
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'var(--pm-warn-bg)',
        borderBottom: '1px solid var(--pm-warn-border)',
        fontSize: 12,
        color: 'var(--pm-warn)',
        flexShrink: 0,
      }}
    >
      <AlertTriangle size={13} style={{ flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0 }}>{t('previewPane.conflictBanner')}</span>
      <Button
        size="small"
        onClick={() => {
          store.clearDraft(path)
          store.clearExternalChange(path)
          store.bumpReload(path)
        }}
      >
        {t('previewPane.conflictReload')}
      </Button>
      <Button size="small" type="primary" onClick={() => store.clearExternalChange(path)}>
        {t('previewPane.conflictKeep')}
      </Button>
    </div>
  )
}

/** PLAN-office-editing T16: office documents render as read-only markdown via
 *  the same conversion the `read` tool uses (read-cache makes the mtime the
 *  only invalidation needed). A failed conversion falls back to the card.
 *  DOCX no longer lands here — see the dispatcher below. */
function OfficePreview({ path, kind }: { path: string; kind: FileKind }): React.ReactElement {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [markdown, setMarkdown] = useState('')
  useEffect(() => {
    let alive = true
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the async conversion loading mark, set before convertFileToMarkdown resolves
    setState('loading')
    window.electronAPI.convertFileToMarkdown(path)
      .then((result) => {
        if (!alive) return
        if (result && result.content) {
          setMarkdown(result.content)
          setState('ready')
        } else {
          setState('error')
        }
      })
      .catch(() => { if (alive) setState('error') })
    return () => { alive = false }
  }, [path])

  if (state === 'loading') return <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-faint)', fontSize: 12 }}>…</div>
  if (state === 'error') return <FallbackCard path={path} kind={kind} />
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '12px 16px' }}>
        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12.5, lineHeight: 1.7, color: 'var(--pm-text-strong)', fontFamily: 'inherit' }}>{markdown}</pre>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', padding: '4px 12px', borderTop: '1px solid var(--pm-border-hairline)' }}>
        <FileInfoBar path={path} />
      </div>
    </div>
  )
}

export function PreviewContent({ path, reloadTick }: { path: string; reloadTick: number }): React.ReactElement {
  const { t } = useTranslation()
  const kind = detectFileKind(path)
  const { state, reload } = usePreviewFile(path, kind, reloadTick)
  const mode = usePreviewPaneStore((s) => s.previewModes[path] ?? 'view')
  const editMode = mode === 'source'
  // 与 PreviewPane 的开关同一个闸（review 2026-09-18 M10）：模式残留 + 文件
  // 超限时回落到只读视图，而不是带着几 MB 文本进元素模式。
  const oversized = usePreviewPaneStore((s) => !!s.oversized[path])
  const elementMode = mode === 'element' && kind === 'html' && !oversized
  const draft = usePreviewPaneStore((s) => s.drafts[path])
  const externalChange = usePreviewPaneStore((s) => !!s.externalChanges[path])
  const reveal = usePreviewPaneStore((s) => s.revealTargets[path])
  const [revealLine, setRevealLine] = useState<number | null>(null)
  // Agent-change review diff (2026-11-01 pivot): the VIEW half highlights what
  // the AGENT changed (pre-change base vs the fresh disk text, read-only, no
  // controls). The user's own typing earns no diff (user ruling) — edit mode
  // never mounts the merge extension.
  const diffOn = usePreviewPaneStore((s) => s.diffVisible[path] ?? true)
  const agentBase = usePreviewPaneStore((s) => s.agentDiffBases[path])
  const viewDiffBase = !editMode && diffOn && agentBase != null && !(state.status === 'ready' && state.text === agentBase) ? agentBase : null

  // ── Reveal (PLAN-ide-linkage 1b): a completed edit (agent sync) or a tool
  // card click anchored this path — locate the target line in the fresh text
  // and hand it to the CM instance (the unified FileEditor), then consume the
  // target after the flash. The
  // tick guard keeps a second reveal from being cancelled by the first one's
  // expiry timer. Only the code view has a coordinate system to land on; every
  // other kind consumes-and-drops. A text anchor that no longer matches (the
  // disk moved on) is consumed immediately — no scroll is better than a wrong
  // scroll. ──
  useEffect(() => {
    if (!reveal) return
    if (state.status !== 'ready' || kind !== 'text') return
    const target = reveal.target
    let line: number | null = null
    if (target.mode === 'line') {
      line = target.line
    } else {
      const lines = state.text.split('\n')
      const idx = lines.findIndex((l) => l.trim().startsWith(target.text))
      if (idx >= 0) line = idx + 1
    }
    if (line == null) {
      usePreviewPaneStore.getState().consumeReveal(path)
      return
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived state of the loaded text, the same shape as the conflict decision above
    setRevealLine(line)
    const capturedTick = reveal.tick
    const timer = window.setTimeout(() => {
      const st = usePreviewPaneStore.getState()
      if (st.revealTargets[path]?.tick === capturedTick) {
        st.consumeReveal(path)
        setRevealLine(null)
      }
    }, REVEAL_FLASH_MS)
    return () => window.clearTimeout(timer)
  }, [reveal, state, kind, path])

  // Draft write-through, shared by the text branch's edit half and the
  // generic edit branch below — one draft shape, one setter. Only reachable
  // from the editor, which only renders on 'ready' (the narrowing is for the
  // type, not a runtime path).
  const updateDraft = useCallback(
    (next: string) => {
      const st = usePreviewPaneStore.getState()
      const disk = state.status === 'ready' ? state.text : ''
      const entry = st.drafts[path] ?? makeDraftFromDisk(disk)
      st.setDraft(path, { ...entry, content: next })
    },
    [path, state],
  )

  // Every freshly-read disk text funnels through the conflict decision
  // (PLAN-preview-edit T3/D7). The initial load has no decision to make
  // (no draft → nothing); a remount with a persisted dirty draft and an
  // unchanged disk lands on 'same' — the banner logic is exactly the same
  // code path as the agent-write case.
  useEffect(() => {
    if (state.status !== 'ready') return
    const st = usePreviewPaneStore.getState()
    // Publish the size gate (D8) — the toolbar's edit toggle reads it.
    const bytes = new TextEncoder().encode(state.text).length
    st.setOversized(path, isEditableKind(kind) && bytes > MAX_EDITABLE_BYTES)
    const existing = st.drafts[path]
    if (existing) {
      const decision = conflictDecision(isDirty(existing), state.text, existing.baseline)
      if (decision === 'conflict') {
        st.markExternalChange(path)
        return
      }
      st.clearExternalChange(path)
      if (decision === 'silent-refresh') {
        // Clean draft: adopt the new disk text as the new baseline.
        st.setDraft(path, makeDraftFromDisk(state.text))
      }
    }
    // Element-edit session: an agent write landed while we were not looking.
    // D8 of the element-edit plan: reload + CLEAR the undo stack + tell the
    // user. The re-read equals the session text when the tick came from our
    // own undo/AI write (they adopt first, bump after), so no spurious reload.
    if (elementMode) {
      const session = useHtmlEditStore.getState().sessions[path]
      if (session && session.fileText !== state.text) {
        useHtmlEditStore.getState().handleExternalChange(path, state.text)
        st.bumpReload(path)
        void message.info(t('htmlEdit.externalChange'))
      }
    }
    // state.text IS a dependency: the whole point is to re-decide on every
    // fresh read (a reload tick re-reads the same path, so `path`/`status`
    // alone never change).
  }, [state, path, kind, elementMode, t])

  // Resolve a pending agent-diff RECONSTRUCTION (2026-11-01) once the
  // post-change read has landed: the edit tool's old_str/new_str rebuilds the
  // pre-change text from the fresh disk text. `seen === state` means this
  // ready object is still the PRE-spec read (the reload the sync triggered
  // hasn't completed) — wait. A fresh mount resolves on its first ready (the
  // sync staged the spec before openFile, so the mount read IS post-change).
  // (When the pane held the file, the sync set the base directly — no spec.)
  const lastReadyRef = useRef<LoadState | null>(null)
  useEffect(() => {
    if (state.status !== 'ready') return
    const st = usePreviewPaneStore.getState()
    const spec = st.agentDiffCaptures[path]
    const seen = lastReadyRef.current
    lastReadyRef.current = state
    if (!spec || seen === state) return
    const after = state.text
    // Shared with the unit tests (src/shared/diff/reconstruct-baseline.ts,
    // review_20261103 中5) — the inline version carried a `$`-pattern and a
    // CRLF defect the hand-copied test could never see.
    const before = reconstructPreChangeText(after, spec)
    st.setAgentDiffBase(path, before)
    st.clearAgentDiffCapture(path)
    // A new review auto-shows (auto-show ruling reused): an explicit earlier
    // 隐藏改动 must not swallow the NEXT agent change.
    st.setDiffVisible(path, true)
  }, [state, path])

  if (kind === 'image') return <ImagePreview path={path} />
  if (kind === 'office') {
    // DOCX renders itself (layout / styles / images) via docx-preview, XLSX
    // renders its grid via the same exceljs build the edit engine uses, PDF
    // rasterises its pages via pdfjs-dist, and PPTX renders slide pages from
    // its own OOXML model (PLAN-pptx-preview); the remaining office formats
    // (doc / xls / ppt) keep the markitdown → raw-text path.
    const ext = extensionOf(path)
    if (ext === 'docx') {
      return (
        <Suspense fallback={null}>
          <LazyDocxPreview path={path} kind={kind} reloadTick={reloadTick} />
        </Suspense>
      )
    }
    if (ext === 'xlsx') return <XlsxPreview path={path} kind={kind} reloadTick={reloadTick} />
    if (ext === 'pdf') return <PdfPreview path={path} kind={kind} reloadTick={reloadTick} />
    if (ext === 'pptx') return <PptxPreview path={path} kind={kind} reloadTick={reloadTick} />
    return <OfficePreview path={path} kind={kind} />
  }
  if (!isPreviewable(kind)) return <FallbackCard path={path} kind={kind} />

  if (state.status === 'loading') {
    return <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-faint)', fontSize: 12 }}>…</div>
  }
  if (state.status === 'missing' || state.status === 'error') {
    return <ErrorCard missing={state.status === 'missing'} onRetry={reload} />
  }

  // ── Element mode (PLAN-html-element-edit M3): the picker-filled iframe +
  // the bottom strip. The textarea size gate does not apply here — nothing
  // renders megabytes of text. ──
  if (elementMode) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <HtmlPreview path={path} reloadTick={reloadTick} text={state.text} elementMode />
        </div>
        <ElementEditPanel path={path} />
      </div>
    )
  }

  // ── Edit mode size gate (D1/D3): markdown / text / csv / html all edit
  // their SOURCE text. Applies to every editable kind, the unified text
  // branch included. ──
  if (editMode && isEditableKind(kind)) {
    const bytes = new TextEncoder().encode(state.text).length
    if (!isEditableSize(bytes)) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--pm-text-muted)', fontSize: 13 }}>
          {t('previewPane.tooLarge')}
        </div>
      )
    }
  }

  // ── text: the unified CM instance (PLAN-codemirror-view). One lazy editor
  // serves view and edit; the readOnly flip reconfigures in place — no
  // remount, so scroll position, undo history and the draft all survive the
  // 查看↔编辑 flip. Draft wiring only in edit mode (CodeMirrorEditor header
  // note 3): the flip adopts the draft via the value effect, and a view-side
  // listener would feed that disk text straight back into the setter, wiping
  // the dirty draft. ──
  // The tree SHAPE must be identical across the flip (both modes render
  // TruncationNotice; show=false collapses to a fragment) — the edit branch
  // returning `body` bare unmounts the fragment wrapper and remounts the
  // whole editor (probe: same-node=false).
  if (kind === 'text') {
    const body = (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {editMode && externalChange && <ConflictBanner path={path} />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <FileEditor
            value={editMode ? draft?.content ?? state.text : state.text}
            path={path}
            onChange={editMode ? updateDraft : undefined}
            onSave={
              editMode
                ? () => {
                    // The toolbar's save button owns the actual write; dispatch
                    // a custom event so ⌘S in the editor and the button share
                    // one path.
                    window.dispatchEvent(new CustomEvent('pulsemind-preview-save', { detail: path }))
                  }
                : undefined
            }
            readOnly={!editMode}
            revealLine={revealLine}
            viewDiffBase={viewDiffBase}
          />
        </div>
      </div>
    )
    // Edit text is ≤ MAX_EDITABLE_BYTES (gate above) — far under the 2M-char
    // render cap — so the truncation notice is view-only.
    return <TruncationNotice show={!editMode && state.truncated}>{body}</TruncationNotice>
  }

  // ── Edit mode (D1/D3): markdown / csv / html (text returned above).
  // Display text prefers the store draft (survives tab switches and agent
  // conflicts). ──
  if (editMode && isEditableKind(kind)) {
    const value = draft?.content ?? state.text
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {externalChange && <ConflictBanner path={path} />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <FileEditor
            value={value}
            path={path}
            onChange={updateDraft}
            onSave={() => {
              // The toolbar's save button owns the actual write; dispatch a
              // custom event so ⌘S in the editor and the button share one path.
              window.dispatchEvent(new CustomEvent('pulsemind-preview-save', { detail: path }))
            }}
          />
        </div>
      </div>
    )
  }

  if (kind === 'markdown') return <TruncationNotice show={state.truncated}><MarkdownPreview text={state.text} /></TruncationNotice>
  if (kind === 'csv') return <TruncationNotice show={state.truncated}><CsvPreview text={state.text} path={path} /></TruncationNotice>
  if (kind === 'html') return <HtmlPreview path={path} reloadTick={reloadTick} />
  return <FallbackCard path={path} kind={kind} />
}
