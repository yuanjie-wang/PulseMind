// ── Browser task quick panel (PLAN-layout-modes 二期 2026-11-03；五期重设计) ──
// welcome 任务表单选「浏览器」时的快捷区：与对话/项目模式同一套卡片语言
// （CardShell 卡壳 + 相对时间戳），双卡 band——左「打开网页」（URL 输入 +
// 打开按钮），右「近期访问」（tile + 标题/域名 + 相对时间，可滚动）；零历史
// 时右侧整卡退场，band 只剩 URL 区（见历史卡处的用户裁定）。
// 回车或点历史项 = onBrowserTaskStart(归一化 URL)——App 侧 createBrowserTask
// 铸零消息容器会话（三期裁定：直接开页，不发「打开 <url>」），pane 绑定
// 就绪后开页签直达。数据源是全局访问历史（browserHistoryStore——地址栏联想
// 同一份；空串查询 = 全量按 last_visit_at 倒序）。

import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'antd'
import { ArrowRightOutlined, ClockCircleOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { normalizeAddressBarInput } from '../../../../shared/browser/pane'
import { describeRelativeTimeText } from '../../utils/relative-time'
import { useWelcomeShake } from '../../utils/welcome-shake'
import { CardShell } from './WelcomeSuggestions'

interface HistoryRow {
  url: string
  title: string | null
  visitCount: number
  lastVisitAt: number
}

/** 面板取前 8 条——welcome 快捷区是「最近去过哪」不是全量管理面。 */
const HISTORY_LIMIT = 8

const HOSTNAME_TILE: React.CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 7,
  background: 'var(--pm-bg)',
  border: '1px solid var(--pm-separator-faint)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 12,
  fontWeight: 600,
  color: 'var(--pm-text-muted)',
  flexShrink: 0,
}

/** 域名首字母做 tile 字形（favicon 需要网络，welcome 不发请求）；非 http
 *  形态（about: 等）回落地球字符。 */
function hostnameGlyph(url: string): string {
  try {
    const host = new URL(url).hostname
    const ch = host.replace(/^www\./, '').charAt(0)
    return ch ? ch.toUpperCase() : '◎'
  } catch {
    return '◎'
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/** 未配置密钥时面板照常显示、整体禁用（2026-11-04 用户裁定「输出框还是要
 *  显示的，只是禁用」）：URL 行与「近期访问」都是可读的引导，撤下整块只剩
 *  一张密钥卡，用户连「这里本来能做什么」都看不到。 */
export function BrowserTaskPanel({
  onBrowserTaskStart,
  disabled = false,
}: {
  onBrowserTaskStart: (url: string) => void
  disabled?: boolean
}): React.ReactElement {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [history, setHistory] = useState<HistoryRow[]>([])
  const now = Date.now()
  // 新建任务子菜单「浏览器」档的引导摇晃指向 URL 输入行（composer/project
  // picker 同一套 shake 机制）。
  const urlShakeRef = useRef<HTMLDivElement | null>(null)
  useWelcomeShake('browserUrl', urlShakeRef)
  // 输入框玻璃配方随平台走（Composer 同款裁定：Win 实底 elevated，其余
  // elevated-glass + blur）。
  const [isWin, setIsWin] = useState(false)
  useEffect(() => {
    window.electronAPI
      .getPlatformInfo()
      .then((info) => setIsWin(info.platform === 'win32'))
      .catch(() => {
        /* default to the frosted look */
      })
  }, [])

  useEffect(() => {
    let alive = true
    window.electronAPI
      .browserHistoryQuery('')
      .then((rows) => {
        if (alive) setHistory(rows.slice(0, HISTORY_LIMIT))
      })
      .catch(() => {
        /* 历史不可用 = 空列表，输入框照常工作 */
      })
    return () => {
      alive = false
    }
  }, [])

  const start = (raw: string) => {
    // 禁用态（未配置密钥）= 整块只读，键盘/点击/历史行一律不提交。
    if (disabled) return
    // 归一化与 pane 地址栏同一把尺（缺 scheme 补 https://）；裸前缀/空串
    // 静默不提交——回车打空 nothing happens，不给假反馈。
    const normalized = normalizeAddressBarInput(raw)
    if (!normalized || normalized === 'https://') return
    onBrowserTaskStart(normalized)
  }

  return (
    <div
      data-pm-browser-task-panel
      style={{ width: '100%', height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 24, containerType: 'inline-size' }}
    >
      {/* 六期裁定：窄窗响应式——容器查询，band 收窄到 660 以下历史列变单列
          （内联样式写不了 @container，随组件携带一张 style 表）。注意两栏
          基础定义也必须住在这张表里——内联 gridTemplateColumns 优先级高于
          任何样式表规则（含 @container 命中后的单列），查了等于白查。 */}
      <style>{`
        [data-pm-browser-task-grid] { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
        @container (max-width: 660px) { [data-pm-browser-task-grid] { grid-template-columns: minmax(0, 1fr); } }
      `}</style>
      {/* URL 区（八期裁定）：不要灰卡底——card-soft 衬得臃肿，输入框自己就
          是视觉锚点（antd 自带表面色，明暗主题自适应）。label 行沿用
          CardShell 的字距；wrapper flexShrink 0：压缩只发生在历史卡。 */}
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {/* 标题行 = 项目卡「选择项目，开始新任务」同款：15/600 text-strong +
            13 muted 向右箭头。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 600, color: 'var(--pm-text-strong)' }}>
          <span>{t('welcome.browserOpenCard')}</span>
          <ArrowRightOutlined style={{ fontSize: 13, color: 'var(--pm-text-muted)' }} />
        </div>
        <div ref={urlShakeRef} data-welcome-shake="browserUrl" style={{ position: 'relative', flexShrink: 0 }}>
          <Input
            data-pm-browser-task-url
            disabled={disabled}
            // 禁用态不抢焦点：welcome 上 key 引导卡才是该被看到的东西，且
            // disabled 的输入框本来也聚焦不上——autoFocus 只留给可用态。
            autoFocus={!disabled}
            placeholder={t('welcome.browserUrlPlaceholder')}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onPressEnter={(e) => {
              // 回车按下 → start 同步物化会话 → dock 对话 tab 挂载 composer 并
              // autoFocus——同一个物理按键的 keypress 会派发到那个新 textarea，
              // 凭空插进一个换行（用户实测：提交后输入框里多了一个回车）。
              // keydown 在这里 preventDefault 后 keypress 不再派发，串场即断。
              e.preventDefault()
              // IME 组合态回车是选词不是提交（与 composer 的 isComposing 纪律
              // 同源）——组合回车不开启任务。
              if (e.nativeEvent.isComposing) return
              start(url)
            }}
            style={{
              // 边框与阴影 = 对话 Composer 的玻璃卡配方（十期裁定）：veil 1px
              // 边框、glass 阴影、药丸圆角 20、毛玻璃底（Win 实底 elevated）。
              borderRadius: 12,
              // 高度 58 = 48 + 10（2026-11-04 用户裁定）；打开钮是绝对定位
              // 垂直居中，随高度自动居中，无需联动。
              height: 58,
              fontSize: 15,
              // 打开钮内嵌输入框右端（用户裁定 2026-11-04，右距次日再增 5→10）：
              // paddingRight 必须 ≥ 右距 10 + 钮宽 38——长 URL 在 content-box 内
              // 滚动裁切，永远不滚进按钮底下；拿掉这条 padding 文本就会被按钮盖住。
              paddingRight: 57,
              background: isWin ? 'var(--pm-elevated)' : 'var(--pm-elevated-glass)',
              backdropFilter: isWin ? undefined : 'blur(12px)',
              WebkitBackdropFilter: isWin ? undefined : 'blur(12px)',
              border: '1px solid var(--pm-border-veil)',
              boxShadow: 'var(--pm-shadow-glass)',
            }}
          />
          <Button
            type="primary"
            shape="circle"
            icon={<ArrowRightOutlined />}
            aria-label={t('welcome.browserOpenAction')}
            disabled={disabled}
            onClick={() => start(url)}
            style={{ position: 'absolute', top: '50%', right: 10, transform: 'translateY(-50%)', width: 38, height: 38, fontSize: 14 }}
          />
        </div>
      </div>

      {/* 历史卡：近期访问——两栏网格（minmax(0,1fr)：1fr 的 auto 最小尺寸会被
          长 URL 的 nowrap min-content 撑歪，两栏不等宽——必须钳到 0）。wrapper
          flex:1 + minHeight 0：空间不够时本卡收缩、列表自己滚。
          **零历史时整卡退场**（2026-11-04 用户裁定「如果没有访问记录，那么在
          浏览器的 welcome 中，不需要近期访问区」）：没有「暂无访问记录」空壳，
          URL 区就地留在原位、下方留白——空文案不是更好的空态，半屏空卡才更糟。 */}
      {history.length > 0 && (
        <div data-pm-browser-task-history style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <CardShell icon={<ClockCircleOutlined />} label={t('welcome.browserHistoryTitle')} flush>
            <div
              data-pm-browser-task-grid
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'grid', gap: 8, alignContent: 'start', padding: '0 6px 0 0' }}
            >
              {history.map((row) => {
                const when = describeRelativeTimeText(new Date(row.lastVisitAt).toISOString(), now, t)
                return (
                  <div
                    key={row.url}
                    data-pm-browser-task-history-item
                    data-disabled={disabled ? '' : undefined}
                    onClick={() => start(row.url)}
                    onMouseEnter={(e) => {
                      if (disabled) return
                      e.currentTarget.style.background = 'var(--pm-card-soft-hover)'
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent'
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '6px 14px 6px 8px',
                      borderRadius: 10,
                      // 禁用态：可读不可点（start 的守卫之外再收掉手的指针与
                      // hover，光靠守卫会让每一行看起来仍然可点）。
                      cursor: disabled ? 'default' : 'pointer',
                      minHeight: 44,
                    }}
                  >
                    <div style={HOSTNAME_TILE}>{hostnameGlyph(row.url)}</div>
                    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                      <span
                        style={{
                          fontSize: 13,
                          lineHeight: '18px',
                          fontWeight: 600,
                          color: 'var(--pm-text-strong)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {row.title || row.url}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          lineHeight: '15px',
                          color: 'var(--pm-text-faint)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {hostnameOf(row.url)}
                      </span>
                    </div>
                    {when && <span style={{ fontSize: 11, color: 'var(--pm-text-faint)', flexShrink: 0 }}>{when}</span>}
                  </div>
                )
              })}
            </div>
          </CardShell>
        </div>
      )}
    </div>
  )
}
