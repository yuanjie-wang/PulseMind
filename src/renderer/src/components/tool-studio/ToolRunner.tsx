// ── Tool runner view (PLAN-0.4.0 M5.6) ──
// Renders a tool's app.html in a strictly sandboxed iframe. M5 runs pure
// frontend capabilities (sandbox="allow-scripts", opaque origin — localStorage
// is intentionally unavailable; tools fall back to in-memory state). M6 adds
// the capability bridge (http/fs/storage/system) behind the same sandbox.

import React, { useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { ReloadOutlined, ArrowLeftOutlined, DownloadOutlined } from '@ant-design/icons'
import { injectToolSdk, connectToolBridge } from '../../tool-studio/bridge-host'
import type { UserTool } from '../../../../shared/types/user-tool'

export interface ToolRunnerProps {
  tool: UserTool
  onBack: () => void
  /** Open the studio to keep iterating on this tool. */
  onEdit: (tool: UserTool) => void
}

export function ToolRunner({ tool, onBack, onEdit }: ToolRunnerProps): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI.toolReadHtml(tool.id).then((content) => {
      if (alive) setHtml(content ? injectToolSdk(content) : content)
    })
    return () => { alive = false }
  }, [tool.id, nonce])

  // Bridge: the strictly-sandboxed iframe talks to the host over postMessage;
  // the host forwards to the main-process runtime (capability-checked, audited).
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !html) return
    return connectToolBridge(iframe, tool.id)
  }, [html, tool.id, nonce])

  const exportHtml = (): void => {
    if (!html) return
    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${tool.name}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #f0f0f0' }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <span style={{ fontWeight: 600 }}>{tool.name}</span>
        {tool.description && <span style={{ fontSize: 12, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.description}</span>}
        <span style={{ marginInlineStart: 'auto' }} />
        <Tooltip title="重新加载">
          <Button type="text" icon={<ReloadOutlined />} onClick={() => setNonce((n) => n + 1)} />
        </Tooltip>
        <Tooltip title="导出 HTML">
          <Button type="text" icon={<DownloadOutlined />} onClick={exportHtml} />
        </Tooltip>
        <Button size="small" onClick={() => onEdit(tool)}>继续修改</Button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {html ? (
          <iframe
            key={nonce}
            ref={iframeRef}
            title={tool.name}
            srcDoc={html}
            sandbox="allow-scripts"
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
          />
        ) : (
          <div style={{ padding: 24, color: '#999' }}>该工具还没有内容，去工作室生成一个。</div>
        )}
      </div>
    </div>
  )
}
