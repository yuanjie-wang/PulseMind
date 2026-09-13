// ── Tool runner view (PLAN-0.4.0 M5.6; slimmed in M5R) ──
// Renders a tool's app.html in a strictly sandboxed iframe. M5 runs pure
// frontend capabilities (sandbox="allow-scripts", opaque origin — localStorage
// is intentionally unavailable; tools fall back to in-memory state). M6 adds
// the capability bridge (http/fs/storage/system) behind the same sandbox.
// No back button in M5R — going back IS the list (ToolListPage owns the split).

import React, { useEffect, useRef, useState } from 'react'
import { Button, Tooltip } from 'antd'
import { ReloadOutlined, EditOutlined } from '@ant-design/icons'
import { mountToolDocument } from '../../tool-studio/bridge-host'
import type { UserTool } from '../../../../shared/types/user-tool'
import { ToolNameEditor } from './ToolNameEditor'

export interface ToolRunnerProps {
  tool: UserTool
  /** Open the studio to keep iterating on this tool (nav: toolEditing). */
  onEdit: (tool: UserTool) => void
  /** A rename landed — the list owns the tool array and has to re-read it. */
  onRenamed: (tool: UserTool) => void
}

export function ToolRunner({ tool, onEdit, onRenamed }: ToolRunnerProps): React.ReactElement {
  const [html, setHtml] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI.toolReadHtml(tool.id).then((content) => {
      if (alive) setHtml(content ?? null)
    })
    return () => { alive = false }
  }, [tool.id, nonce])

  // Bridge + document: the helper attaches the listener before the tool's own
  // script can run (see mountToolDocument), so a tool that reads the bridge
  // during startup is not talking into the void.
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !html) return
    return mountToolDocument(iframe, tool.id, html)
  }, [html, tool.id, nonce])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #f0f0f0' }}>
        <ToolNameEditor tool={tool} onRenamed={onRenamed} />
        {tool.description && <span style={{ fontSize: 12, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tool.description}</span>}
        <span style={{ marginInlineStart: 'auto' }} />
        <Tooltip title="重新加载">
          <Button type="text" icon={<ReloadOutlined />} onClick={() => setNonce((n) => n + 1)} />
        </Tooltip>
        <Button size="small" icon={<EditOutlined />} onClick={() => onEdit(tool)}>在工作区编辑</Button>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {html ? (
          <iframe
            key={nonce}
            ref={iframeRef}
            title={tool.name}
            sandbox="allow-scripts"
            style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
          />
        ) : (
          <div style={{ padding: 24, color: '#999' }}>该工具还没有内容，去工作区生成一个。</div>
        )}
      </div>
    </div>
  )
}
