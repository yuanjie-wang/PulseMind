import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 清空提取记忆（2026-11-12 user：「记忆设置面板中，需要提供清空按钮」）。
 *
 *  `clearMemoryPagesByTypes` 要真表才能跑，而 better-sqlite3 是 Electron-ABI，
 *  vitest 起不了库——所以这里钉源码接线，真库行为（三型消失、经验留存、FTS 同步、
 *  外部取代链剪断）由 `scripts/probe-memory-pages-db.mjs` 断言。
 */

const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const store = read('src/main/storage/memory-pages-store.ts')
const handler = read('src/main/ipc/memory.handler.ts')
const preload = read('src/preload/index.ts')
const bridge = read('src/shared/types/electron-bridge.ts')
const channels = read('src/shared/ipc-channels.ts')
const settings = read('src/renderer/src/components/settings/MemorySettings.tsx')
const zh = read('src/renderer/src/i18n/locales/zh.ts')
const en = read('src/renderer/src/i18n/locales/en.ts')

/** clearMemoryPagesByTypes 的函数体（到函数结束的那个顶层 `\n}` 为止） */
function clearFnBody(): string {
  const at = store.indexOf('export function clearMemoryPagesByTypes')
  expect(at).toBeGreaterThan(-1)
  return store.slice(at, store.indexOf('\n}', at))
}

describe('清空提取记忆：范围', () => {
  it('只清三型，经验页永远不在范围内（经验归技能中心，不随「清空记忆」消失）', () => {
    const call = /clearMemoryPages\(\[([^\]]*)\]\)/.exec(settings)
    expect(call).not.toBeNull()
    expect(call?.[1]).toBe("'preference', 'decision', 'fact'")
    expect(call?.[1]).not.toContain('experience')
  })

  it('不按活页过滤——退役与被取代的历史行一并删（否则面板留一屏灰卡，像没清干净）', () => {
    const body = clearFnBody()
    expect(body).toContain('WHERE type IN (${ph})')
    expect(body).not.toContain('retired_at IS NULL')
    expect(body).not.toContain('superseded_by IS NULL')
  })

  it('空 types 早退，整批一个事务', () => {
    expect(store).toContain('if (effective.length === 0) return 0')
    expect(clearFnBody()).toContain('database.transaction')
  })

  it('经验不参与整族清空——66 个磁盘目录不能被一键扫掉', () => {
    // n9 后经验真源在 ~/.pulsemind/experience/，一键「清空记忆」只该动 DB 里的三型。
    expect(clearFnBody()).toContain("types.filter((t) => t !== 'experience')")
  })
})

describe('清空提取记忆：连带清理', () => {
  it('同步删 FTS 行（留着就是检索幽灵）', () => {
    const body = clearFnBody()
    expect(body).toContain('DELETE FROM memory_pages_fts WHERE page_id = ?')
    expect(body).toContain('withPagesFtsRecovery')
  })

  it('剪断其它页指向被删页的 superseded_by（留着就是死链）', () => {
    expect(clearFnBody()).toContain('UPDATE memory_pages SET superseded_by = NULL WHERE superseded_by = ?')
  })
})

describe('清空提取记忆：IPC 全链', () => {
  it('channels → handler → preload → 渲染端类型，四层齐', () => {
    expect(channels).toContain("MEMORY_PAGE_CLEAR: 'memory-page:clear'")
    expect(handler).toContain('IPC_CHANNELS.MEMORY_PAGE_CLEAR')
    expect(handler).toContain('clearMemoryPagesByTypes(types)')
    expect(preload).toContain('clearMemoryPages:')
    expect(bridge).toContain('clearMemoryPages:')
  })
})

describe('清空提取记忆：不可误触、清完即刷新', () => {
  it('二次确认 + danger 按钮（整族永久删除，点错没有后悔药）', () => {
    expect(settings).toContain('<Popconfirm')
    expect(settings).toContain('okButtonProps={{ danger: true }}')
    expect(settings).toContain("title={t('memoryPages.clearConfirm')}")
  })

  it('清空后浏览件按 key 重挂载（面板的 load 不依赖条数，否则灰卡赖在视野里）', () => {
    expect(settings).toContain('key={pagesKey}')
    expect(settings).toContain('setPagesKey((k) => k + 1)')
  })

  it('文案讲清范围：历史版本一并删，MEMORY.md 与经验不受影响（中英都要有）', () => {
    for (const pack of [zh, en]) expect(pack).toMatch(/clearConfirm: '[^']*MEMORY\.md/)
  })
})
