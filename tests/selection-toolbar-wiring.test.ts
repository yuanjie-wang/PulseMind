// 选中文字工具栏（2026-11-06）：对话里选中一段文字，浮出「复制 / 提问」。
// 两个按钮的分工是这次改动的骨架——「复制」人人都有；「提问」只有带 Composer
// 的宿主才接得下来（ChatBody），引用块靠 InputArea 的 quoteRequest 递进草稿，
// 并且必须 token 幂等：宿主每次重渲染都会原样重传同一个对象，不幂等就会把
// 同一段引用叠进去两遍。
//
// 钉住四件容易被后续改动无声抹掉的事：
//   1. ChatBody 真的挂了工具条、并接上 onAsk（没接就是只有「复制」）
//   2. TranscriptView 的复用宿主不挂（那里没有输入框可承接，别顺手加上）
//   3. InputArea 的 token 幂等 + 按行 `> ` 前缀（引用块的样子）
//   4. 文案在 zh/en 都在（缺键会渲染出 chatView.selectionToolbar.copy 这种路径）

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

const CHAT_BODY = 'src/renderer/src/components/chat/ChatBody.tsx'
const TRANSCRIPT_VIEW = 'src/renderer/src/components/chat/TranscriptView.tsx'
const INPUT_AREA = 'src/renderer/src/components/chat/InputArea.tsx'
const TOOLBAR = 'src/renderer/src/components/chat/SelectionToolbar.tsx'

describe('选中文字工具栏 — 接线', () => {
  it('ChatBody 挂载工具条，并把「提问」接到 Composer 通道', () => {
    const body = read(CHAT_BODY)
    // 工具条吃转录的滚动容器：只认落在这个容器里的选区。
    expect(body).toContain('<SelectionToolbar containerRef={scrollRef} onAsk={handleAskSelection} />')
    // 没有这一行，「提问」点了没落点。递下去的是派生值：只放行「属于当前
    // 会话」的请求，换会话后旧的引用不会跟着过河。
    expect(body).toContain('quoteRequest={activeQuoteRequest}')
    // 幂等的载体：每次点击抬一次 token。
    expect(body).toContain('quoteTokenRef.current += 1')
    // 请求是「一次性事件」：InputArea 带 key={conversationId}，换会话重建会把
    // 它内部「已消费」的 ref 归零——宿主若不收回旧请求，重建后的新实例会再
    // 消费一遍，A 会话的引用就跑到 B 会话里（2026-11-06 用户实测的跨会话 bug）。
    expect(body).toContain('onQuoteConsumed={handleQuoteConsumed}')
    expect(body).toContain('const handleQuoteConsumed = useCallback((): void => setQuoteRequest(null), [])')
    // 换会话时丢掉未发出的引用（引用记着自己被摘下的会话，派生过滤即可，
    // 不需要在渲染期改状态——那样 react-hooks/refs 会直接拦下）。
    expect(body).toContain('const activeQuoteRequest = quoteRequest && quoteRequest.conv === conversationId ? quoteRequest : null')
  })

  it('TranscriptView 的复用宿主不挂工具条（那里没有 Composer 承接「提问」）', () => {
    expect(read(TRANSCRIPT_VIEW)).not.toContain('SelectionToolbar')
  })

  it('InputArea 的引用通道 token 幂等，并落成输入框上沿的 chip', () => {
    const input = read(INPUT_AREA)
    expect(input).toContain('quoteRequest?: { token: number; text: string } | null')
    // 同一个 token 重传不算新请求——少了这行守卫，一次渲染会挂两枚 chip。
    expect(input).toContain('if (!quoteRequest || quoteRequest.token === consumedQuoteRef.current) return')
    // 引用是 chip（quotes 数组），不是塞进草稿的 markdown：草稿里一段引用块
    // 看不出边界、也删不干净（2026-11-06 用户裁定：要文件引用那种样式）。
    expect(input).toContain('setQuotes((prev) => [...prev, { id, text: quoteRequest.text }])')
    // 多行选中按行加 `> `，空行退化成裸 `>`（markdown 引用不会断）。
    expect(input).toContain('.map((line) => (line.trim() ? `> ${line}` : \'>\'))')
    // chip 可逐条摘掉：没有 × 就只能连正文一起清空。
    expect(input).toContain('setQuotes((prev) => prev.filter((q) => q.id !== id))')
    // 吃下请求立刻交还宿主（跨会话重放的根因，见 ChatBody 侧断言）。
    expect(input).toContain('onQuoteConsumed?.()')
  })

  it('工具条自身：mousedown 保选区、复制走 clipboard、没有 onAsk 时只出「复制」', () => {
    const toolbar = read(TOOLBAR)
    // 不 preventDefault 的话，按下按钮的瞬间选区就折叠了，复制拿不到文本。
    expect(toolbar).toContain('onMouseDown={(e) => e.preventDefault()}')
    expect(toolbar).toContain('navigator.clipboard.writeText(snapshot.text)')
    expect(toolbar).toContain('{onAsk && (')
    // 选区限定在自己的容器内，侧栏/标题栏的选中不该弹这个条。
    expect(toolbar).toContain('container.contains(range.commonAncestorContainer)')
  })

  it('两条文案在 zh / en 都齐', () => {
    for (const file of ['src/renderer/src/i18n/locales/zh.ts', 'src/renderer/src/i18n/locales/en.ts']) {
      const dict = read(file)
      const block = dict.match(/selectionToolbar: \{[\s\S]*?\n {4}\}/)
      expect(block, `${file} 缺 chatView.selectionToolbar`).not.toBeNull()
      const body = block?.[0] ?? ''
      for (const key of ['label', 'copy', 'copied', 'ask']) {
        expect(body, `${file} 的 selectionToolbar 缺 ${key}`).toContain(`${key}:`)
      }
    }
  })
})
