// ── Preview content dispatcher (PLAN-preview-pane §设计3) ──
// Loads the file (read guard applies main-side via UTIL_READ_FILE) and hands
// the text to the per-kind renderer. Re-reads when the tab's reload tick is
// bumped (agent write/edit events) or the path changes. Non-previewable kinds
// get the fallback card (D1: office deferred); csv/html renderers land in T3.

import React, { useCallback, useEffect, useState } from 'react'
import { Button } from 'antd'
import { RefreshCw, ExternalLink } from 'lucide-react'
import { detectFileKind, isPreviewable, type FileKind } from '../../../../shared/preview/file-kind'
import { MarkdownPreview } from './MarkdownPreview'
import { useTranslation } from '../../i18n/useTranslation'

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; text: string }
  | { status: 'missing' }
  | { status: 'error' }

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

function ImagePreview({ path }: { path: string }): React.ReactElement {
  // local-file:// serves any absolute path (main protocol handler);
  // backslashes must be normalized like LocalImage does for file:// sources.
  const src = `local-file://${path.replace(/\\/g, '/')}`
  return (
    <div style={{ padding: 16, display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
      <img src={src} alt="" style={{ maxWidth: '100%', borderRadius: 4 }} />
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

function PlainTextPreview({ text }: { text: string }): React.ReactElement {
  return (
    <pre
      style={{
        margin: 0,
        padding: '12px 16px',
        fontSize: 12,
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: '#333',
        fontFamily: 'ui-monospace, Menlo, monospace',
      }}
    >
      {text}
    </pre>
  )
}

export function PreviewContent({ path, reloadTick }: { path: string; reloadTick: number }): React.ReactElement {
  const kind = detectFileKind(path)
  const { state, reload } = usePreviewFile(path, kind, reloadTick)

  if (kind === 'image') return <ImagePreview path={path} />
  if (!isPreviewable(kind)) return <FallbackCard path={path} kind={kind} />

  if (state.status === 'loading') {
    return <div style={{ padding: 24, textAlign: 'center', color: '#bbb', fontSize: 12 }}>…</div>
  }
  if (state.status === 'missing' || state.status === 'error') {
    return <ErrorCard missing={state.status === 'missing'} onRetry={reload} />
  }
  if (kind === 'markdown') return <MarkdownPreview text={state.text} />
  if (kind === 'text') return <PlainTextPreview text={state.text} />
  // T3: dedicated csv (table) and html (sandboxed iframe) renderers.
  return <FallbackCard path={path} kind={kind} />
}
