import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 工具卡头部去重（2026-10-28 用户报告）：加粗动词旁的摘要只渲染「对象半边」
 *  （toolDetailSummary），不再整句 toolBlockSummary——旧形态读作
 *  「运行命令  运行命令 · npm test」。三处头部同改：桌面工具卡头、审批区
 *  identity 行、插件面板 ToolBlock（format.ts 镜像）。ExecutionSegment 的折叠
 *  头没有加粗标签位，那里的整句形式是对的（probe-chat-approval 钉着），不许
 *  反向"修"掉。 */

const read = (p: string) => readFileSync(p, 'utf-8')

describe('工具卡头部的动词只出现一次', () => {
  it('桌面 CollapsibleToolBlock：加粗动词 + 对象半边', () => {
    const src = read('src/renderer/src/components/chat/MessageGroup.tsx')
    expect(src).toContain('const summary = toolDetailSummary(block)')
    expect(src).toContain('{toolDisplayName(block.name, t)}')
    // 整句形式不得再回到这张卡（调用形态；注释里的提法不算）
    expect(src).not.toContain('toolBlockSummary(')
  })

  it('审批区 identity 行：同一对渲染（加粗动词 + 对象半边）', () => {
    const src = read('src/renderer/src/components/chat/ApprovalArea.tsx')
    expect(src).toContain('{toolDetailSummary(block)}')
    expect(src).not.toContain('toolBlockSummary(')
  })

  it('插件面板镜像：format.ts 补 toolDetailSummary，ToolBlock 头同改', () => {
    const fmt = read('src/extension/ui/format.ts')
    expect(fmt).toContain('export function toolDetailSummary')
    const src = read('src/extension/ui/MessageBlocks.tsx')
    expect(src).toContain('const summary = toolDetailSummary(block)')
    expect(src).not.toContain('toolBlockSummary(')
  })

  it('ExecutionSegment 折叠头保留整句形式（没有加粗标签位的叙述面）', () => {
    const src = read('src/renderer/src/components/chat/ExecutionSegment.tsx')
    expect(src).toContain('texts.push(toolBlockSummary(block, t))')
  })

  it('两处 toolBlockSummary 都由 detail 半边拼装（回落逻辑单源）', () => {
    const chat = read('src/renderer/src/components/chat/tool-summary.ts')
    expect(chat).toContain('const detail = toolDetailSummary(block)')
    const ext = read('src/extension/ui/format.ts')
    expect(ext).toContain('const detail = toolDetailSummary(block)')
  })
})
