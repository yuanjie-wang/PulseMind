import React, { useEffect, useMemo, useState } from 'react'
import { Button, Segmented, Spin, Tag, Tree, Typography } from 'antd'
import { ArrowLeftOutlined, FileOutlined, FolderOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import '@ant-design/x-markdown/themes/light.css'
import { CodeHighlight, PlainCode, resolveCodeLang } from '../common/CodeHighlight'
import { useTranslation } from '../../i18n/useTranslation'
import type { SkillState } from '../../skills/types'

const { Text } = Typography

/** Preview cap — the read IPC returns plain text, huge files only waste memory. */
const PREVIEW_LIMIT = 200 * 1024

interface TreeNodeData {
  title: string
  key: string
  icon: React.ReactNode
  isLeaf: boolean
  children?: TreeNodeData[]
}

/** Flat skill-relative paths → antd Tree data; directories sort before files. */
function buildTreeData(paths: string[]): TreeNodeData[] {
  const root: TreeNodeData = { title: '', key: '', icon: null, isLeaf: false, children: [] }
  for (const p of paths) {
    const parts = p.split('/')
    let cur = root
    parts.forEach((part, i) => {
      const key = parts.slice(0, i + 1).join('/')
      let next = cur.children!.find((n) => n.title === part)
      if (!next) {
        const isLeaf = i === parts.length - 1
        next = {
          title: part,
          key,
          icon: isLeaf ? <FileOutlined /> : <FolderOutlined />,
          isLeaf,
          children: isLeaf ? undefined : []
        }
        cur.children!.push(next)
      }
      cur = next
    })
  }
  const sortRec = (node: TreeNodeData): void => {
    if (!node.children) return
    node.children.sort((a, b) => {
      const aDir = !!a.children
      const bDir = !!b.children
      if (aDir !== bDir) return aDir ? -1 : 1
      return a.title.localeCompare(b.title)
    })
    node.children.forEach(sortRec)
  }
  sortRec(root)
  return root.children ?? []
}

type ContentState = 'ready' | 'missing'

interface SkillBrowserProps {
  skills: SkillState[]
  /** Currently viewed skill name. */
  activeName: string
  onSelect: (name: string) => void
  onBack: () => void
}

/** The skill viewer opened by clicking a card: skill list on the left, the
 *  active skill's directory tree in the middle, file preview on the right. */
function SkillBrowser({ skills, activeName, onSelect, onBack }: SkillBrowserProps): React.ReactElement {
  const { t } = useTranslation()
  const [files, setFiles] = useState<string[]>([])
  /** Which skill `files` belongs to — lets "loading" be derived, so no state
   *  is ever set synchronously inside an effect. */
  const [filesSkill, setFilesSkill] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentState, setContentState] = useState<ContentState>('ready')
  /** `${name}/${path}` the loaded content belongs to; mismatch = in flight. */
  const [loadedKey, setLoadedKey] = useState('')
  /** Markdown files render by default; the toggle switches back to source. */
  const [mdSourceView, setMdSourceView] = useState(false)

  const requestedKey = `${activeName}/${selectedFile ?? ''}`
  const loadingFiles = filesSkill !== activeName
  const contentLoading = selectedFile !== null && loadedKey !== requestedKey

  // File list per skill; SKILL.md is the default selection.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .listSkillFiles(activeName)
      .then((list) => {
        if (cancelled) return
        setFiles(list)
        setFilesSkill(activeName)
        setSelectedFile(list.includes('SKILL.md') ? 'SKILL.md' : (list[0] ?? null))
      })
      .catch(() => {
        if (cancelled) return
        setFiles([])
        setFilesSkill(activeName)
        setSelectedFile(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeName])

  // File content per selection.
  useEffect(() => {
    if (!selectedFile) return
    let cancelled = false
    window.electronAPI.readSkillFile(activeName, selectedFile).then((text) => {
      if (cancelled) return
      setContent(text)
      setContentState(text === null ? 'missing' : 'ready')
      setLoadedKey(requestedKey)
    })
    return () => {
      cancelled = true
    }
  }, [activeName, selectedFile, requestedKey])

  const treeData = useMemo(() => buildTreeData(files), [files])
  const fileSet = useMemo(() => new Set(files), [files])

  const truncated = content !== null && content.length > PREVIEW_LIMIT
  const isBinary = content !== null && content.includes('\u0000')
  const previewText = truncated ? content!.slice(0, PREVIEW_LIMIT) : content
  const isMarkdown =
    !!selectedFile && (selectedFile.toLowerCase().endsWith('.md') || selectedFile.toLowerCase().endsWith('.markdown'))

  const renderPreview = (): React.ReactNode => {
    if (!selectedFile) {
      return <Text type="secondary" style={{ fontSize: 12 }}>{t('skills.browser.pickFile')}</Text>
    }
    if (contentLoading) return <Spin />
    if (contentState === 'missing') {
      return <Text type="secondary" style={{ fontSize: 12 }}>{t('skills.browser.unreadable')}</Text>
    }
    if (isBinary) {
      return <Text type="secondary" style={{ fontSize: 12 }}>{t('skills.browser.binary')}</Text>
    }
    const truncatedNote = truncated ? (
      <div style={{ fontSize: 11, color: '#bbb', marginBottom: 6 }}>{t('skills.browser.truncated')}</div>
    ) : null

    // Markdown renders; the toggle falls back to highlighted source.
    if (isMarkdown && !mdSourceView) {
      return (
        <>
          {truncatedNote}
          <div className="x-markdown-light" style={{ fontSize: 13, lineHeight: 1.7 }}>
            <XMarkdown content={previewText ?? ''} />
          </div>
        </>
      )
    }

    const langId = resolveCodeLang(selectedFile)
    if (langId) {
      return (
        <>
          {truncatedNote}
          <CodeHighlight code={previewText ?? ''} lang={langId} />
        </>
      )
    }
    return (
      <>
        {truncatedNote}
        <PlainCode code={previewText ?? ''} />
      </>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flexShrink: 0, marginBottom: 10 }}>
        <Button type="text" size="small" icon={<ArrowLeftOutlined />} onClick={onBack}>
          {t('skills.browser.back')}
        </Button>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'flex',
          border: '1px solid #eee',
          borderRadius: 10,
          overflow: 'hidden'
        }}
      >
        {/* Left: all skills */}
        <div
          style={{
            width: 200,
            flexShrink: 0,
            borderRight: '1px solid #f0f0f0',
            overflowY: 'auto',
            padding: 8,
            boxSizing: 'border-box'
          }}
        >
          {skills.map((skill) => {
            const isActive = skill.definition.name === activeName
            return (
              <div
                key={skill.definition.name}
                onClick={() => onSelect(skill.definition.name)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  marginBottom: 2,
                  borderRadius: 8,
                  cursor: 'pointer',
                  fontSize: 12.5,
                  background: isActive ? 'rgba(0, 0, 0, 0.06)' : undefined,
                  fontWeight: isActive ? 600 : undefined,
                  color: isActive ? '#000' : '#555'
                }}
              >
                <ThunderboltOutlined style={{ flexShrink: 0, fontSize: 11, color: '#999' }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {skill.definition.name}
                </span>
                {!skill.enabled && (
                  <Tag style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                    {t('skills.browser.disabledTag')}
                  </Tag>
                )}
              </div>
            )
          })}
        </div>

        {/* Middle: active skill's directory tree */}
        <div
          style={{
            width: 230,
            flexShrink: 0,
            borderRight: '1px solid #f0f0f0',
            overflowY: 'auto',
            padding: '10px 6px',
            boxSizing: 'border-box'
          }}
        >
          {loadingFiles ? (
            <div style={{ padding: 24, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : files.length === 0 ? (
            <Text type="secondary" style={{ fontSize: 12, padding: '0 8px' }}>
              {t('skills.browser.emptyFiles')}
            </Text>
          ) : (
            <Tree
              key={activeName}
              blockNode
              showIcon
              defaultExpandAll
              treeData={treeData}
              selectedKeys={selectedFile ? [selectedFile] : []}
              onSelect={(keys) => {
                const key = keys[0]
                if (typeof key === 'string' && fileSet.has(key)) setSelectedFile(key)
              }}
            />
          )}
        </div>

        {/* Right: file preview */}
        <div style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 16px', boxSizing: 'border-box' }}>
          {selectedFile && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                marginBottom: 8,
                paddingBottom: 6,
                borderBottom: '1px solid #f2f2f2'
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: '#999',
                  fontFamily: 'Menlo, Consolas, monospace',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {selectedFile}
              </span>
              {isMarkdown && (
                <Segmented
                  size="small"
                  value={mdSourceView ? 'source' : 'rendered'}
                  onChange={(v) => setMdSourceView(v === 'source')}
                  options={[
                    { label: t('skills.browser.rendered'), value: 'rendered' },
                    { label: t('skills.browser.source'), value: 'source' }
                  ]}
                />
              )}
            </div>
          )}
          {renderPreview()}
        </div>
      </div>
    </div>
  )
}

export default SkillBrowser
