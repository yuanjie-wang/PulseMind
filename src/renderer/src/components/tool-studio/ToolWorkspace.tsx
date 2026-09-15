// ── Tool workspace (M5R 工作室态) ──
// Left: live preview iframe (srcDoc + injectToolSdk + connectToolBridge).
// Right: the build conversation — the SAME hosted agent loop and the same
// transcript/composer components as the main chat (M5R unification); only the
// session config differs (builder prompt, narrow toolset, tool dir, unattended).

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Button, theme, Tooltip } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useNavigationStore } from '../../stores/navigationStore'
import { mountToolDocument } from '../../tool-studio/bridge-host'
import { useStudioSession } from '../../tool-studio/useStudioSession'
import { studioConversationId } from '../../tool-studio/tool-prompt'
import { TranscriptView } from '../chat/TranscriptView'
import { InputArea } from '../chat/InputArea'
import { ToolNameEditor } from './ToolNameEditor'
import { PresetBadge, ToolAvatar } from './toolVisual'
import type { UserTool } from '../../../../shared/types/user-tool'

export interface ToolWorkspaceProps {
  /** Existing tool to iterate on — the workspace only opens for a real tool. */
  toolId: string | null
}

const START_HINT = '描述你想要的工具，比如：一个支持 GET/POST 的接口调试器，可以保存请求历史。\n\n一次说不清也没关系——生成后随时继续提修改要求。'

export function ToolWorkspace({ toolId }: ToolWorkspaceProps): React.ReactElement | null {
  if (!toolId) return null
  // Keyed per tool: a different tool needs a fresh session mirror, not a
  // re-used one carrying the previous tool's transcript.
  return <ToolWorkspaceView key={toolId} toolId={toolId} />
}

function ToolWorkspaceView({ toolId }: { toolId: string }): React.ReactElement {
  const { settings, switchProfile } = useSettings()
  const { token } = theme.useToken()
  const navigate = useNavigationStore((s) => s.navigate)
  const [tool, setTool] = useState<UserTool | null>(null)
  const [toolsDir, setToolsDir] = useState<string | null>(null)
  const previewRef = useRef<HTMLIFrameElement>(null)

  const toolDir = toolsDir ? `${toolsDir}/${toolId}` : null

  const session = useStudioSession(toolId, tool?.name ?? '工具工作室', toolDir)
  const { html } = session

  useEffect(() => {
    window.electronAPI.getDataPaths().then((paths) => setToolsDir(paths.toolsDir ?? null)).catch(() => {})
  }, [toolId])

  // ── Tool record (name for the header + the persisted transcript title) ──
  useEffect(() => {
    let alive = true
    void window.electronAPI.toolGet(toolId).then((t) => { if (alive) setTool(t) })
    return () => { alive = false }
  }, [toolId])

  // ── Preview: the iframe is keyed by the read counter, so it rebuilds on every
  // new build and on an explicit refresh — no per-html effect needed.
  // The listener goes on before the tool document does, so generated tools can
  // call window.pulsemind (http/fs/storage/system) from their startup code
  // without racing the host (see mountToolDocument).
  useEffect(() => {
    const iframe = previewRef.current
    if (!iframe || !html) return
    return mountToolDocument(iframe, toolId, html)
  }, [html, toolId, session.htmlVersion])

  const goBack = useCallback((): void => {
    navigate({ kind: 'tools', toolId })
  }, [navigate, toolId])

  // Approvals: builder sessions run unattended with a narrow toolset, so these
  // should never surface — wired to the same engine calls the chat uses so
  // nothing is silently dead if one ever does.
  const convId = studioConversationId(toolId)
  const engineCall = useCallback((method: string, ...args: unknown[]): void => {
    void window.electronAPI.agentSessionEngineCall(convId, method, args)
  }, [convId])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: token.colorBgContainer }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={goBack} />
        {tool
          ? (
            <>
              <ToolAvatar tool={tool} size={22} />
              <ToolNameEditor tool={tool} onRenamed={setTool} nameSuffix={tool.preset ? <PresetBadge /> : undefined} />
            </>
          )
          : <span style={{ fontWeight: 600 }}>工具工作室</span>}
        <span style={{ fontSize: 12, color: token.colorTextTertiary }}>与 Agent 对话，边看预览边改</span>
        <span style={{ marginInlineStart: 'auto' }} />
        {html && (
          <Tooltip title="刷新预览">
            <Button type="text" icon={<ReloadOutlined />} onClick={session.reloadPreview} />
          </Tooltip>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: live preview */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: token.colorFillQuaternary }}>
          {html ? (
            <iframe
              key={session.htmlVersion}
              ref={previewRef}
              title="tool-preview"
              sandbox="allow-scripts"
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ color: '#bbb', fontSize: 13 }}>描述需求，工具会出现在这里</div>
            </div>
          )}
        </div>

        {/* Right: the build conversation */}
        <div style={{ width: 420, flexShrink: 0, borderLeft: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <TranscriptView
            messages={session.messages}
            agentStatus={session.agentStatus}
            streamingBlocks={session.streamingBlocks}
            isRequesting={session.isRunning}
            restoring={session.restoring}
            emptyHint={START_HINT}
            onApproveTool={(id) => engineCall('approveTool', id)}
            onRejectTool={(id) => engineCall('rejectTool', id)}
            onKillTool={(id) => engineCall('killTool', id)}
            onRespondToTool={(id, response) => engineCall('respondToTool', id, response)}
            onClearError={session.clearError}
            onRetry={session.retryLast}
          />
          <div style={{ padding: '8px 16px 16px' }}>
            <InputArea
              layout="inline"
              isRequesting={session.isRunning}
              isStreaming={session.isRunning}
              isAwaitingApproval={session.agentStatus.status === 'awaiting_approval'}
              isAwaitingInput={session.agentStatus.status === 'awaiting_user_input'}
              hasMessages={session.messages.length > 0}
              onSendMessage={session.ask}
              onCancel={session.cancel}
              profiles={settings.profiles}
              activeProfileId={settings.activeProfileId}
              onSelectProfile={(profileId) => {
                void switchProfile(profileId).then(session.refreshOptions)
              }}
              features={{ modelPicker: true }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
