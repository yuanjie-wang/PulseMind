// ── 浏览器任务空转录的静态开场（用户裁定 2026-11-04）──
// 打开页面后不做任何对话时，侧栏对话 tab 原本是一片空白。现在的形态是一条
// 静态开场：命名当前页面 + 几个建议 chip。它刻意不是 agent 消息——不落库、
// 不花 token、不进上下文（零消息容器因此仍保持「无 DB 行」的既有裁定）。
// vitest 是 node-env、不挂组件，所以除了纯函数（页名回退）之外，接线是不变量
// 的源码断言：ChatView 的触发条件、ChatBody 的落点、chip 点击即发送（同日
// 翻转「只落草稿」）、i18n 两份都齐。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { browserTaskDisplayName } from '../src/renderer/src/utils/browser-task-title'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('browserTaskDisplayName', () => {
  it('prefers the page title', () => {
    expect(browserTaskDisplayName('  Pull requests · GitHub  ', 'https://github.com/pulls')).toBe('Pull requests · GitHub')
  })

  it('falls back to the host without www.', () => {
    expect(browserTaskDisplayName('', 'https://www.example.com/a/b?q=1')).toBe('example.com')
    expect(browserTaskDisplayName(null, 'http://localhost:5173')).toBe('localhost')
  })

  it('returns null for a blank/about:blank page so the caller says 正在打开', () => {
    expect(browserTaskDisplayName(undefined, 'about:blank')).toBeNull()
    expect(browserTaskDisplayName(null, '')).toBeNull()
    expect(browserTaskDisplayName('   ', null)).toBeNull()
  })

  it('returns null instead of throwing on a malformed URL', () => {
    expect(browserTaskDisplayName('', 'not a url')).toBeNull()
  })
})

describe('browser task starter wiring', () => {
  const chatView = read('src/renderer/src/components/layout/ChatView.tsx')
  const chatBody = read('src/renderer/src/components/chat/ChatBody.tsx')
  const starter = read('src/renderer/src/components/browser/BrowserTaskStarter.tsx')

  it('ChatView shows it only for a zero-message browser task outside a live turn', () => {
    const call = chatView.indexOf('<BrowserTaskStarter conversationId={conversationId}')
    expect(call).toBeGreaterThan(-1)
    const guard = chatView.slice(call - 400, call)
    expect(guard).toContain("primary === 'browser'")
    expect(guard).toContain('!hasMessages')
    expect(guard).toContain('!isRequesting')
    expect(guard).toContain('!isStreaming')
  })

  it('ChatBody renders the slot only while the transcript is empty', () => {
    expect(chatBody).toContain('emptySlot?: React.ReactNode')
    expect(chatBody).toContain('{renderedSegments.length === 0 && emptySlot}')
  })

  it('chips SEND on click — one click, no second confirm (2026-11-04 用户裁定)', () => {
    // 翻转「chip 只落草稿」：空态上点建议就是要它跑起来，再让用户按一次发送
    // 是把一次点击拆成两次。草稿通道整个撤掉——没有第二条路径可漂移。
    expect(starter).toContain('onClick={() => onSend(label)}')
    expect(starter).not.toContain('useComposerDraftStore')
    expect(starter).not.toContain('setDraft')
  })

  it('the chip row renders only when a send channel exists (no dead buttons)', () => {
    // 未配置 API 密钥时 ChatBody 窄面挂的是 ApiKeyGuide，没有能发的地方；
    // 这时 chip 整组不渲染，而不是摆一排点了没反应的药丸。
    expect(starter).toContain('{onSend && (')
    expect(chatView).toMatch(/<BrowserTaskStarter conversationId=\{conversationId\} onSend=\{hasApiKey \? sendMessageAndPin : undefined\} \/>/)
    // 发送必须经 sendMessageAndPin（先钉回底部跟随再上抛），不是裸 onSendMessage。
    expect(chatView).toMatch(/<BrowserTaskStarter[^/]*onSend=\{hasApiKey \? sendMessageAndPin/)
  })

  it('names the pane tab of THIS conversation, not whatever the snapshot last held', () => {
    expect(starter).toContain('update.conversationId === conversationId')
  })

  it('ships both locales', () => {
    for (const locale of ['zh', 'en']) {
      const dict = read(`src/renderer/src/i18n/locales/${locale}.ts`)
      for (const key of ['browserTaskOpened', 'browserTaskOpening', 'browserTaskPrompt', 'browserTaskStarter1', 'browserTaskStarter2', 'browserTaskStarter3']) {
        expect(dict, `${locale}.${key}`).toContain(`${key}:`)
      }
    }
  })
})
