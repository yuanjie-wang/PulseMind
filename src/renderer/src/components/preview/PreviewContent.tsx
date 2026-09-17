// ── Preview content dispatcher (PLAN-preview-pane §设计3; PLAN-preview-edit
// T2/T3) ── Loads the file (read guard applies main-side via UTIL_READ_FILE)
// and hands the text to the per-kind renderer — or, in edit mode, to the
// zero-dep FileEditor. Re-reads when the tab's reload tick is bumped (agent
// write/edit events) or the path changes; every re-read funnels through
// conflictDecision (stores/preview-edit.ts), which is also what keeps a
// dirty draft alive across tab switches (the component remounts, the draft
// lives in the store).

import React, { useCallback, useEffect, useState } from 'react'
import { Button, message } from 'antd'
import { RefreshCw, ExternalLink, AlertTriangle } from 'lucide-react'
import { detectFileKind, isPreviewable, type FileKind } from '../../../../shared/preview/file-kind'
import { MarkdownPreview } from './MarkdownPreview'
import { TextPreview } from './TextPreview'
import { CsvPreview } from './CsvPreview'
import { HtmlPreview } from './HtmlPreview'
import { FileEditor } from './FileEditor'
import { ElementEditPanel } from './ElementEditPanel'
import { LocalImage } from '../chat/LocalImage'
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

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'missing' }
  | { status: 'error' }

/** Kinds whose source text can be edited in place (D1): markdown / text(代码)
 *  / html(源码) / csv(文本方式). Image is read-only; office/binary keep the
 *  fallback card. */
function isEditableKind(kind: FileKind): boolean {
  return kind === 'markdown' || kind === 'text' || kind === 'csv' || kind === 'html'
}

/** Read a text file through the util bridge. Images skip the read — the
 *  <img> streams bytes straight from local-file://. */
function usePreviewFile(
  path: string,
  kind: FileKind,
  reloadTick: number,
): { state: LoadState; reload: () => void } {
  const [state, setState] = useState<LoadState>({ status: 'loading' })

  const load = useCallback(() => {
    if (kind === 'image') {
      setState({ status: 'ready', text: '' })
      return
    }
    setState({ status: 'loading' })
    window.electronAPI
      .readFile(path)
      .then((text) => setState(text === null ? { status: 'missing' } : { status: 'ready', text }))
      .catch(() => setState({ status: 'error' }))
  }, [path, kind])

  useEffect(() => {
    load()
  }, [load, reloadTick])

  return { state, reload: load }
}

function ErrorCard({ missing, onRetry }: { missing: boolean; onRetry: () => void }): React.ReactElement {
  const { t } = useTranslation()
  return (
    <div style={{ padding: 24, textAlign: 'center', color: '#999', fontSize: 13 }}>
      <div style={{ marginBottom: 12 }}>{missing ? t('previewPane.notFound') : t('previewPane.loadError')}</div>
      <Button size="small" icon={<RefreshCw size={12} />} onClick={onRetry}>
        {t('previewPane.retry')}
      </Button>
    </div>
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
        background: '#fff7e6',
        borderBottom: '1px solid #ffd591',
        fontSize: 12,
        color: '#d46b08',
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

function ImagePreview({ path }: { path: string }): React.ReactElement {
  // LocalImage normalizes the path to local-file:// and opens the shared
  // lightbox (ImageViewer) on click — same behavior as chat images.
  return (
    <div style={{ padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <LocalImage src={`local-file://${path.replace(/\\/g, '/')}`} style={{ maxHeight: 'none' }} />
    </div>
  )
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function FallbackCard({ path, kind }: { path: string; kind: FileKind }): React.ReactElement {
  const { t } = useTranslation()
  const [info, setInfo] = useState<{ size: number | null; mtime: string | null }>({ size: null, mtime: null })

  useEffect(() => {
    let alive = true
    window.electronAPI
      .getFileStat(path)
      .then((stat) => {
        if (alive) setInfo(stat ? { size: stat.size, mtime: stat.mtime } : { size: null, mtime: null })
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [path])

  const size = info.size
  const sizeText =
    size === null ? '' : size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`

  return (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 4, wordBreak: 'break-all' }}>{baseName(path)}</div>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>
        {kind === 'office' ? 'Office' : 'Binary'}
        {sizeText ? ` · ${sizeText}` : ''}
        {info.mtime ? ` · ${new Date(info.mtime).toLocaleString()}` : ''}
      </div>
      <div style={{ fontSize: 12, color: '#999', margin: '12px 0 16px' }}>{t('previewPane.binaryHint')}</div>
      <Button size="small" icon={<ExternalLink size={12} />} onClick={() => void window.electronAPI.openFolder(path).catch(() => {})}>
        {t('previewPane.openInOs')}
      </Button>
    </div>
  )
}

export function PreviewContent({ path, reloadTick }: { path: string; reloadTick: number }): React.ReactElement {
  const { t } = useTranslation()
  const kind = detectFileKind(path)
  const { state, reload } = usePreviewFile(path, kind, reloadTick)
  const mode = usePreviewPaneStore((s) => s.previewModes[path] ?? 'view')
  const editMode = mode === 'source'
  const elementMode = mode === 'element' && kind === 'html'
  const draft = usePreviewPaneStore((s) => s.drafts[path])
  const externalChange = usePreviewPaneStore((s) => !!s.externalChanges[path])

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

  if (kind === 'image') return <ImagePreview path={path} />
  if (!isPreviewable(kind)) return <FallbackCard path={path} kind={kind} />

  if (state.status === 'loading') {
    return <div style={{ padding: 24, textAlign: 'center', color: '#bbb', fontSize: 12 }}>…</div>
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

  // ── Edit mode (D1/D3): markdown / text / csv / html all edit their SOURCE
  // text — the view mode's renderer is irrelevant here. Display text prefers
  // the store draft (survives tab switches and agent conflicts). ──
  if (editMode && isEditableKind(kind)) {
    const bytes = new TextEncoder().encode(state.text).length
    if (!isEditableSize(bytes)) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: '#999', fontSize: 13 }}>
          {t('previewPane.tooLarge')}
        </div>
      )
    }
    const value = draft?.content ?? state.text
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {externalChange && <ConflictBanner path={path} />}
        <div style={{ flex: 1, minHeight: 0 }}>
          <FileEditor
            value={value}
            onChange={(next) => {
              const st = usePreviewPaneStore.getState()
              const entry = st.drafts[path] ?? makeDraftFromDisk(state.text)
              st.setDraft(path, { ...entry, content: next })
            }}
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

  if (kind === 'markdown') return <MarkdownPreview text={state.text} />
  if (kind === 'text') return <TextPreview text={state.text} path={path} />
  if (kind === 'csv') return <CsvPreview text={state.text} path={path} />
  if (kind === 'html') return <HtmlPreview path={path} reloadTick={reloadTick} />
  return <FallbackCard path={path} kind={kind} />
}
