// ── 浏览器任务的空转录开场 ──
// 浏览器任务容器是「零消息会话」（createBrowserTask 只铸容器，不发 LLM 回
// 合），侧栏对话 tab 因此是一片空白——用户不一定知道这一列可以继续聊。这里
// 给空转录一条静态开场：打开的是哪一页、可以让我做什么，外加几个建议 chip。
//
// 刻意不是 agent 消息（用户裁定 2026-11-04）：不落库、不花 token、不进上下
// 文，也就不会把零消息容器变成有 DB 行的会话（重启后留下一条没有页面的开场
// 白）。页名从 pane 快照实时读——标题未落先用域名，页面被换掉也跟着变。
//
// chip 点击 = 直接发送（2026-11-04 用户裁定，翻转「只落草稿」）：这里是空转
// 录，点建议就是要它跑起来，再让用户按一次发送是把一次点击拆成两次。发送走
// ChatView 的 sendMessageAndPin（乐观消息即刻到 → 空态开场随之让位）；没有
// 可用的发送通道时（未配置 API 密钥，ChatBody 窄面此时挂的是 ApiKeyGuide）
// chip 整组不渲染——摆一个点了没反应的按钮比不摆更糟。

import React from 'react'
import { useTranslation } from '../../i18n/useTranslation'
import { useBrowserPaneStore } from '../../stores/browserPaneStore'
import { browserTaskDisplayName } from '../../utils/browser-task-title'
import { PromptChip } from '../chat/PromptChip'
import type { PaneTabInfo } from '../../../../shared/browser/pane'

/** The tab whose name the greeting speaks for: the pane's ACTIVE tab, else the
 *  first one. Only tabs of THIS conversation qualify — the pane snapshot can
 *  still name the previously bound conversation for a frame while a new browser
 *  task binds, and speaking for someone else's page is worse than 「正在打开」. */
function pageTab(tabs: PaneTabInfo[]): PaneTabInfo | undefined {
  return tabs.find((tab) => tab.active) ?? tabs[0]
}

export function BrowserTaskStarter({
  conversationId,
  onSend,
}: {
  conversationId?: string
  onSend?: (content: string) => void
}): React.ReactElement {
  const { t } = useTranslation()
  const update = useBrowserPaneStore((s) => s.update)
  const scoped = !update.conversationId || update.conversationId === conversationId ? update.tabs : []
  const tab = pageTab(scoped)
  const name = tab ? browserTaskDisplayName(tab.title, tab.url) : null
  const chips = [t('welcome.browserTaskStarter1'), t('welcome.browserTaskStarter2'), t('welcome.browserTaskStarter3')]

  return (
    <div data-browser-task-starter style={{ maxWidth: 1000, margin: '16vh auto 0', padding: '0 24px' }}>
      <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.5, color: 'var(--pm-text-strong)' }}>
        {name ? t('welcome.browserTaskOpened', { name }) : t('welcome.browserTaskOpening')}
      </div>
      <div style={{ marginTop: 6, fontSize: 13, color: 'var(--pm-text-muted)' }}>{t('welcome.browserTaskPrompt')}</div>
      {onSend && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {chips.map((label) => (
            <PromptChip key={label} label={label} onClick={() => onSend(label)} />
          ))}
        </div>
      )}
    </div>
  )
}
