import React, { useEffect, useState, useCallback } from 'react'
import { Button, Tag, Tooltip, Modal, Input, Form, Radio, Segmented } from 'antd'
import {
  ApiOutlined,
  ReloadOutlined,
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
import CapabilityCard, {
  CAPABILITY_GRID,
  CapabilityDeleteButton,
  CapabilityEmpty,
  CapabilitySwitch
} from '../common/CapabilityCard'

/** A dot, not a filled Tag: on a ~260px card a colored status pill competes with
 *  the server name for the eye, which is exactly the crowding we're removing. */
const STATUS: Record<MCPManagedServer['status'], { color: string; label: string; pulse?: boolean }> = {
// The connected/error dot hues stay literals on purpose (the same judgment as
// the run-status icons): antd's green-6/red-5 carry enough contrast on a dark
// ground as-is, and a connection state must not shift hue with the theme.
  connected: { color: '#52c41a', label: '已连接' },
  connecting: { color: 'var(--pm-link)', label: '连接中', pulse: true },
  stopped: { color: 'var(--pm-border)', label: '已停止' },
  error: { color: '#ff4d4f', label: '错误' },
}

const TRANSPORT_LABEL: Record<string, string> = {
  stdio: '本地',
  sse: 'SSE',
  'streamable-http': 'HTTP',
}

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

function ServerStatusLine({ status }: { status: MCPManagedServer['status'] }): React.ReactElement {
  const cfg = STATUS[status] ?? STATUS.stopped
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
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

/** Connector card. What used to make this tab look unlike 技能/专家 was that the
 *  header was hand-rolled inside a headless Card body; the header is now the shared
 *  CapabilityCard head, and the status + transport line moved down into the body.
 *  The whole card is the edit affordance. */
function McpServerCard({
  server,
  busy,
  onOpenEditor,
  onStart,
  onStop,
  onRestart,
  onDelete
}: McpServerCardProps): React.ReactElement {
  const transport = server.config.transportType || 'stdio'
  const isRemote = transport === 'sse' || transport === 'streamable-http'
  const connected = server.status === 'connected'
  // The switch reads "on" while connecting too; flipping it stops/starts the server.
  const active = connected || server.status === 'connecting'
  const endpoint = isRemote
    ? server.config.url || ''
    : [server.config.command, ...(server.config.args ?? [])].filter(Boolean).join(' ')

  // One muted line carries what used to be serverInfo + status + a separate row.
  const meta: string[] = [TRANSPORT_LABEL[transport] ?? transport]
  if (server.tools.length > 0) meta.push(`${server.tools.length} 个工具`)
  if (server.serverInfo?.version) meta.push(`v${server.serverInfo.version}`)

  return (
    <CapabilityCard
      icon={<ApiOutlined style={{ fontSize: 14 }} />}
      name={server.name}
      onClick={onOpenEditor}
      actions={
        <>
          <CapabilitySwitch
            checked={active}
            loading={busy}
            disabled={server.status === 'connecting'}
            onToggle={() => (active ? onStop() : onStart())}
            onLabel="启动"
            offLabel="停止"
          />
          {connected && (
            <Tooltip title="重启">
              <Button type="text" size="small" icon={<ReloadOutlined />} disabled={busy} onClick={onRestart} />
            </Tooltip>
          )}
          <CapabilityDeleteButton onClick={onDelete} />
        </>
      }
      footer={
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 20,
            padding: '0 4px',
            marginLeft: -4,
            fontSize: 12,
            color: server.tools.length > 0 ? 'var(--pm-text-secondary)' : 'var(--pm-text-ghost)'
          }}
        >
          <ToolOutlined style={{ fontSize: 12 }} />
          {`工具 · ${server.tools.length}`}
        </span>
      }
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          flexWrap: 'wrap',
          columnGap: 6,
          rowGap: 2,
          fontSize: 12,
          color: 'var(--pm-text-quiet)',
          minWidth: 0
        }}
      >
        <ServerStatusLine status={server.status} />
        <span style={{ color: 'var(--pm-frame)' }}>·</span>
        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {meta.join(' · ')}
        </span>
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
            background: 'var(--pm-row-hover)',
            minWidth: 0
          }}
        >
          {isRemote ? (
            <LinkOutlined style={{ fontSize: 11, color: 'var(--pm-wash-ink)', flexShrink: 0 }} />
          ) : (
            <span style={{ fontSize: 11, color: 'var(--pm-wash-ink)', flexShrink: 0, fontFamily: 'monospace' }}>$</span>
          )}
          <Tooltip title={endpoint}>
            <code style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: 'var(--pm-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
              background: 'var(--pm-error-bg)',
              fontSize: 11.5,
              lineHeight: 1.5,
              color: 'var(--pm-error)'
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
    </CapabilityCard>
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async server-list refresh on mount and on the external change event below
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

  const content = (
    <>
      <style>{CARD_CSS}</style>
      {servers.length === 0 ? (
        <CapabilityEmpty title="还没有连接器" hint="点右上角「添加连接器」新建，或用「重新加载」读取配置文件" />
      ) : (
        <div style={CAPABILITY_GRID}>
          {servers.map((server) => (
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
          <Button key="submit" type="primary" onClick={handleSubmit} style={{ background: 'var(--pm-ink)', borderColor: 'var(--pm-ink)' }}>
            {editingServer ? '保存' : '添加'}
          </Button>
        ]}
      >
        <Form form={form} layout="vertical" autoComplete="off">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入服务器名称' }]}>
            <Input placeholder="例如: My MCP Server" />
          </Form.Item>
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 14, color: 'var(--pm-text-strong)', marginBottom: 8, fontWeight: 500 }}>传输方式</div>
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
            <div style={{ border: '1px solid var(--pm-border-soft)', borderRadius: 8, padding: '16px 16px 0', marginBottom: 8, background: 'var(--pm-wash)' }}>
              <Form.Item name="command" label="命令" rules={[{ required: true, message: '请输入启动命令' }]}>
                <Input placeholder="例如: npx" />
              </Form.Item>
              <Form.Item name="args" label="参数（每行一个）">
                <Input.TextArea rows={4} placeholder={"-y\nmy-mcp-server@latest\n--flag"} />
              </Form.Item>
            </div>
          )}

          {transportCategory === 'http' && (
            <div style={{ border: '1px solid var(--pm-border-soft)', borderRadius: 8, padding: '16px 16px 0', marginBottom: 8, background: 'var(--pm-wash)' }}>
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

  // No overflow of its own: the capability center's pane is the scroll container, so
  // an over-tall grid scrolls there instead of being clipped here (see its comment).
  return <div style={{ height: '100%' }}>{content}</div>
})

export default MCPSettings
