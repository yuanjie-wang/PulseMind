// ── File info footer ── Reports the file's size and mtime. This replaces the
//  old 在系统中打开 button on the preview footers: the top toolbar already owns
//  that action, so the bottom strip carries information instead.
//
// The file's NAME is deliberately absent even though the tooltip keeps the full
// path: the tab strip sits directly above this strip with the same name in it,
// and the user read the repetition as noise — what the footer can say that the
// tab cannot is how big the file is and when it changed.
//
// Shared by the docx, image and markitdown office footers so all three carry
// identical information.

import React, { useEffect, useState } from 'react'
import { formatFileSize } from '../../../../shared/file-size'

export function FileInfoBar({ path }: { path: string }): React.ReactElement {
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
    <div
      title={path}
      style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
    >
      <span style={{ color: '#666' }}>
        {[sizeText, info.mtime ? new Date(info.mtime).toLocaleString() : ''].filter(Boolean).join(' · ')}
      </span>
    </div>
  )
}
