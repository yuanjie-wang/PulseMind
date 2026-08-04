import React, { useEffect, useState, useCallback } from 'react'
import { Button, Tag, Typography, Divider, Tooltip, Modal, Input, Form, Drawer, Radio, Segmented } from 'antd'
import {
  ApiOutlined,
  ReloadOutlined,
  PlayCircleOutlined,
  StopOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  MinusCircleOutlined,
  LoadingOutlined,
  ToolOutlined,
  CaretRightOutlined,
  CaretDownOutlined,
  PlusOutlined,
  EditOutlined,
  DeleteOutlined
} from '@ant-design/icons'
import type { MCPManagedServer, MCPClientConfig } from '../../types/electron'
import { useAppSettings } from '../../hooks/useAppSettings'
import { createLlmAdapter } from '../../llm'
import { generateMcpSummaries } from '../../agent/mcp-summary-service'

const { Text, Title } = Typography

const statusConfig: Record<string, { color: string; icon: React.ReactNode; label: string }> = {
  connected: { color: 'green', icon: <CheckCircleOutlined />, label: '已连接' },
  connecting: { color: 'blue', icon: <LoadingOutlined />, label: '连接中' },
  stopped: { color: 'default', icon: <MinusCircleOutlined />, label: '已停止' },
  error: { color: 'red', icon: <CloseCircleOutlined />, label: '错误' },
}

interface MCPSettingsProps {
  inline?: boolean
  open?: boolean
  onClose?: () => void
}

export default function MCPSettings({ inline = true, open, onClose }: MCPSettingsProps) {
  const [servers, setServers] = useState<MCPManagedServer[]>([])
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set())
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
    form.setFieldsValue({ transportType: 'stdio', args: '', envKey: '', envValue: '' })
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
      headers: server.config.headers ? JSON.stringify(server.config.headers, null, 2) : '',
    })
    setTransportCategory(tt === 'stdio' ? 'local' : 'http')
    setFormOpen(true)
  }

  const handleDelete = async (server: MCPManagedServer) => {
    if (server.id === 'chrome-devtools') return
    Modal.confirm({
      title: '确认删除',
      content: `确定要删除 MCP 服务器 "${server.name}" 吗？`,
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
        config.headers = values.headers ? (() => {
          try { return JSON.parse(values.headers) } catch { return undefined }
        })() : undefined
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
    } catch (err) {
      // validation failed, form will show errors
    }
  }

  const content = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Title level={5} style={{ margin: 0 }}>MCP 服务器</Title>
        <div style={{ display: 'flex', gap: 6 }}>
          <Tooltip title="从配置文件重新加载">
            <Button size="small" icon={<ReloadOutlined />} onClick={reloadFromDisk} />
          </Tooltip>
          <Tooltip title="添加服务器">
            <Button size="small" icon={<PlusOutlined />} onClick={openAddModal} />
          </Tooltip>
        </div>
      </div>

      {servers.length === 0 ? (
        <div style={{ padding: 32, textAlign: 'center', color: '#999' }}>
          <ApiOutlined style={{ fontSize: 32, display: 'block', marginBottom: 8 }} />
          <Text type="secondary">没有注册的 MCP 服务器</Text>
        </div>
      ) : (
        servers.map((server) => {
          const cfg = statusConfig[server.status] || statusConfig.stopped
          const isBuiltIn = server.id === 'chrome-devtools'
          return (
            <div
              key={server.id}
              style={{
                border: '1px solid #f0f0f0',
                borderRadius: 8,
                padding: 16,
                marginBottom: 12,
                background: '#fafafa'
              }}
            >
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <ApiOutlined style={{ fontSize: 18, color: '#666' }} />
                  <Text strong>{server.name}</Text>
                  {isBuiltIn && <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px' }}>内置</Tag>}
                  <Tag icon={cfg.icon} color={cfg.color}>{cfg.label}</Tag>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  {server.status !== 'connected' && (
                    <Tooltip title="启动">
                      <Button
                        size="small"
                        icon={<PlayCircleOutlined />}
                        onClick={() => handleStart(server.id)}
                        loading={loading[server.id]}
                        disabled={server.status === 'connecting'}
                      />
                    </Tooltip>
                  )}
                  {server.status === 'connected' && (
                    <>
                      <Tooltip title="停止">
                        <Button
                          size="small"
                          icon={<StopOutlined />}
                          onClick={() => handleStop(server.id)}
                          loading={loading[server.id]}
                        />
                      </Tooltip>
                      <Tooltip title="重启">
                        <Button
                          size="small"
                          icon={<ReloadOutlined />}
                          onClick={() => handleRestart(server.id)}
                          loading={loading[server.id]}
                        />
                      </Tooltip>
                    </>
                  )}
                  {!isBuiltIn && (
                    <>
                      <Tooltip title="编辑">
                        <Button size="small" icon={<EditOutlined />} onClick={() => openEditModal(server)} />
                      </Tooltip>
                      <Tooltip title="删除">
                        <Button size="small" icon={<DeleteOutlined />} onClick={() => handleDelete(server)} />
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>

              {/* Config detail */}
              <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                {server.config.transportType === 'sse' || server.config.transportType === 'streamable-http' ? (
                  <span>
                    <ApiOutlined style={{ marginRight: 4 }} />
                    <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 3 }}>{server.config.url}</code>
                  </span>
                ) : (
                  <>
                    <code style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 3 }}>{server.config.command}</code>
                    {server.config.args.length > 0 && (
                      <span style={{ marginLeft: 4 }}>
                        {server.config.args.map((a, i) => (
                          <code key={i} style={{ background: '#f0f0f0', padding: '1px 4px', borderRadius: 3, marginLeft: 2 }}>{a}</code>
                        ))}
                      </span>
                    )}
                  </>
                )}
              </div>

              {/* Server info */}
              {server.serverInfo && (
                <div style={{ fontSize: 12, color: '#888', marginBottom: 4 }}>
                  {server.serverInfo.name} v{server.serverInfo.version}
                </div>
              )}

              {/* Error */}
              {server.error && (
                <div style={{ fontSize: 12, color: 'red', marginBottom: 4 }}>
                  {server.error}
                </div>
              )}

              {/* Tools */}
              {server.tools.length > 0 && (
                <>
                  <Divider style={{ margin: '8px 0' }} />
                  <div
                    style={{ fontSize: 12, color: '#666', marginBottom: 4, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                    onClick={() => {
                      setExpandedTools((prev) => {
                        const next = new Set(prev)
                        if (next.has(server.id)) next.delete(server.id)
                        else next.add(server.id)
                        return next
                      })
                    }}
                  >
                    {expandedTools.has(server.id) ? <CaretDownOutlined /> : <CaretRightOutlined />}
                    <ToolOutlined />
                    可用工具 ({server.tools.length})
                  </div>
                  {expandedTools.has(server.id) && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {server.tools.map((tool) => (
                        <Tag key={tool.name} style={{ fontSize: 11 }}>{tool.name}</Tag>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })
      )}

      {/* Add / Edit Drawer */}
      <Drawer
        title={editingServer ? '编辑 MCP 服务器' : '添加 MCP 服务器'}
        open={formOpen}
        onClose={() => setFormOpen(false)}
        size="default"
        footer={
          <div style={{ textAlign: 'right' }}>
            <Button onClick={() => setFormOpen(false)} style={{ marginRight: 8 }}>取消</Button>
            <Button type="primary" onClick={handleSubmit} style={{ background: '#000', borderColor: '#000' }}>
              {editingServer ? '保存' : '添加'}
            </Button>
          </div>
        }
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
              <Form.Item name="headers" label="自定义请求头 (JSON 格式)">
                <Input.TextArea rows={3} placeholder='{"Authorization": "Bearer xxx"}' />
              </Form.Item>
            </div>
          )}
        </Form>
      </Drawer>
    </>
  )

  if (inline) {
    return <div style={{ height: '100%', overflow: 'auto' }}>{content}</div>
  }

  return (
    <Drawer title="MCP 服务器" open={open} onClose={onClose} size={400}>
      {content}
    </Drawer>
  )
}
