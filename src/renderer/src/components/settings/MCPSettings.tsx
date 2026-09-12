import React, { useEffect, useState, useCallback } from 'react'
import { Button, Card, Tag, Tooltip, Modal, Input, Form, Radio, Segmented } from 'antd'
import {
  ApiOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
  CloseCircleOutlined,
  LinkOutlined,
  ToolOutlined,
  PlusOutlined,
  DeleteOutlined
} from '@ant-design/icons'
import type { MCPManagedServer, MCPClientConfig } from '../../types/electron'
import { useAppSettings } from '../../hooks/useAppSettings'
import { createLlmAdapter } from '../../llm'
import { generateMcpSummaries } from '../../agent/mcp-summary-service'

/** A dot, not a filled Tag: on a ~320px card a colored status pill competes with
 *  the server name for the eye, which is exactly the crowding we're removing. */
const STATUS: Record<MCPManagedServer['status'], { color: string; label: string; pulse?: boolean }> = {
  connected: { color: '#52c41a', label: '已连接' },
  connecting: { color: '#1677ff', label: '连接中', pulse: true },
  stopped: { color: '#d9d9d9', label: '已停止' },
  error: { color: '#ff4d4f', label: '错误' },
}

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: '本地',
  sse: 'SSE',
  'streamable-http': 'HTTP',
}

/** Connectors the app registers for itself: no editable config, and not deletable. */
const BUILT_IN_IDS = new Set(['chrome-devtools'])

/** The form edits headers as key/value rows; MCPClientConfig stores a record. */
interface HeaderRow {
  key: string
  value: string
}

function toHeaderRows(headers?: Record<string, string>): HeaderRow[] {
  return Object.entries(headers ?? {}).map(([key, value]) => ({ key, value }))
}

/** A row with a blank name is one the user added but never filled — drop it. */
function fromHeaderRows(rows?: Array<Partial<HeaderRow>>): Record<string, string> | undefined {
  const entries = (rows ?? [])
    .map((row) => [(row?.key ?? '').trim(), row?.value ?? ''] as const)
    .filter(([key]) => key)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

const CARD_CSS = `
  @keyframes mcp-dot-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
`

const ICON_TILE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'rgba(0, 0, 0, 0.05)',
  color: '#555',
}

const TOOL_TAG: React.CSSProperties = {
  fontSize: 11,
  margin: 0,
  border: 'none',
  background: 'rgba(0, 0, 0, 0.05)',
  color: '#666',
}

function ServerStatusLine({ status }: { status: MCPManagedServer['status'] }): React.ReactElement {
  const cfg = STATUS[status] ?? STATUS.stopped
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0, color: '#888' }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: cfg.color,
          boxShadow: `0 0 0 3px ${cfg.color}1f`,
          animation: cfg.pulse ? 'mcp-dot-pulse 1.2s ease-in-out infinite' : undefined,
        }}
      />
      {cfg.label}
    </span>
  )
}

interface McpServerCardProps {
  server: MCPManagedServer
  busy: boolean
  onOpenEditor: () => void
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onDelete: () => void
}

/** Connector card. Card's own title/extra/actions bands are deliberately unused —
 *  three chrome rows on a narrow card was the bulk of the old card's clutter.
 *  Header, a one-line endpoint and the collapsed tool list all live in the body.
 *  Custom connectors open the edit dialog on card click; the built-in one does
 *  not, because its config is regenerated on every boot. */
function McpServerCard({
  server,
  busy,
  onOpenEditor,
  onStart,
  onStop,
  onRestart,
  onDelete
}: McpServerCardProps): React.ReactElement {
  const isBuiltIn = BUILT_IN_IDS.has(server.id)
  const editable = !isBuiltIn
  const openEditor = editable ? onOpenEditor : undefined
  const transport = server.config.transportType || 'stdio'
  const isRemote = transport === 'sse' || transport === 'streamable-http'
  const connected = server.status === 'connected'
  const endpoint = isRemote
    ? server.config.url || ''
    : [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(' ')

  // One muted line carries what used to be serverInfo + status + a separate row.
  const meta: string[] = [TRANSPORT_LABEL[transport] ?? transport]
  if (server.tools.length > 0) meta.push(`${server.tools.length} 个工具`)
  if (server.serverInfo?.version) meta.push(`v${server.serverInfo.version}`)

  // Keyboard parity for the click-to-edit card; inner buttons must keep their
  // own key handling, so only the card's own target counts.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!openEditor || e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openEditor()
    }
  }

  return (
    <Card
      hoverable={editable}
      onClick={openEditor}
      onKeyDown={handleKeyDown}
      tabIndex={editable ? 0 : undefined}
      style={{ borderRadius: 10, height: '100%', cursor: editable ? 'pointer' : undefined }}
      styles={{
        body: { padding: 14, height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column' }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ ...ICON_TILE, width: 30, height: 30, borderRadius: 9 }}>
          <ApiOutlined style={{ fontSize: 15 }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {server.name}
            </span>
            {isBuiltIn && (
              <Tag style={{ ...TOOL_TAG, lineHeight: '15px', padding: '0 5px', color: '#888', flexShrink: 0 }}>
                内置
              </Tag>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              columnGap: 6,
              rowGap: 2,
              marginTop: 4,
              fontSize: 11,
              color: '#999',
              minWidth: 0
            }}
          >
            <ServerStatusLine status={server.status} />
            <span style={{ color: '#e0e0e0' }}>·</span>
            <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.join(' · ')}</span>
          </div>
        </div>
        {/* Always-visible actions. Clicks are kept off the card so an action
            never doubles as "open the editor". */}
        <div
          style={{ display: 'flex', alignItems: 'center', flexShrink: 0, marginTop: -2, marginRight: -6 }}
          onClick={(e) => e.stopPropagation()}
        >
          {connected ? (
            <>
              <Tooltip title="停止">
                <Button type="text" size="small" icon={<StopOutlined />} onClick={onStop} />
              </Tooltip>
              <Tooltip title="重启">
                <Button type="text" size="small" icon={<ReloadOutlined />} disabled={busy} onClick={onRestart} />
              </Tooltip>
            </>
          ) : (
            <Tooltip title="启动">
              <Button
                type="text"
                size="small"
                icon={<PlayCircleOutlined />}
                loading={busy}
                disabled={server.status === 'connecting'}
                onClick={onStart}
              />
            </Tooltip>
          )}
          {!isBuiltIn && (
            <Tooltip title="删除">
              <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={onDelete} />
            </Tooltip>
          )}
        </div>
      </div>

      {/* One ellipsized line instead of N wrapped code chips. */}
      {endpoint && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 10,
            padding: '5px 8px',
            borderRadius: 6,
            background: '#f7f7f7',
            minWidth: 0
          }}
        >
          {isRemote ? (
            <LinkOutlined style={{ fontSize: 11, color: '#c0c0c0', flexShrink: 0 }} />
          ) : (
            <span style={{ fontSize: 11, color: '#c0c0c0', flexShrink: 0, fontFamily: 'monospace' }}>$</span>
          )}
          <Tooltip title={endpoint}>
            <code style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: '#666', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {endpoint}
            </code>
          </Tooltip>
        </div>
      )}

      {server.error && (
        <Tooltip title={server.error}>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 6,
              marginTop: 8,
              padding: '6px 8px',
              borderRadius: 6,
              background: 'rgba(255, 77, 79, 0.06)',
              fontSize: 11.5,
              lineHeight: 1.5,
              color: '#cf1322'
            }}
          >
            <CloseCircleOutlined style={{ marginTop: 2, flexShrink: 0 }} />
            <span
              style={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                wordBreak: 'break-word'
              }}
            >
              {server.error}
            </span>
          </div>
        </Tooltip>
      )}

      {/* Every card gets the tool row so a not-yet-connected connector matches its
          neighbours in height; it is a plain count, not a disclosure — expanding the
          tool list grew the card and broke that. The spacer pins it to the bottom so
          a stretched grid row keeps the rows aligned. */}
      <div style={{ flex: 1, minHeight: 10 }} />
      <div style={{ paddingTop: 8, borderTop: '1px solid #f2f2f2' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 20,
            padding: '0 4px',
            marginLeft: -4,
            fontSize: 12,
            color: server.tools.length > 0 ? '#666' : '#c8c8c8'
          }}
        >
          <ToolOutlined style={{ fontSize: 12 }} />
          {`工具 · ${server.tools.length}`}
        </span>
      </div>
    </Card>
  )
}

/** Header actions the capability center renders next to its pill tabs. */
export interface MCPSettingsHandle {
  reloadFromDisk: () => void
  openAddModal: () => void
}

const MCPSettings = React.forwardRef<MCPSettingsHandle>(function MCPSettings(_props, ref) {
  const [servers, setServers] = useState<MCPManagedServer[]>([])
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [formOpen, setFormOpen] = useState(false)
  const [transportCategory, setTransportCategory] = useState('local')
  const [editingServer, setEditingServer] = useState<MCPManagedServer | null>(null)
  const [form] = Form.useForm()
  const { activeProfile, settings } = useAppSettings()

  const refresh = useCallback(async () => {
    try {
      const list = await window.electronAPI.mcpListServers()
      setServers(list)
    } catch (err) {
      console.log('[MCPSettings] Failed to list servers:', err)
    }
  }, [])

  const reloadFromDisk = useCallback(async () => {
    try {
      const result = await window.electronAPI.mcpReloadServers()
      if (result.success && result.servers) {
        setServers(result.servers)
      }
    } catch (err) {
      console.log('[MCPSettings] Failed to reload servers:', err)
    }
  }, [])

  useEffect(() => {
    refresh()
    const onMcpChange = () => refresh()
    window.addEventListener('mcp-state-changed', onMcpChange)
    return () => window.removeEventListener('mcp-state-changed', onMcpChange)
  }, [refresh])

  const handleStart = async (id: string) => {
    setLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await window.electronAPI.mcpStartServer(id)
      await refresh()
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const handleStop = async (id: string) => {
    setLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await window.electronAPI.mcpStopServer(id)
      await refresh()
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const handleRestart = async (id: string) => {
    setLoading((prev) => ({ ...prev, [id]: true }))
    try {
      await window.electronAPI.mcpRestartServer(id)
      await refresh()
    } finally {
      setLoading((prev) => ({ ...prev, [id]: false }))
    }
  }

  const openAddModal = () => {
    setEditingServer(null)
    form.resetFields()
    form.setFieldsValue({ transportType: 'stdio', args: '', envKey: '', envValue: '', headers: [] })
    setTransportCategory('local')
    setFormOpen(true)
  }

  const openEditModal = (server: MCPManagedServer) => {
    setEditingServer(server)
    const tt = server.config.transportType || 'stdio'
    setTransportCategory(tt === 'stdio' ? 'local' : 'http')
    form.setFieldsValue({
      name: server.name,
      transportType: tt,
      command: server.config.command,
      args: (server.config.args || []).join('\n'),
      url: server.config.url || '',
      headers: toHeaderRows(server.config.headers),
    })
    setTransportCategory(tt === 'stdio' ? 'local' : 'http')
    setFormOpen(true)
  }

  const handleDelete = async (server: MCPManagedServer) => {
    if (BUILT_IN_IDS.has(server.id)) return
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除连接器 "${server.name}" 吗？`,
      onOk: async () => {
        await window.electronAPI.mcpUnregisterServer(server.id)
        await refresh()
      }
    })
  }

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      const config: MCPClientConfig = {
        name: values.name,
        transportType: values.transportType || 'stdio',
        command: '',
        args: [],
      }

      if (config.transportType === 'sse' || config.transportType === 'streamable-http') {
        config.url = values.url
        config.headers = fromHeaderRows(values.headers)
      } else {
        config.command = values.command
        config.args = values.args
          ? values.args.split('\n').map((s: string) => s.trim()).filter(Boolean)
          : []
      }

      if (editingServer) {
        await window.electronAPI.mcpUpdateServer(editingServer.id, config)
      } else {
        await window.electronAPI.mcpRegisterServer(config)
      }
      setFormOpen(false)
      await refresh()
      // Trigger background summary generation for newly added/updated servers
      if (activeProfile?.apiKey && activeProfile?.provider) {
        generateMcpSummaries({
          adapter: createLlmAdapter(activeProfile.provider),
          apiKey: activeProfile.apiKey,
          baseURL: activeProfile.baseURL || '',
          model: activeProfile.model || '',
          locale: settings.locale,
        }).catch(() => {})
      }
    } catch {
      // validation failed, form will show errors
    }
  }

  // Expose the former title-row actions to the capability center's pill row.
  React.useImperativeHandle(ref, () => ({ reloadFromDisk, openAddModal }))

  // The built-in connector stays registered for the agent, but it has no user-facing
  // config to show — its card is hidden until the browser tool is reworked.
  const visibleServers = servers.filter((s) => !BUILT_IN_IDS.has(s.id))

  const content = (
    <>
      <style>{CARD_CSS}</style>
      {visibleServers.length === 0 ? (
        <div style={{ padding: '56px 24px', textAlign: 'center' }}>
          <div style={{ ...ICON_TILE, width: 44, height: 44, borderRadius: 13, margin: '0 auto 12px', background: 'rgba(0, 0, 0, 0.04)' }}>
            <ApiOutlined style={{ fontSize: 20, color: '#bbb' }} />
          </div>
          <div style={{ fontSize: 13, color: '#666' }}>还没有连接器</div>
          <div style={{ fontSize: 12, color: '#bbb', marginTop: 4 }}>
            点右上角「添加连接器」新建，或用「重新加载」读取配置文件
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 14
          }}
        >
          {visibleServers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              busy={!!loading[server.id]}
              onOpenEditor={() => openEditModal(server)}
              onStart={() => handleStart(server.id)}
              onStop={() => handleStop(server.id)}
              onRestart={() => handleRestart(server.id)}
              onDelete={() => handleDelete(server)}
            />
          ))}
        </div>
      )}

      {/* Add / Edit dialog — one surface for both the header button and a card click */}
      <Modal
        title={editingServer ? '编辑连接器' : '添加连接器'}
        open={formOpen}
        onCancel={() => setFormOpen(false)}
        width={520}
        maskClosable={false}
        styles={{ body: { maxHeight: '62vh', overflowY: 'auto', paddingTop: 4 } }}
        footer={[
          <Button key="cancel" onClick={() => setFormOpen(false)}>
            取消
          </Button>,
          <Button key="submit" type="primary" onClick={handleSubmit} style={{ background: '#000', borderColor: '#000' }}>
            {editingServer ? '保存' : '添加'}
          </Button>
        ]}
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入服务器名称' }]}>
            <Input placeholder="例如: My MCP Server" />
          </Form.Item>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 14, color: '#333', marginBottom: 8, fontWeight: 500 }}>传输方式</div>
            <Segmented
              block
              value={transportCategory}
              onChange={(val) => {
                setTransportCategory(val)
                form.setFieldsValue({ transportType: val === 'local' ? 'stdio' : 'streamable-http' })
              }}
              options={[
                { label: '本地进程', value: 'local' },
                { label: 'HTTP 远程', value: 'http' },
              ]}
            />
          </div>

          {transportCategory === 'local' && (
            <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '16px 16px 0', marginBottom: 8, background: '#fafafa' }}>
              <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入启动命令' }]}>
                <Input placeholder="例如: npx" />
              </Form.Item>
              <Form.Item name="args" label="参数（每行一个）">
                <Input.TextArea rows={4} placeholder={"-y\nmy-mcp-server@latest\n--flag"} />
              </Form.Item>
            </div>
          )}

          {transportCategory === 'http' && (
            <div style={{ border: '1px solid #e8e8e8', borderRadius: 8, padding: '16px 16px 0', marginBottom: 8, background: '#fafafa' }}>
              <Form.Item label="协议类型" name="transportType">
                <Radio.Group>
                  <Radio value="sse">SSE（传统流式）</Radio>
                  <Radio value="streamable-http">
                    Streamable HTTP
                    <Tag color="blue" style={{ marginLeft: 6, fontSize: 11, lineHeight: '18px' }}>推荐</Tag>
                  </Radio>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="url" label="URL 地址" rules={[{ required: true, message: '请输入 URL' }]}>
                <Input placeholder="例如: https://mcp.amap.com/mcp?key=xxx" />
              </Form.Item>
              <Form.List name="headers">
                {(fields, { add, remove }) => (
                  <Form.Item label="自定义请求头">
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {fields.map(({ key, name }) => (
                        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <Form.Item name={[name, 'key']} noStyle>
                            <Input placeholder="名称，如 Authorization" />
                          </Form.Item>
                          <Form.Item name={[name, 'value']} noStyle>
                            <Input placeholder="值，如 Bearer xxx" />
                          </Form.Item>
                          <Button
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => remove(name)}
                          />
                        </div>
                      ))}
                      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => add({ key: '', value: '' })}>
                        添加请求头
                      </Button>
                    </div>
                  </Form.Item>
                )}
              </Form.List>
            </div>
          )}
        </Form>
      </Modal>
    </>
  )

  return <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
})

export default MCPSettings
