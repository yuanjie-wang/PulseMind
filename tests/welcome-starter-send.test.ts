// ── 试试 chips 点一下即发送（用户裁定 2026-11-04）──
// 这条裁决先落在浏览器任务空态（BrowserTaskStarter），同一天用户又把同一个
// 判词给到 welcome：「welcome页面上的对话和项目的气泡也有类似的问题」。所以
// 两个形态共用一份 StarterPrompts，点击直通宿主的发送通道，不再经草稿。
//
// 三道门都在源码里（vitest 是 node-env、不挂组件）：
//   1. StarterPrompts 只有 onSend，点击即调用；没有通道整行返回 null——
//      未配置密钥时 composer 也不挂，摆一排点了没反应的药丸更糟。
//   2. WelcomeContent 把 onStarterSend 同时交给 chat 形态（WelcomeSuggestions）
//      与 project 形态（ProjectCards）——两处各自接一个 prop 就会漂移。
//   3. ChatView 传的是 `hasApiKey ? sendMessageAndPin : undefined`：发送必须
//      经 sendMessageAndPin（先钉回底部跟随再上抛），不是裸 onSendMessage。

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

describe('welcome starter chips send in one click', () => {
  const starters = read('src/renderer/src/components/welcome/StarterPrompts.tsx')
  const suggestions = read('src/renderer/src/components/welcome/WelcomeSuggestions.tsx')
  const projects = read('src/renderer/src/components/welcome/ProjectCards.tsx')
  const welcome = read('src/renderer/src/components/chat/WelcomeContent.tsx')
  const chatView = read('src/renderer/src/components/layout/ChatView.tsx')

  it('the chip calls the send channel on click (no draft pass-through)', () => {
    expect(starters).toContain('onClick={() => onSend(label)}')
    expect(starters).not.toContain('useComposerDraftStore')
    expect(starters).not.toContain('setDraft')
  })

  it('the row renders only when a send channel exists (no dead pills)', () => {
    expect(starters).toContain('if (!onSend) return null')
    expect(starters).toMatch(/React\.ReactElement \| null/)
  })

  it('WelcomeContent forwards the channel to BOTH welcome forms', () => {
    expect(welcome).toContain('onStarterSend?: (text: string) => void')
    // chat 形态
    expect(welcome).toMatch(/<WelcomeSuggestions[^>]*onStarterSend=\{onStarterSend\}/)
    // project 形态
    expect(welcome).toMatch(/<ProjectCards[^>]*onStarterSend=\{onStarterSend\}/)
    // 两个形态都拿同一份，不是各挂各的
    expect(welcome.match(/onStarterSend=\{onStarterSend\}/g)?.length).toBe(2)
  })

  it('the two forms hand their own prompt list to the shared row', () => {
    expect(suggestions).toMatch(/<StarterPrompts labels=\{starters\} onSend=\{onStarterSend\}/)
    expect(projects).toMatch(/<StarterPrompts labels=\{projectStarters\} onSend=\{onStarterSend\}/)
  })

  it('ChatView sends through sendMessageAndPin, gated on the API key', () => {
    expect(chatView).toMatch(/<WelcomeContent[\s\S]*?onStarterSend=\{hasApiKey \? sendMessageAndPin : undefined\}/)
  })

  it('the stale "drop into the composer" wording is gone from the source', () => {
    // 注释是下一个人读到的契约；留着「落草稿」就会有人照着做回去。
    for (const src of [starters, suggestions, projects]) {
      expect(src).not.toContain('落进输入框草稿')
      expect(src).not.toContain('drops the question into the composer')
    }
  })

  it('the one-shot draft channel is gone — no second path to drift back to', () => {
    // 通道的唯一生产者就是这两处 chips；改成直接发送后它已经没有生产者与
    // 消费者，整份删掉。留着等于邀请下一个人「按旧路落草稿」。
    expect(existsSync(join(ROOT, 'src/renderer/src/stores/composerDraftStore.ts'))).toBe(false)
    expect(read('src/renderer/src/components/chat/InputArea.tsx')).not.toContain('useComposerDraftStore')
  })
})
