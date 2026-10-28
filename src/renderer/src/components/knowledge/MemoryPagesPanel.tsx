// ── Memory pages browser（PLAN-capability-followups E5/E1，2026-10-25）──
// 记忆页（偏好/决策/事实）与经验页的共享浏览件：类型过滤 + FTS 搜索 + 详情
// Modal（正文/别名/links/取代谱系/脚本只读）。两个宿主：
//   - MemorySettings（E5：记忆浏览面，不含经验——类型筛选只给记忆三型，「全部」与
//     搜索两路也排除 experience，见 load；2026-10-28 用户裁定「记忆中不用出现经验」）
//     ——无头卡，正文即卡；
//   - CapabilityCenter 经验分区（E1：type 锁定 experience）——**技能卡同壳**
//     （CapabilityCard，2026-10-26 用户裁定「经验卡片的样式应该和普通技能一致」）：
//     同头部/圆角/动作区/栅格，点卡进三栏浏览器。
// 知识中心不再挂载（E5 还原裁定：知识中心=纯知识库）。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Typography, Input, Segmented, Tag, Empty, Spin, Modal, Popconfirm, Button, Tooltip } from 'antd'
import { DeleteOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { notify } from '../../utils/notify'
import CapabilityCard, { CAPABILITY_GRID, CapabilityEmpty, CapabilitySwitch } from '../common/CapabilityCard'
import { isLivePage, type MemoryPageRecord, type MemoryPageType } from '../../../../shared/memory-pages'

const { Text, Paragraph } = Typography

/** 技能卡正文位展示的一句话：summary（技能式 description）优先；旧页无 summary
 *  时回落正文纯文本摘录——剥掉围栏与标题井号，4 行省略由 Paragraph 负责。 */
function plainExcerpt(body: string): string {
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export const TYPE_COLORS: Record<MemoryPageType, string> = {
  preference: 'green',
  decision: 'orange',
  fact: 'blue',
  experience: 'cyan',
}

/** 取代谱系：从全量记录里追 supersededBy 链（活页 → 被它取代的历代页）。 */
function lineageOf(all: MemoryPageRecord[], page: MemoryPageRecord): MemoryPageRecord[] {
  const byId = new Map(all.map((p) => [p.id, p]))
  const chain: MemoryPageRecord[] = []
  for (const p of all) {
    let cur: MemoryPageRecord | undefined = p
    for (let depth = 0; cur && depth < 16; depth++) {
      if (cur.id === page.id) { chain.push(p); break }
      cur = cur.supersededBy ? byId.get(cur.supersededBy) : undefined
    }
  }
  return chain.sort((a, b) => (b.supersededBy ? 1 : 0) - (a.supersededBy ? 1 : 0))
}

/** 详情 Modal（共享：设置面板/技能中心经验分区）。 */
export function MemoryPageDetailModal({ page, allPages, onClose }: {
  page: MemoryPageRecord | null
  allPages: MemoryPageRecord[]
  onClose: () => void
}): React.ReactElement {
  const { t } = useTranslation()
  return (
    <Modal
      open={!!page}
      onCancel={onClose}
      title={page ? <span><Tag color={TYPE_COLORS[page.type]}>{t(`memoryPages.type.${page.type}`)}</Tag>{page.title}</span> : ''}
      footer={null}
      width={640}
    >
      {page && (
        <div>
          {page.aliases.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {t('memoryPages.aliases')}: {page.aliases.join(' · ')}
            </Text>
          )}
          {page.links.length > 0 && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
              {t('memoryPages.links')}: {page.links.join(' · ')}
            </Text>
          )}
          <Paragraph style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{page.body}</Paragraph>
          {page.retiredAt && (
            <Text type="warning" style={{ fontSize: 12, display: 'block', margin: '8px 0' }}>
              {t('memoryPages.retiredAt', { date: page.retiredAt.slice(0, 10) })}
              {page.retireReason ? `：${page.retireReason}` : ''}
            </Text>
          )}
          {page.files && page.files.length > 0 && (
            <div>
              <Text strong style={{ display: 'block', margin: '12px 0 6px' }}>{t('memoryPages.scripts')}</Text>
              {page.files.map((f) => (
                <Paragraph key={f.path} copyable style={{ fontSize: 12, fontFamily: 'monospace', background: 'var(--pm-sunk, #f5f5f5)', padding: 8, borderRadius: 6, whiteSpace: 'pre-wrap' }}>
                  {`// ${f.path}\n${f.content}`}
                </Paragraph>
              ))}
            </div>
          )}
          {(() => {
            const lineage = lineageOf(allPages, page)
            if (lineage.length < 2) return null
            return (
              <div style={{ marginTop: 12, borderTop: '1px solid var(--pm-border-hairline)', paddingTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12 }}>{t('memoryPages.lineage')}: {lineage.map((p) => p.title).join(' ← ')}</Text>
              </div>
            )
          })()}
        </div>
      )}
    </Modal>
  )
}

export interface MemoryPagesBrowserProps {
  /** 锁定单一类型（E1 经验分区传 'experience'）；undefined = 类型过滤可用。 */
  fixedType?: MemoryPageType
  /** 展示删除按钮（设置面板/经验分区开）。 */
  deletable?: boolean
  /** 提供时点卡片走它（技能中心经验分区 → 三栏浏览器）；缺省保持详情 Modal
   *  （设置面板的记忆浏览）。 */
  onOpenPage?: (page: MemoryPageRecord) => void
  /** 未过滤的总数回报（技能中心经验分区标题右侧的计数，与内置/已安装同款）。
   *  搜索中的命中数不回报——分区标题是总量不是筛选结果。 */
  onCount?: (total: number) => void
}

export default function MemoryPagesBrowser({ fixedType, deletable, onOpenPage, onCount }: MemoryPagesBrowserProps): React.ReactElement {
  const { t } = useTranslation()
  const [pages, setPages] = useState<MemoryPageRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string>(fixedType ?? 'all')
  const [query, setQuery] = useState('')
  // 已提交的搜索词（回车/点放大镜/清空）——输入中不触发 IPC。
  const [submitted, setSubmitted] = useState('')
  const [detail, setDetail] = useState<MemoryPageRecord | null>(null)
  // SOP 固化（PLAN-experience-sop 刀三）：运行中的页 id——按钮转 loading，防并跑。
  const [distillingId, setDistillingId] = useState<string | null>(null)

  // 用户面前的名词跟宿主走：设置面板叫「记忆」，技能中心的经验分区叫「经验」。
  const noun = fixedType === 'experience' ? 'Experience' : ''
  const tx = (key: string): string => t(`memoryPages.${key}${noun}`)
  // 技能中心经验分区 = 技能卡同壳（经验也是技能）；记忆浏览面保持无头卡。
  const skillCardStyle = fixedType === 'experience'

  // 回调走 ref：宿主多半传内联箭头，进 load 的 deps 会让 effect 每次渲染重跑。
  const onCountRef = useRef(onCount)
  useEffect(() => {
    onCountRef.current = onCount
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const type = (fixedType ?? (typeFilter === 'all' ? undefined : typeFilter)) as MemoryPageType | undefined
      // 记忆筐不含经验（2026-10-28 用户裁定「记忆中不用出现经验」——经验已独立为
      // 特殊技能，归技能中心经验分区）：无 fixedType 的宿主在「全部」与搜索两条路
      // 上都排除 experience，与 recall 的消费面排除同款纪律；类型筛选档位已无经验，
      // 漏的只有 type=undefined 这条 store 全类型返回的路。
      const memoryOnly = (rs: MemoryPageRecord[]) => (fixedType ? rs : rs.filter((r) => r.type !== 'experience'))
      const next = memoryOnly(
        submitted
          ? await window.electronAPI.searchMemoryPages({ query: submitted, type, limit: 200 })
          : await window.electronAPI.listMemoryPages(type)
      )
      setPages(next)
      if (!submitted) onCountRef.current?.(next.length)
    } finally {
      setLoading(false)
    }
  }, [fixedType, typeFilter, submitted])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load, no cascading renders
    load()
  }, [load])

  const handleDelete = async (id: string): Promise<void> => {
    await window.electronAPI.deleteMemoryPage(id)
    notify.success(t('memoryPages.deleted'))
    await load()
  }

  /** 刀三：把一条 clue 态经验页送进无人值守固化。完成/失败经桌面通知回卡。 */
  const handleDistillSop = async (id: string): Promise<void> => {
    setDistillingId(id)
    try {
      const result = await window.electronAPI.distillSop(id)
      if (result.error) notify.error(result.error)
      else notify.success(t('memoryPages.distillStarted'))
      await load()
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDistillingId(null)
    }
  }

  /** 经验卡开关（2026-10-27，与技能卡同款）：乐观更新本地态——拨开关不该让整个
   *  网格转圈；IPC 失败回滚并提示。停用的语义在消费侧（候选表/提示/自动固化）。
   *  默认打开：只有显式 false 才算停用（与存储层「只有显式 0 才算停用」同口径，
   *  字段缺席——比如开发态主进程未重启的旧记录——不得被读成关）。 */
  const handleToggleEnabled = async (p: MemoryPageRecord): Promise<void> => {
    const wasOn = p.enabled !== false
    const next = !wasOn
    setPages((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: next } : x)))
    try {
      await window.electronAPI.setMemoryPageEnabled(p.id, next)
    } catch (err) {
      setPages((prev) => prev.map((x) => (x.id === p.id ? { ...x, enabled: wasOn } : x)))
      notify.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** 退役恢复（2026-10-27，retire op 的 UI 面）：清空退役软态，页面回活页池。
   *  退役判错的逃生面——园丁的判断必须可逆，否则退役就是另一场静默丢数据。 */
  const handleRestore = async (p: MemoryPageRecord): Promise<void> => {
    try {
      await window.electronAPI.setMemoryPageRetired(p.id, false)
      notify.success(t('memoryPages.restored'))
      await load()
    } catch (err) {
      notify.error(err instanceof Error ? err.message : String(err))
    }
  }

  /** 卡片动作区（两种卡壳共用）：固化为 SOP（刀三：仅 clue 态 + 有源会话指针的活
   *  经验页可点）· 删除。技能卡形态下删除走 danger（与 CapabilityDeleteButton 同重——
   *  Popconfirm 需要能转发 ref 的直接子元素，所以这里直接写 Button 而不包一层）。 */
  const actionButtons = (p: MemoryPageRecord, danger: boolean): React.ReactElement => (
    <>
      {fixedType === 'experience' && p.maturity === 'clue' && isLivePage(p) && p.sourceConversationId && (
        <Popconfirm title={t('memoryPages.distillConfirm')} onConfirm={() => { void handleDistillSop(p.id) }} okText={t('common.confirm')} cancelText={t('common.cancel')}>
          <Button type="text" size="small" loading={distillingId === p.id} icon={<ThunderboltOutlined style={{ color: 'var(--pm-text-faint)' }} />} title={t('memoryPages.distillSop')} />
        </Popconfirm>
      )}
      <Popconfirm title={tx('deleteConfirm')} onConfirm={() => { void handleDelete(p.id) }} okText={t('common.delete')} cancelText={t('common.cancel')} okButtonProps={{ danger: true }}>
        {danger
          ? <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          : <Button type="text" size="small" icon={<DeleteOutlined style={{ color: 'var(--pm-text-faint)' }} />} />}
      </Popconfirm>
    </>
  )

  /** 已退役页的恢复按钮（开关位）：title 带退役理由——审计面就地可读。 */
  const restoreButton = (p: MemoryPageRecord): React.ReactElement => (
    <Tooltip title={p.retireReason ? `${t('memoryPages.retired')}：${p.retireReason}` : t('memoryPages.retired')}>
      <Button type="text" size="small" icon={<UndoOutlined style={{ color: 'var(--pm-text-faint)' }} />} title={t('memoryPages.restore')} onClick={() => { void handleRestore(p) }} />
    </Tooltip>
  )

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        {!fixedType && (
          <Segmented
            value={typeFilter}
            onChange={(v) => { setTypeFilter(v as string); setQuery(''); setSubmitted('') }}
            options={[
              { label: t('memoryPages.all'), value: 'all' },
              { label: t('memoryPages.type.preference'), value: 'preference' },
              { label: t('memoryPages.type.decision'), value: 'decision' },
              { label: t('memoryPages.type.fact'), value: 'fact' },
            ]}
          />
        )}
        <Input.Search
          placeholder={tx('searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onSearch={(v) => setSubmitted(v.trim())}
          allowClear
          style={{ width: 260 }}
        />
      </div>

      {/* 换新不塌高（用户报告：切类型标签页面跳回顶部）：已有数据时保留旧列表，
          半透明过渡到新结果——整卡换成 40px 的 Spin 会让设置面板的内容高度骤减，
          滚动容器被 clamp 上移且一去不回。Spin 只留给尚无数据的首次加载。 */}
      {loading && pages.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : pages.length === 0 ? (
        skillCardStyle
          ? <CapabilityEmpty title={submitted ? t('memoryPages.noMatch') : tx('empty')} />
          : <Empty description={submitted ? t('memoryPages.noMatch') : tx('empty')} />
      ) : skillCardStyle ? (
        // 技能中心经验分区：与 SkillCard 同壳同栅格——头部 icon+title+徽标（SOP/旧版本
        // 站在 内置 徽标的位置），动作区在头部（固化·删除，删除在后且 danger），
        // 正文位放技能式 description（summary），点卡进三栏浏览器。
        <div style={{ ...CAPABILITY_GRID, opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {pages.map((p) => (
            <CapabilityCard
              key={p.id}
              icon={<ThunderboltOutlined />}
              name={p.title}
              dimmed={!!p.supersededBy || !!p.retiredAt}
              badge={
                p.supersededBy ? (
                  <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
                    {t('memoryPages.superseded')}
                  </Tag>
                ) : p.retiredAt ? (
                  <Tag style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
                    {t('memoryPages.retired')}
                  </Tag>
                ) : p.maturity === 'sop' ? (
                  <Tag color="gold" style={{ fontSize: 10, lineHeight: '16px', padding: '0 4px', marginInlineEnd: 0 }}>
                    {t('memoryPages.sopBadge', { count: p.files?.length ?? 0 })}
                  </Tag>
                ) : undefined
              }
              onClick={() => (onOpenPage ? onOpenPage(p) : setDetail(p))}
              actions={
                <>
                  {/* 开关在前、删除在后——CapabilityCard 的动作序；被取代/已退役的旧页没有开关，
                      退役页以恢复按钮顶开关位（园丁的判断必须可逆） */}
                  {isLivePage(p) && <CapabilitySwitch checked={p.enabled !== false} onToggle={() => { void handleToggleEnabled(p) }} />}
                  {p.retiredAt && restoreButton(p)}
                  {deletable && actionButtons(p, true)}
                </>
              }
            >
              <Paragraph
                style={{ fontSize: 12, margin: 0, lineHeight: '1.4', color: 'var(--pm-text-quiet)' }}
                ellipsis={{ rows: 4 }}
              >
                {p.summary ?? plainExcerpt(p.body)}
              </Paragraph>
              {/* 元信息行与技能卡同形：使用次数 · 时间（技能是安装于，经验是提取于） */}
              <div data-card-meta style={{ marginTop: 8, fontSize: 11, color: 'var(--pm-text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {t('memoryPages.useCount', { count: p.useCount })} · {t('memoryPages.extractedAt', { date: p.createdAt.slice(0, 10) })}
              </div>
            </CapabilityCard>
          ))}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, opacity: loading ? 0.5 : 1, transition: 'opacity 0.15s' }}>
          {pages.map((p) => (
            <div
              key={p.id}
              onClick={() => (onOpenPage ? onOpenPage(p) : setDetail(p))}
              style={{
                border: '1px solid var(--pm-border-hairline)', borderRadius: 10, padding: 12, cursor: 'pointer',
                opacity: p.supersededBy || p.retiredAt ? 0.55 : 1,
              }}
            >
              <div style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <Tag color={TYPE_COLORS[p.type]} style={{ marginInlineEnd: 0 }}>{t(`memoryPages.type.${p.type}`)}</Tag>
                {p.maturity === 'sop' && (
                  <Tag color="gold" style={{ marginInlineEnd: 0 }}>
                    {t('memoryPages.sopBadge', { count: p.files?.length ?? 0 })}
                  </Tag>
                )}
                {p.supersededBy && <Tag style={{ marginInlineEnd: 0 }}>{t('memoryPages.superseded')}</Tag>}
                {p.retiredAt && <Tag style={{ marginInlineEnd: 0 }}>{t('memoryPages.retired')}</Tag>}
                {p.useCount > 0 && <Text type="secondary" style={{ fontSize: 11 }}>{t('memoryPages.useCount', { count: p.useCount })}</Text>}
                {(deletable || p.retiredAt) && (
                  <span style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                    {p.retiredAt && restoreButton(p)}
                    {deletable && actionButtons(p, false)}
                  </span>
                )}
              </div>
              <Text strong style={{ fontSize: 13 }}>{p.title}</Text>
              <Paragraph style={{ margin: '6px 0 0', fontSize: 12 }} ellipsis={{ rows: 3 }}>
                {p.body}
              </Paragraph>
              {p.aliases.length > 0 && (
                <Text type="secondary" style={{ fontSize: 11 }}>{t('memoryPages.aliases')}: {p.aliases.join(' · ')}</Text>
              )}
            </div>
          ))}
        </div>
      )}

      {!onOpenPage && <MemoryPageDetailModal page={detail} allPages={pages} onClose={() => setDetail(null)} />}
    </div>
  )
}
