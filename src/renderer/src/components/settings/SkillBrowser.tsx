import React, { useEffect, useMemo, useState } from 'react'
import { Button, Segmented, Spin, Tag, Tree, Typography } from 'antd'
import { ArrowLeftOutlined, FileOutlined, FolderOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import { CodeHighlight, PlainCode, resolveCodeLang } from '../common/CodeHighlight'
import { useTranslation } from '../../i18n/useTranslation'
import { useMarkdownThemeClass } from '../../theme/mode'
import type { SkillState } from '../../skills/types'
import type { MemoryPageRecord } from '../../../../shared/memory-pages'

const { Text } = Typography

/** Preview cap — the read IPC returns plain text, huge files only waste memory. */
const PREVIEW_LIMIT = 200 * 1024

/** 经验条目的 key 前缀：技能列表用 name 作 key，经验页用页 id——前缀隔离两个命名空间。 */
export const EXPERIENCE_KEY_PREFIX = 'exp:'

export function experienceKey(pageId: string): string {
  return `${EXPERIENCE_KEY_PREFIX}${pageId}`
}

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
  /** Currently viewed entry: a skill name, or experienceKey(id). */
  activeKey: string
  onSelect: (key: string) => void
  onBack: () => void
}

/** 经验页的文件视图：正文是 SKILL.md（经验也是技能——正文文件与技能同名），files 数组还原成 scripts/* 路径——
 *  与 sop-runner 落库、pick_skill 信封的形状一致。 */
function experienceFileList(rec: MemoryPageRecord): string[] {
  return ['SKILL.md', ...(rec.files ?? []).map((f) => f.path)]
}

/** 统一的读取入口：经验从内存记录解析（body → SKILL.md，files → scripts/*），
 *  技能走目录 IPC——两侧经同一个三栏渲染。 */
function readEntryFile(
  activeExperience: MemoryPageRecord | null,
  key: string,
  path: string
): Promise<string | null> {
  if (key.startsWith(EXPERIENCE_KEY_PREFIX)) {
    if (!activeExperience) return Promise.resolve(null)
    if (path === 'SKILL.md') return Promise.resolve(activeExperience.body)
    return Promise.resolve(activeExperience.files?.find((f) => f.path === path)?.content ?? null)
  }
  return window.electronAPI.readSkillFile(key, path)
}

/** The viewer opened by clicking a card: entries list on the left, the active
 *  entry's directory tree in the middle, file preview on the right. Skills read
 *  their pack over IPC; experiences load once from memory_pages and resolve
 *  in-memory, so 经验 rides the exact same three columns as a skill (E1:
 *  展示面跟内容语义走——经验也是技能). */
function SkillBrowser({ skills, activeKey, onSelect, onBack }: SkillBrowserProps): React.ReactElement {
  const { t } = useTranslation()
  const mdClass = useMarkdownThemeClass()
  const [files, setFiles] = useState<string[]>([])
  /** Which entry `files` belongs to — lets "loading" be derived, so no state
   *  is ever set synchronously inside an effect. */
  const [filesSource, setFilesSource] = useState<string | null>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentState, setContentState] = useState<ContentState>('ready')
  /** `${key}/${path}` the loaded content belongs to; mismatch = in flight. */
  const [loadedKey, setLoadedKey] = useState('')
  /** Markdown files render by default; the toggle switches back to source. */
  const [mdSourceView, setMdSourceView] = useState(false)
  const [experiences, setExperiences] = useState<MemoryPageRecord[]>([])
  const [expLoading, setExpLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .listMemoryPages('experience')
      .then((list) => {
        if (cancelled) return
        setExperiences(list)
        setExpLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setExpLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The active experience record — stable null for skill keys, so the effects
  // below never re-run for a skill when the experience list lands.
  const activeExperience = useMemo(
    () =>
      activeKey.startsWith(EXPERIENCE_KEY_PREFIX)
        ? (experiences.find((p) => experienceKey(p.id) === activeKey) ?? null)
        : null,
    [activeKey, experiences]
  )

  const requestedKey = `${activeKey}/${selectedFile ?? ''}`
  const loadingFiles = filesSource !== activeKey
  const contentLoading = selectedFile !== null && loadedKey !== requestedKey

  // File list per entry; SKILL.md is the default selection (for experiences too). An
  // experience key before its records arrive keeps waiting (no state is set),
  // and the effect re-runs when `activeExperience` lands.
  useEffect(() => {
    let cancelled = false
    const load = activeKey.startsWith(EXPERIENCE_KEY_PREFIX)
      ? activeExperience
        ? Promise.resolve(experienceFileList(activeExperience))
        : null // 经验记录未到位：等 deps 变化，期间保持加载态
      : window.electronAPI.listSkillFiles(activeKey)
    if (!load) return
    load
      .then((list) => {
        if (cancelled) return
        setFiles(list)
        setFilesSource(activeKey)
        setSelectedFile(
          list.includes('SKILL.md') ? 'SKILL.md' : (list[0] ?? null)
        )
      })
      .catch(() => {
        if (cancelled) return
        setFiles([])
        setFilesSource(activeKey)
        setSelectedFile(null)
      })
    return () => {
      cancelled = true
    }
  }, [activeKey, activeExperience])

  // File content per selection.
  useEffect(() => {
    if (!selectedFile) return
    let cancelled = false
    readEntryFile(activeExperience, activeKey, selectedFile).then((text) => {
      if (cancelled) return
      setContent(text)
      setContentState(text === null ? 'missing' : 'ready')
      setLoadedKey(requestedKey)
    })
    return () => {
      cancelled = true
    }
  }, [activeKey, selectedFile, requestedKey, activeExperience])

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
      <div style={{ fontSize: 11, color: 'var(--pm-text-faint)', marginBottom: 6 }}>{t('skills.browser.truncated')}</div>
    ) : null

    // Markdown renders; the toggle falls back to highlighted source.
    if (isMarkdown && !mdSourceView) {
      return (
        <>
          {truncatedNote}
          <div className={mdClass} style={{ fontSize: 13, lineHeight: 1.7 }}>
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
          border: '1px solid var(--pm-wash-border)',
          borderRadius: 10,
          overflow: 'hidden'
        }}
      >
        {/* Left: three groups mirroring the grid's sections — 内置 / 已安装 / 经验 */}
        <div
          style={{
            width: 200,
            flexShrink: 0,
            borderRight: '1px solid var(--pm-border-hairline)',
            overflowY: 'auto',
            padding: 8,
            boxSizing: 'border-box'
          }}
        >
          {(() => {
            const groupLabel = (label: string): React.ReactElement => (
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--pm-text-faint)', padding: '10px 10px 4px' }}>
                {label}
              </div>
            )
            const entryRow = (key: string, label: string, tag?: React.ReactNode, dimmed?: boolean): React.ReactElement => {
              const isActive = key === activeKey
              return (
                <div
                  key={key}
                  onClick={() => onSelect(key)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 10px',
                    marginBottom: 2,
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 12.5,
                    opacity: dimmed ? 0.55 : 1,
                    background: isActive ? 'var(--pm-hover)' : undefined,
                    fontWeight: isActive ? 600 : undefined,
                    color: isActive ? 'var(--pm-ink)' : 'var(--pm-text-body)'
                  }}
                >
                  <ThunderboltOutlined style={{ flexShrink: 0, fontSize: 11, color: 'var(--pm-text-muted)' }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {label}
                  </span>
                  {tag}
                </div>
              )
            }
            const builtInSkills = skills.filter((s) => s.definition.builtIn)
            const importedSkills = skills.filter((s) => !s.definition.builtIn)
            return (
              <>
                {builtInSkills.length > 0 && (
                  <>
                    {groupLabel(t('skillsSection.builtIn'))}
                    {builtInSkills.map((skill) =>
                      entryRow(
                        skill.definition.name,
                        skill.definition.name,
                        !skill.enabled ? (
                          <Tag style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                            {t('skills.browser.disabledTag')}
                          </Tag>
                        ) : undefined
                      )
                    )}
                  </>
                )}
                {importedSkills.length > 0 && (
                  <>
                    {groupLabel(t('skillsSection.imported'))}
                    {importedSkills.map((skill) =>
                      entryRow(
                        skill.definition.name,
                        skill.definition.name,
                        !skill.enabled ? (
                          <Tag style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                            {t('skills.browser.disabledTag')}
                          </Tag>
                        ) : undefined
                      )
                    )}
                  </>
                )}
                {expLoading ? (
                  <div style={{ padding: '10px', textAlign: 'center' }}>
                    <Spin />
                  </div>
                ) : experiences.length > 0 ? (
                  <>
                    {groupLabel(t('skillsSection.experience'))}
                    {experiences.map((page) =>
                      entryRow(
                        experienceKey(page.id),
                        page.title,
                        page.supersededBy ? (
                          <Tag style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                            {t('memoryPages.superseded')}
                          </Tag>
                        ) : page.retiredAt ? (
                          <Tag style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                            {t('memoryPages.retired')}
                          </Tag>
                        ) : page.enabled === false ? (
                          <Tag style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                            {t('skills.browser.disabledTag')}
                          </Tag>
                        ) : page.maturity === 'sop' ? (
                          <Tag color="gold" style={{ fontSize: 10, lineHeight: '15px', padding: '0 4px', marginInlineEnd: 0, flexShrink: 0 }}>
                            {t('skills.browser.sopTag')}
                          </Tag>
                        ) : undefined,
                        !!page.supersededBy || !!page.retiredAt
                      )
                    )}
                  </>
                ) : null}
              </>
            )
          })()}
        </div>

        {/* Middle: active entry's directory tree */}
        <div
          style={{
            width: 230,
            flexShrink: 0,
            borderRight: '1px solid var(--pm-border-hairline)',
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
              key={activeKey}
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
                borderBottom: '1px solid var(--pm-card-divider)'
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  color: 'var(--pm-text-muted)',
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
          {activeExperience && selectedFile === 'SKILL.md' && (activeExperience.aliases.length > 0 || activeExperience.useCount > 0) && (
            <div style={{ fontSize: 11, color: 'var(--pm-text-muted)', marginBottom: 8 }}>
              {activeExperience.aliases.length > 0 && (
                <span style={activeExperience.useCount > 0 ? { marginRight: 10 } : undefined}>
                  {t('memoryPages.aliases')}: {activeExperience.aliases.join(' · ')}
                </span>
              )}
              {activeExperience.useCount > 0 && (
                <span>{t('memoryPages.useCount', { count: activeExperience.useCount })}</span>
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
