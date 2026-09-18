// ── Fallback card (PLAN-preview-pane D1) ── Shown for kinds the pane does not
//  render in-app (binary, and office formats whose own renderer failed). Names
//  the file, reports its size/mtime, and offers 在系统中打开.
//
// Extracted from PreviewContent so the docx renderer can fall back to it
// without a circular import.

import React, { useEffect, useState } from 'react'
import { Button } from 'antd'
import { ExternalLink } from 'lucide-react'
import { baseName, type FileKind } from '../../../../shared/preview/file-kind'
import { formatFileSize } from '../../../../shared/file-size'
import { useTranslation } from '../../i18n/useTranslation'

/** `hint` replaces the binary hint line — the PDF renderer's encrypted /
 *  oversized gates land on this same card shape with their own honest copy. */
export function FallbackCard({ path, kind, hint }: { path: string; kind: FileKind; hint?: string }): React.ReactElement {
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

  const sizeText = formatFileSize(info.size)

  return (
    <div style={{ padding: 24, textAlign: 'center' }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 4, wordBreak: 'break-all' }}>{baseName(path)}</div>
      <div style={{ fontSize: 11, color: '#999', marginBottom: 2 }}>
        {kind === 'office' ? 'Office' : 'Binary'}
        {sizeText ? ` · ${sizeText}` : ''}
        {info.mtime ? ` · ${new Date(info.mtime).toLocaleString()}` : ''}
      </div>
      <div style={{ fontSize: 12, color: '#999', margin: '12px 0 16px' }}>{hint ?? t('previewPane.binaryHint')}</div>
      <Button size="small" icon={<ExternalLink size={12} />} onClick={() => void window.electronAPI.openFolder(path).catch(() => {})}>
        {t('previewPane.openInOs')}
      </Button>
    </div>
  )
}
