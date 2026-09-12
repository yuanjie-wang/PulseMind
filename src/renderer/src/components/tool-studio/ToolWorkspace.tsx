// ── Tool workspace (M5R 工作室态; renamed/rewritten from ToolStudio) ──
// Left: live preview iframe (srcDoc + injectToolSdk + connectToolBridge).
// Right: the multi-round conversation that drives generation and iteration.
//
// M5R changes over ToolStudio:
//  - layout swapped: preview left, conversation right (§4.3);
//  - the generator instance lives in a module-level registry, so switching
//    away mid-run keeps the engine going and remounting restores context;
//  - conversation entries fold out of the engine's message list (onMessages),
//    including the assistant's real streaming reply — no canned text;
//  - persisted history replays on entry via loadHistory (engine keeps the
//    full tool_use/tool_result trail, so the next iteration has context);
//  - all transitions are navigation params: 创建中无 toolId,首次生成成功后
//    navigate 补上 toolId,返回键即可落运行态 (§4.3).

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Tag, Tooltip } from 'antd'
import { ArrowLeftOutlined, SendOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { useNavigationStore } from '../../stores/navigationStore'
import { getToolGenerator, type ToolEvent, type ToolGeneratorHandle } from '../../tool-studio/generator'
import { injectToolSdk, connectToolBridge } from '../../tool-studio/bridge-host'
import { storedMessagesToAgentMessages } from '../../utils/message-utils'
import type { AgentMessage } from '../../types/agent'
import type { UserTool } from '../../../../shared/types/user-tool'

export interface ToolWorkspaceProps {
  /** Existing tool to iterate on; absent = create-from-scratch flow. */
  toolId: string | null
}

type ConversationEntry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }

/** Fold the engine message list into user/assistant conversation entries —
 *  tool-only assistant messages (no text) are skipped; tool progress is shown
 *  by the status strip fed from onToolEvent. */
function foldMessages(msgs: AgentMessage[]): ConversationEntry[] {
  const out: ConversationEntry[] = []
  for (const m of msgs) {
    const text = m.contentBlocks
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    if (!text.trim()) continue
    out.push({ kind: m.role === 'user' ? 'user' : 'assistant', text })
  }
  return out
}

const START_HINT = '描述你想要的工具，比如：一个支持 GET/POST 的接口调试器，可以保存请求历史。\n\n一次说不清也没关系——生成后随时继续提修改要求。'

export function ToolWorkspace({ toolId }: ToolWorkspaceProps): React.ReactElement {
  const { settings } = useSettings()
  const { message } = AntdApp.useApp()
  const navigate = useNavigationStore((s) => s.navigate)
  const [tool, setTool] = useState<UserTool | null>(null)
  const [input, setInput] = useState('')
  const [timeline, setTimeline] = useState<ConversationEntry[]>([])
  const [statuses, setStatuses] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const [toolsDir, setToolsDir] = useState<string | null>(null)
  const historyLoadedRef = useRef<Set<string>>(new Set())
  const chatEndRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLIFrameElement>(null)

  const activeProfile = settings.profiles.find((p) => p.id === settings.activeProfileId)

  useEffect(() => {
    window.electronAPI.getDataPaths().then((paths) => setToolsDir(paths.toolsDir ?? null)).catch(() => {})
  }, [])

  // ── Tool record + current html (on open / after creation) ──
  // toolId === null is the create flow: nothing to load. Switching tools
  // remounts the whole workspace (keyed in ToolCenter), so no reset needed.
  useEffect(() => {
    if (!toolId) return
    let alive = true
    void window.electronAPI.toolGet(toolId).then((t) => { if (alive) setTool(t) })
    void window.electronAPI.toolReadHtml(toolId).then((content) => {
      if (!alive) return
      setHtml(content)
      setPreviewNonce((n) => n + 1)
    })
    return () => { alive = false }
  }, [toolId])

  const ensureGenerator = useCallback((t: UserTool): ToolGeneratorHandle => {
    const generator = getToolGenerator({
      apiKey: activeProfile?.apiKey ?? '',
      baseURL: activeProfile?.baseURL ?? '',
      model: activeProfile?.model ?? '',
      provider: activeProfile?.provider,
      maxTokens: activeProfile?.maxTokens ?? 32768,
      profileId: activeProfile?.id,
      toolDir: `${toolsDir}/${t.id}`,
      conversationId: `toolstudio_${t.id}`,
      title: t.name,
    })
    // Re-subscribed on every mount/dep change — the registry instance is
    // shared, the listeners are ours (unmount just replaces them).
    generator.onToolEvent((event: ToolEvent) => {
      setStatuses((prev) => [...prev, `${event.status === 'running' ? '▸' : '✓'} ${event.toolName} ${event.args}`.trim()])
    })
    generator.onMessages((msgs) => setTimeline(foldMessages(msgs)))
    return generator
  }, [activeProfile, toolsDir])

  // ── Subscribe + replay persisted history once per conversation ──
  useEffect(() => {
    if (!tool || !toolsDir) return
    const generator = ensureGenerator(tool)
    if (generator.isRunning() || historyLoadedRef.current.has(tool.id)) return
    historyLoadedRef.current.add(tool.id)
    let alive = true
    void window.electronAPI.getConversation(`toolstudio_${tool.id}`).then((conv) => {
      if (!alive || !conv?.messages?.length) return
      const msgs = storedMessagesToAgentMessages(conv.messages)
      if (msgs.length > 0) generator.loadHistory(msgs)
    }).catch(() => {})
    return () => { alive = false }
  }, [tool, toolsDir, ensureGenerator])

  // Bridge for the preview iframe — generated tools can call window.pulsemind
  // (http/fs/storage/system) subject to their declared capabilities.
  useEffect(() => {
    const iframe = previewRef.current
    if (!iframe || !html || !tool) return
    return connectToolBridge(iframe, tool.id)
  }, [html, tool, previewNonce])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [timeline, statuses])

  const goBack = (): void => {
    navigate(tool ? { kind: 'tools', toolId: tool.id } : { kind: 'tools' })
  }

  const send = async (): Promise<void> => {
    const text = input.trim()
    if (!text || running) return
    if (!activeProfile?.apiKey) {
      message.error('请先在设置中配置 API Key')
      return
    }
    if (!toolsDir) return
    setInput('')
    setStatuses([])
    setError(null)
    try {
      // Create the tool record on first generation; fill in the navigation
      // param so 返回 lands on the run state and deep links work (§4.3).
      let currentTool = tool
      if (!currentTool) {
        currentTool = await window.electronAPI.toolCreate({ name: text.slice(0, 20) || '未命名工具' })
        setTool(currentTool)
        navigate({ kind: 'tools', toolId: currentTool.id, toolEditing: true })
      }
      setRunning(true)
      const generator = ensureGenerator(currentTool)
      const result = await generator.run(text)
      setHtml(result)
      setPreviewNonce((n) => n + 1)
      await window.electronAPI.toolWriteHtml(currentTool.id, result)
      setRunning(false)
    } catch (err) {
      setRunning(false)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'cancelled') setError(`出错：${msg}`)
    }
  }

  const hasContent = !!html
  const empty = timeline.length === 0 && statuses.length === 0 && !error

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #f0f0f0' }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={goBack} />
        <span style={{ fontWeight: 600 }}>{tool?.name ?? '工具工作室'}</span>
        {tool?.preset && <Tag style={{ fontSize: 10, marginInlineEnd: 0 }}>预置</Tag>}
        <span style={{ fontSize: 12, color: '#999' }}>描述需求 → 生成 → 继续修改</span>
        <span style={{ marginInlineStart: 'auto' }} />
        {running && (
          <Button size="small" danger icon={<StopOutlined />} onClick={() => {
            if (tool) ensureGenerator(tool).cancel()
            setRunning(false)
          }}>
            停止
          </Button>
        )}
        {hasContent && (
          <Tooltip title="刷新预览">
            <Button type="text" icon={<ReloadOutlined />} onClick={() => setPreviewNonce((n) => n + 1)} />
          </Tooltip>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: live preview */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', background: '#fafafa' }}>
          {html && tool ? (
            <iframe
              key={previewNonce}
              ref={previewRef}
              title="tool-preview"
              srcDoc={injectToolSdk(html)}
              sandbox="allow-scripts"
              style={{ width: '100%', height: '100%', border: 'none' }}
            />
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 10 }}>
              <Tag color="default">预览区</Tag>
              <div style={{ color: '#bbb', fontSize: 13 }}>描述需求，工具会出现在这里</div>
            </div>
          )}
        </div>

        {/* Right: conversation */}
        <div style={{ width: 400, flexShrink: 0, borderLeft: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {empty && (
              <div style={{ color: '#999', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{START_HINT}</div>
            )}
            {timeline.map((entry, i) => (
              entry.kind === 'user' ? (
                <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'rgba(0,0,0,0.06)', borderRadius: 10, padding: '8px 12px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  {entry.text}
                </div>
              ) : (
                <div key={i} style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: 13, color: '#333', whiteSpace: 'pre-wrap' }}>{entry.text}</div>
              )
            ))}
            {statuses.length > 0 && (
              <div style={{ alignSelf: 'center', display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'center' }}>
                {statuses.map((line, i) => (
                  <div key={i} style={{ fontSize: 11, color: '#bbb', fontFamily: 'monospace' }}>{line}</div>
                ))}
              </div>
            )}
            {error && (
              <div style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: 13, color: '#c0392b' }}>{error}</div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div style={{ padding: 12, borderTop: '1px solid #f0f0f0' }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder={hasContent ? '想改点什么？例如：加一个请求历史列表' : '描述你想要的工具…'}
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
              <Button type="primary" icon={<SendOutlined />} disabled={running || !input.trim()} onClick={() => void send()}>
                {hasContent ? '发送修改' : '开始生成'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
