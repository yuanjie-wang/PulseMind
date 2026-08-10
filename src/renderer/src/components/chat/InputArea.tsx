import React, { useRef, useEffect, useState } from 'react'
import { Sender } from '@ant-design/x'
import { Button, Dropdown, Modal, App } from 'antd'
import { PlusOutlined, FolderOutlined, FileOutlined, SwapOutlined, ArrowUpOutlined, LoadingOutlined, CloseOutlined, LinkOutlined, ReloadOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import type { LlmProfile } from '../../types/settings'

interface ChromeTab {
  id: string
  pageId?: number
  title: string
  url: string
  favicon?: string
}

export function InputArea({
  isRequesting,
  isStreaming,
  isAwaitingApproval,
  isAwaitingInput,
  hasMessages,
  onSendMessage,
  onCancel,
  profiles,
  activeProfileId,
  onSelectProfile
}: {
  isRequesting: boolean
  isStreaming: boolean
  isAwaitingApproval: boolean
  isAwaitingInput: boolean
  hasMessages: boolean
  onSendMessage: (content: string) => void
  onCancel: () => void
  profiles?: LlmProfile[]
  activeProfileId?: string
  onSelectProfile?: (profileId: string) => void
}): React.ReactElement {
  const [inputValue, setInputValue] = useState('')
  const { t } = useTranslation()
  const { message } = App.useApp()

  const inputHistoryRef = useRef<string[]>([])
  const historyIndexRef = useRef(-1)
  const savedDraftRef = useRef('')
  const senderContainerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!hasMessages && senderContainerRef.current) {
      const textarea = senderContainerRef.current.querySelector('textarea')
      textarea?.focus()
    }
  }, [hasMessages])

  const isInputDisabled = isAwaitingApproval || isAwaitingInput

  const activeProfile = profiles?.find(p => p.id === activeProfileId)
  const activeModelLabel = activeProfile
    ? activeProfile.name
    : t('chatView.selectModel')

  const [selectedFiles, setSelectedFiles] = useState<string[]>([])
  const [selectedFolders, setSelectedFolders] = useState<string[]>([])
  const [selectedUrls, setSelectedUrls] = useState<Array<{ url: string; title: string; pageId?: number }>>([])
  const [chromeTabs, setChromeTabs] = useState<ChromeTab[]>([])
  const [chromeTabsModalOpen, setChromeTabsModalOpen] = useState(false)
  const [chromeTabsLoading, setChromeTabsLoading] = useState(false)
  const [chromeMcpReady, setChromeMcpReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    const listServers = window.electronAPI?.mcpListServers
    if (typeof listServers !== 'function') {
      console.warn('[InputArea] window.electronAPI.mcpListServers missing (stale preload?) — chrome-tab feature disabled')
      return
    }
    const check = () => listServers().then(servers => {
      if (cancelled) return
      const srv = servers.find(s =>
        s.id === 'chrome-devtools' || s.id === 'chromedevtools' || s.name === 'Chrome DevTools'
      )
      setChromeMcpReady(srv?.status === 'connected')
    }).catch(() => {})

    // Retry a few times since MCP server registration may not be ready on mount
    check()
    const timer = setInterval(() => { if (!cancelled) check() }, 1500)
    setTimeout(() => { clearInterval(timer) }, 7500)
    return () => { cancelled = true; clearInterval(timer) }
  }, [])

  const getFileName = (path: string) => path.replace(/^.*[\\/]/, '')

  const handlePickFile = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'All Files', extensions: ['*'] }]
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setSelectedFiles(prev => [...prev, ...result.filePaths])
    }
  }

  const handlePickFolder = async () => {
    const result = await window.electronAPI.showOpenDialog({
      properties: ['openDirectory']
    })
    if (!result.canceled && result.filePaths.length > 0) {
      setSelectedFolders(prev => [...prev, ...result.filePaths])
    }
  }

  const removeFile = (index: number) => {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }

  const removeFolder = (index: number) => {
    setSelectedFolders(prev => prev.filter((_, i) => i !== index))
  }

  const removeUrl = (index: number) => {
    setSelectedUrls(prev => prev.filter((_, i) => i !== index))
  }

  const fetchChromeTabs = async (): Promise<ChromeTab[] | null> => {
    try {
      if (typeof window.electronAPI?.mcpListServers !== 'function') {
        message.warning('Chrome DevTools MCP 不可用（preload 未加载，请重启应用）')
        return null
      }
      // Check if Chrome DevTools MCP is connected
      const servers = await window.electronAPI.mcpListServers()
      const chromeServer = servers.find(s => s.id === 'chrome-devtools')
      if (!chromeServer) {
        message.warning('Chrome DevTools MCP 未注册')
        return null
      }
      if (chromeServer.status !== 'connected') {
        message.info('正在连接 Chrome DevTools MCP...')
        const startResult = await window.electronAPI.mcpStartServer('chrome-devtools')
        if (!startResult.success) {
          message.error('Chrome DevTools MCP 连接失败: ' + (startResult.error || '未知错误'))
          return null
        }
        const updated = await window.electronAPI.mcpGetServer('chrome-devtools')
        if (!updated || updated.status !== 'connected') {
          message.error('Chrome DevTools MCP 未能成功启动')
          return null
        }
      }

      // Call list_pages to get open tabs
      const result = await window.electronAPI.mcpCallTool('chrome-devtools', 'list_pages', {})
      if (!result.success) {
        message.error('获取标签页失败: ' + (result.error || '未知错误'))
        return null
      }

      // Parse tabs from result — prefer structuredContent.pages (canonical JSON
      // from chrome-devtools-mcp) over text-based parsing, since the text format
      // "id: title (url)" causes the URL regex to capture a trailing ")".
      const mcpResult = result.result as Record<string, unknown>
      const structuredPages = mcpResult?.structuredContent as { pages?: ChromeTab[] } | undefined
      let tabs: ChromeTab[] = structuredPages?.pages ?? []

      if (tabs.length === 0) {
        // Fallback: try parsing the text content as JSON
        const content = mcpResult?.content as Array<{ type: string; text?: string }> | undefined
        const textItem = content?.find(c => c.type === 'text')
        const rawText = textItem?.text || ''
        if (!rawText) {
          message.warning('未获取到标签页信息')
          return null
        }

        try {
          const parsed = JSON.parse(rawText)
          if (Array.isArray(parsed)) {
            tabs = parsed
          } else if (parsed.tabs && Array.isArray(parsed.tabs)) {
            tabs = parsed.tabs
          } else if (parsed.pages && Array.isArray(parsed.pages)) {
            tabs = parsed.pages
          } else if (parsed.results && Array.isArray(parsed.results)) {
            tabs = parsed.results
          }
        } catch {
          // Last resort: extract URL + pageId from text format:
          //   "{pageId}: Title (url)"  or  "{pageId}: url"
          const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean)
          for (const line of lines) {
            const urlMatch = line.match(/https?:\/\/[^\s)]+/)
            if (urlMatch) {
              const idMatch = line.match(/^(\d+):/)
              tabs.push({
                id: idMatch ? idMatch[1] : '',
                title: line.replace(urlMatch[0], '').replace(/^[\d]+:\s*/, '').replace(/\s*\[selected\]\s*/, '').replace(/\s*\(\)\s*$/, '').trim() || '(无标题)',
                url: urlMatch[0]
              })
            }
          }
        }
      }

      if (tabs.length === 0) {
        message.warning('无法从 Chrome 获取标签页列表')
        return null
      }

      // Map MCP page id to pageId so the LLM can call select_page directly
      for (const tab of tabs) {
        const rawId = (tab as any).id ?? (tab as any).pageId
        tab.pageId = typeof rawId === 'number' ? rawId : parseInt(String(rawId), 10) || undefined
      }

      // Windows Chrome MCP 不返回 title，从 URL 提取
      for (const tab of tabs) {
        if (!tab.title || tab.title === '(无标题)') {
          try {
            const u = new URL(tab.url)
            tab.title = u.hostname.replace(/^www\./, '')
          } catch {
            tab.title = tab.url.split('/').filter(Boolean)[0] || tab.url
          }
        }
      }

      return tabs
    } catch (err) {
      message.error('获取 Chrome 标签页失败: ' + (err instanceof Error ? err.message : String(err)))
      return null
    }
  }

  const handlePickUrl = async () => {
    setChromeTabsLoading(true)
    try {
      const tabs = await fetchChromeTabs()
      if (tabs && tabs.length > 0) {
        setChromeTabs(tabs)
        setChromeTabsModalOpen(true)
      }
    } finally {
      setChromeTabsLoading(false)
    }
  }

  const refreshChromeTabs = async () => {
    setChromeTabsLoading(true)
    try {
      const tabs = await fetchChromeTabs()
      if (tabs && tabs.length > 0) {
        setChromeTabs(tabs)
      }
    } finally {
      setChromeTabsLoading(false)
    }
  }

  const modelItems = profiles?.map(p => ({
    key: p.id,
    label: p.name || `${p.provider ?? ''}:${p.model}`,
    onClick: () => onSelectProfile?.(p.id)
  })) ?? []

  return (
    <div ref={senderContainerRef} style={{ position: 'absolute', bottom: 0, left: 0, right: 0, zIndex: 10, padding: '12px 24px 24px' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <Sender
        autoSize={{ minRows: 1, maxRows: 8 }}
        header={selectedFiles.length + selectedFolders.length + selectedUrls.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4, padding: '5px 0 0 5px' }}>
            {selectedUrls.map((u, i) => (
              <span key={`u-${i}`} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: '#e8e8e8', borderRadius: 12, padding: '2px 6px', fontSize: 12
              }}>
                <LinkOutlined style={{ fontSize: 12, color: '#666' }} />
                <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                  {u.title}
                </span>
                <span onClick={() => removeUrl(i)} style={{ cursor: 'pointer', color: '#999', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><CloseOutlined style={{fontSize:12}} /></span>
              </span>
            ))}
            {selectedFolders.map((fp, i) => (
              <span key={`f-${i}`} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: '#e8e8e8', borderRadius: 12, padding: '2px 6px', fontSize: 12
              }}>
                <FolderOutlined style={{ fontSize: 12, color: '#666' }} />
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                  {getFileName(fp)}
                </span>
                <span onClick={() => removeFolder(i)} style={{ cursor: 'pointer', color: '#999', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><CloseOutlined style={{fontSize:12}} /></span>
              </span>
            ))}
            {selectedFiles.map((fp, i) => (
              <span key={`fi-${i}`} style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                background: '#e8e8e8', borderRadius: 12, padding: '2px 6px', fontSize: 12
              }}>
                <FileOutlined style={{ fontSize: 12, color: '#666' }} />
                <span style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }}>
                  {getFileName(fp)}
                </span>
                <span onClick={() => removeFile(i)} style={{ cursor: 'pointer', color: '#999', padding: '0 2px', flexShrink: 0, display: 'inline-flex', alignItems: 'center' }}><CloseOutlined style={{fontSize:12}} /></span>
              </span>
            ))}
          </div>
        ) : undefined}
        footer={
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
            <Button size="small" type="text" icon={<PlusOutlined style={{ fontSize: 14 }} />} onClick={handlePickFile} style={{ fontSize: 12, color: '#666' }} />
            <Button size="small" type="text" icon={<FolderOutlined style={{ fontSize: 14 }} />} onClick={handlePickFolder} style={{ fontSize: 12, color: '#666' }} />
            <Button size="small" type="text" icon={<LinkOutlined style={{ fontSize: 14 }} />} onClick={handlePickUrl} loading={chromeTabsLoading} disabled={!chromeMcpReady} style={{ fontSize: 12, color: '#666' }} />
            <Dropdown menu={{ items: modelItems }} trigger={['click']}>
              <Button size="small" type="text" icon={<SwapOutlined />} style={{ fontSize: 12, color: '#666' }}>
                {activeModelLabel}
              </Button>
            </Dropdown>
            <Button size="small" type="primary" shape="circle" icon={isRequesting ? <LoadingOutlined /> : <ArrowUpOutlined />} disabled={!isRequesting && !inputValue.trim()} style={{ marginLeft: 'auto' }} onClick={() => {
              if (isRequesting) {
                onCancel()
                return
              }
              const val = inputValue.trim()
              if (val) {
                const parts = [
                  ...selectedUrls.map(u => `[${u.title}](${u.url})` + (u.pageId ? `\n[chrome: pageId=${u.pageId}]` : '')),
                  ...selectedFiles.map(p => `[${getFileName(p)}](file:///${p.replace(/\\/g, '/')})`),
                  ...selectedFolders.map(p => `[${getFileName(p)}](file:///${p.replace(/\\/g, '/')})`),
                ]
                const message = parts.length > 0 ? parts.join('\n') + (val ? '\n' + val : '') : val
                if (inputHistoryRef.current.length === 0 || inputHistoryRef.current[inputHistoryRef.current.length - 1] !== message) {
                  inputHistoryRef.current.push(message)
                }
                historyIndexRef.current = -1
                onSendMessage(message)
                setInputValue('')
                setSelectedFiles([])
                setSelectedFolders([])
                setSelectedUrls([])
              }
            }} />
          </div>
        }
        value={inputValue}
        onChange={(v) => setInputValue(v as string)}
        loading={isRequesting && !isInputDisabled}
        placeholder={
          isAwaitingApproval
            ? t('chatView.sender.approving')
            : isAwaitingInput
            ? t('chatView.sender.awaitingInput')
            : isStreaming
            ? t('chatView.sender.streaming')
            : t('chatView.sender.default')
        }
        disabled={isInputDisabled}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp') {
            if (inputHistoryRef.current.length === 0) return
            e.preventDefault()
            if (historyIndexRef.current === -1) {
              savedDraftRef.current = inputValue
              historyIndexRef.current = inputHistoryRef.current.length - 1
            } else if (historyIndexRef.current > 0) {
              historyIndexRef.current--
            } else {
              return
            }
            setInputValue(inputHistoryRef.current[historyIndexRef.current])
          } else if (e.key === 'ArrowDown') {
            if (historyIndexRef.current === -1) return
            e.preventDefault()
            if (historyIndexRef.current < inputHistoryRef.current.length - 1) {
              historyIndexRef.current++
              setInputValue(inputHistoryRef.current[historyIndexRef.current])
            } else {
              historyIndexRef.current = -1
              setInputValue(savedDraftRef.current)
            }
          }
        }}
        onSubmit={(val) => {
          if (val && typeof val === 'string') {
            const trimmed = val.trim()
            if (!trimmed && selectedFiles.length === 0 && selectedFolders.length === 0 && selectedUrls.length === 0) return
            const parts = [
              ...selectedUrls.map(u => `[${u.title}](${u.url})` + (u.pageId ? `\n[chrome: pageId=${u.pageId}]` : '')),
              ...selectedFiles.map(p => `[file:${p}]`),
              ...selectedFolders.map(p => `[folder:${p}]`),
            ]
            const message = parts.length > 0 ? parts.join('\n') + (trimmed ? '\n' + trimmed : '') : trimmed
            if (inputHistoryRef.current.length === 0 || inputHistoryRef.current[inputHistoryRef.current.length - 1] !== message) {
              inputHistoryRef.current.push(message)
            }
            historyIndexRef.current = -1
            onSendMessage(message)
            setInputValue('')
            setSelectedFiles([])
            setSelectedFolders([])
            setSelectedUrls([])
          }
        }}
        onCancel={onCancel}
      />
      </div>

      <Modal
        title={<div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>选择 Chrome 标签页<Button size="small" type="text" icon={<ReloadOutlined />} loading={chromeTabsLoading} onClick={refreshChromeTabs} /></div>}
        open={chromeTabsModalOpen}
        onCancel={() => setChromeTabsModalOpen(false)}
        footer={null}
        width={520}
      >
        <div style={{ maxHeight: 400, overflow: 'auto' }}>
          {chromeTabs.map((tab, i) => (
            <div
              key={tab.id || i}
              onClick={() => {
                setSelectedUrls(prev => prev.some(u => u.url === tab.url) ? prev : [...prev, { url: tab.url, title: tab.title || tab.url, pageId: tab.pageId }])
                setChromeTabsModalOpen(false)
              }}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', cursor: 'pointer', borderRadius: 6,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#f5f5f5' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
            >
              {tab.favicon
                ? <img src={tab.favicon} style={{ width: 16, height: 16, flexShrink: 0 }} alt="" />
                : <LinkOutlined style={{ fontSize: 14, color: '#999', flexShrink: 0 }} />
              }
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tab.title || '(无标题)'}
                </div>
                <div style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {tab.url}
                </div>
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  )
}
