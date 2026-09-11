// ── Tool studio (PLAN-0.4.0 M5.5) ──
// Dialog-driven creation: a few rounds of clarification on the left, live
// preview on the right. After the first generation the left pane keeps the
// conversation going so the user can keep requesting modifications — the
// engine conversation carries context across runs.

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntdApp, Button, Input, Tag, Tooltip } from 'antd'
import { ArrowLeftOutlined, SendOutlined, ReloadOutlined, StopOutlined } from '@ant-design/icons'
import { useSettings } from '../../hooks/SettingsContext'
import { createToolGenerator, type ToolEvent, type ToolGeneratorHandle } from '../../tool-studio/generator'
import { injectToolSdk, connectToolBridge } from '../../tool-studio/bridge-host'
import type { UserTool } from '../../../../shared/types/user-tool'

export interface ToolStudioProps {
  /** Existing tool to iterate on; absent = create-from-scratch flow. */
  tool: UserTool | null
  onBack: () => void
  /** Called when a new tool is created (so the gallery can refresh). */
  onToolCreated: (tool: UserTool) => void
}

interface ChatEntry {
  role: 'user' | 'assistant' | 'status'
  text: string
}

const START_HINT = '描述你想要的工具，比如：一个支持 GET/POST 的接口调试器，可以保存请求历史。聊清楚需求后点「开始生成」。\n\n一次说不清也没关系——生成后随时继续提修改要求。'

export function ToolStudio({ tool: existingTool, onBack, onToolCreated }: ToolStudioProps): React.ReactElement {
  const { settings } = useSettings()
  const { message } = AntdApp.useApp()
  const [tool, setTool] = useState<UserTool | null>(existingTool)
  const [input, setInput] = useState('')
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [running, setRunning] = useState(false)
  const [html, setHtml] = useState<string | null>(null)
  const [previewNonce, setPreviewNonce] = useState(0)
  const generatorRef = useRef<ToolGeneratorHandle | null>(null)
  const chatEndRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLIFrameElement>(null)

  // Bridge for the preview iframe — generated tools can call window.pulsemind
  // (http/fs/storage/system) subject to their declared capabilities.
  useEffect(() => {
    const iframe = previewRef.current
    if (!iframe || !html || !tool) return
    return connectToolBridge(iframe, tool.id)
  }, [html, tool])

  useEffect(() => {
    if (!existingTool) return
    setTool(existingTool)
    setHtml(null)
    setPreviewNonce((n) => n + 1)
    void window.electronAPI.toolReadHtml(existingTool.id).then((content) => setHtml(content))
  }, [existingTool])

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  const activeProfile = settings.profiles.find((p) => p.id === settings.activeProfileId)
  const [toolsDir, setToolsDir] = useState<string | null>(null)
  useEffect(() => {
    window.electronAPI.getDataPaths().then((paths) => setToolsDir(paths.toolsDir ?? null)).catch(() => {})
  }, [])

  const ensureGenerator = useCallback((): ToolGeneratorHandle => {
    if (generatorRef.current) return generatorRef.current
    if (!tool) throw new Error('tool not created')
    if (!toolsDir) throw new Error('tools dir not ready')
    const generator = createToolGenerator({
      apiKey: activeProfile?.apiKey ?? '',
      baseURL: activeProfile?.baseURL ?? '',
      model: activeProfile?.model ?? '',
      provider: activeProfile?.provider,
      maxTokens: activeProfile?.maxTokens ?? 32768,
      profileId: activeProfile?.id,
      toolDir: `${toolsDir}/${tool.id}`,
      conversationId: `toolstudio_${tool.id}`,
    })
    generator.onToolEvent((event: ToolEvent) => {
      setEntries((prev) => [...prev, {
        role: 'status',
        text: `${event.status === 'running' ? '▸' : '✓'} ${event.toolName} ${event.args}`,
      }])
    })
    generatorRef.current = generator
    return generator
  }, [tool, activeProfile, toolsDir])

  const send = async (finalInstruction?: string): Promise<void> => {
    const text = (finalInstruction ?? input).trim()
    if (!text || running) return
    if (!activeProfile?.apiKey) {
      message.error('请先在设置中配置 API Key')
      return
    }
    setInput('')
    setEntries((prev) => [...prev, { role: 'user', text }])

    try {
      // Create the tool record on first generation.
      let currentTool = tool
      if (!currentTool) {
        currentTool = await window.electronAPI.toolCreate({ name: text.slice(0, 20) || '未命名工具' })
        setTool(currentTool)
        onToolCreated(currentTool)
      }

      setRunning(true)
      setEntries((prev) => [...prev, { role: 'status', text: '生成中…' }])
      const generator = ensureGenerator()
      const result = await generator.run(text)
      setHtml(result)
      await window.electronAPI.toolWriteHtml(currentTool.id, result)
      setEntries((prev) => [...prev, { role: 'assistant', text: '已生成。继续提修改要求，或直接在右侧使用。' }])
      setRunning(false)
    } catch (err) {
      setRunning(false)
      const msg = err instanceof Error ? err.message : String(err)
      if (msg !== 'cancelled') setEntries((prev) => [...prev, { role: 'assistant', text: `出错：${msg}` }])
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid #f0f0f0' }}>
        <Button type="text" icon={<ArrowLeftOutlined />} onClick={onBack} />
        <span style={{ fontWeight: 600 }}>{tool?.name ?? '工具工作室'}</span>
        <span style={{ fontSize: 12, color: '#999' }}>描述需求 → 生成 → 继续修改</span>
        <span style={{ marginInlineStart: 'auto' }} />
        {running && (
          <Button size="small" danger icon={<StopOutlined />} onClick={() => { generatorRef.current?.cancel(); setRunning(false) }}>
            停止
          </Button>
        )}
        {html && (
          <Tooltip title="刷新预览">
            <Button type="text" icon={<ReloadOutlined />} onClick={() => setPreviewNonce((n) => n + 1)} />
          </Tooltip>
        )}
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: clarification / iteration chat */}
        <div style={{ width: 380, flexShrink: 0, borderRight: '1px solid #f0f0f0', display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {entries.length === 0 && (
              <div style={{ color: '#999', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{START_HINT}</div>
            )}
            {entries.map((entry, i) => (
              entry.role === 'user' ? (
                <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: 'rgba(0,0,0,0.06)', borderRadius: 10, padding: '8px 12px', fontSize: 13, whiteSpace: 'pre-wrap' }}>
                  {entry.text}
                </div>
              ) : entry.role === 'status' ? (
                <div key={i} style={{ alignSelf: 'center', fontSize: 11, color: '#bbb', fontFamily: 'monospace' }}>{entry.text}</div>
              ) : (
                <div key={i} style={{ alignSelf: 'flex-start', maxWidth: '85%', fontSize: 13, color: '#333' }}>{entry.text}</div>
              )
            ))}
            <div ref={chatEndRef} />
          </div>
          <div style={{ padding: 12, borderTop: '1px solid #f0f0f0' }}>
            <Input.TextArea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPressEnter={(e) => {
                if (!e.shiftKey) {
                  e.preventDefault()
                  if (!running) {
                    if (!html && !running) void send()
                    else void send()
                  }
                }
              }}
              placeholder={html ? '想改点什么？例如：加一个请求历史列表' : '描述你想要的工具…'}
              autoSize={{ minRows: 2, maxRows: 5 }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8, gap: 8 }}>
              {!html && (
                <Button type="primary" icon={<SendOutlined />} disabled={running || !input.trim()} onClick={() => void send()}>
                  开始生成
                </Button>
              )}
              {html && (
                <Button type="primary" icon={<SendOutlined />} disabled={running || !input.trim()} onClick={() => void send()}>
                  发送修改
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Right: live preview */}
        <div style={{ flex: 1, overflow: 'hidden', background: '#fafafa' }}>
          {html ? (
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
              <div style={{ color: '#bbb', fontSize: 13 }}>生成完成后，工具会出现在这里</div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
