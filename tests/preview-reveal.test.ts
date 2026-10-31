/**
 * 预览审阅联动（PLAN-ide-linkage 刀一，2026-10-30）：预览行号 + 变更落点跳转
 * （reveal）+ 工具卡路径可点击。
 *
 * 数据链：edit/read 的 input → edit-reveal.ts 派生最小锚点（行号或 ≤120 字符
 * 文本锚，绝不驻留原始字符串）→ usePreviewPaneSync 在完成拍点随事件携带 →
 * previewPaneStore.revealTargets（tick 防二次 reveal 被首个的过期定时器吞掉）
 * → PreviewContent 定位后交给 TextPreview/CodeHighlight 滚动 + 短暂高亮。
 *
 * 诚实裁定沿 edit-diff.ts：diff 模式 hunk 带真实文件行号 → line 锚；
 * search/replace 模式无文件坐标 → 文本锚，盘面漂移时定位失败即放弃（错滚比
 * 不滚糟）。多文件 diff 无单一锚：首节为 reveal 目标，其余节只 bump 重载。
 */
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')

const {
  deriveEditReveal,
  deriveReadReveal,
  deriveEditTargets,
} = await import('../src/shared/tool-display/edit-reveal')
const { ingestAgentEvent } = await import('../src/renderer/src/hooks/usePreviewPaneSync')
const { usePreviewPaneStore, openInPreviewPane, DRAFT_CONVERSATION_KEY } = await import(
  '../src/renderer/src/stores/previewPaneStore'
)

const SINGLE_DIFF = '@@ -12,2 +12,2 @@\n unchanged context\n-removed line\n+added line'
const MULTI_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -12,2 +12,2 @@',
  ' unchanged context',
  '-removed',
  '+added',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,1 +10,2 @@',
  ' ctx b',
  '+new b',
].join('\n')
const MULTI_NEW_FIRST = [
  'diff --git a/new-file.ts b/new-file.ts',
  '--- /dev/null',
  '+++ b/new-file.ts',
  '@@ -0,0 +1,1 @@',
  '+brand new',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,1 +10,2 @@',
  ' ctx b',
  '+new b',
].join('\n')

// ── deriveEditReveal：单文件锚点矩阵 ────────────────────────────────────────

describe('deriveEditReveal', () => {
  it('diff 模式取首个 hunk 的 newStart（真实文件行）', () => {
    expect(deriveEditReveal({ file_path: 'src/a.ts', diff: SINGLE_DIFF })).toEqual({ mode: 'line', line: 12 })
  })

  it('纯删除 hunk（newCount 0）没有可落点的新内容 → null', () => {
    expect(deriveEditReveal({ file_path: 'src/a.ts', diff: '@@ -3,1 +3,0 @@\n-gone' })).toBeNull()
  })

  it('畸形 diff（无 @@ 头）→ null，不猜', () => {
    expect(deriveEditReveal({ file_path: 'src/a.ts', diff: 'not a diff at all' })).toBeNull()
  })

  it('search/replace 模式 → 文本锚：new_str 首个非空行，trim + 截 120', () => {
    expect(deriveEditReveal({ old_str: 'x', new_str: '\n\n  hello world  \n' })).toEqual({ mode: 'text', text: 'hello world' })
    const long = 'x'.repeat(300)
    const r = deriveEditReveal({ new_str: long })
    expect(r).toEqual({ mode: 'text', text: 'x'.repeat(120) })
  })

  it('new_str 空/缺失 → null', () => {
    expect(deriveEditReveal({ old_str: 'x', new_str: '  \n  ' })).toBeNull()
    expect(deriveEditReveal({ old_str: 'x' })).toBeNull()
  })

  it('多文件形态（无 file_path）没有单一锚 → null（诚实缺口）', () => {
    expect(deriveEditReveal({ diff: MULTI_DIFF })).toBeNull()
  })

  it('write 形输入（只有 file_path+content）→ null', () => {
    expect(deriveEditReveal({ file_path: 'a.ts', new_str: undefined, content: 'file body' })).toBeNull()
    expect(deriveEditReveal(null)).toBeNull()
  })
})

describe('deriveReadReveal', () => {
  it('offset 即绝对行号；默认页（1/缺失）无须滚动', () => {
    expect(deriveReadReveal({ offset: 40 })).toEqual({ mode: 'line', line: 40 })
    expect(deriveReadReveal({ offset: 1 })).toBeNull()
    expect(deriveReadReveal({})).toBeNull()
    expect(deriveReadReveal(null)).toBeNull()
  })

  it('SSE 字符串数字宽容解析', () => {
    expect(deriveReadReveal({ offset: '40' })).toEqual({ mode: 'line', line: 40 })
    expect(deriveReadReveal({ offset: 'abc' })).toBeNull()
  })
})

// ── deriveEditTargets：sync 用的全量派生（含多文件） ────────────────────────

describe('deriveEditTargets', () => {
  it('单文件 diff → path + line 锚', () => {
    expect(deriveEditTargets({ file_path: 'src/a.ts', diff: SINGLE_DIFF })).toEqual({
      path: 'src/a.ts',
      reveal: { mode: 'line', line: 12 },
    })
  })

  it('多文件 diff → 首节为目标、reveal 首节首 hunk，其余节进 extraPaths', () => {
    expect(deriveEditTargets({ diff: MULTI_DIFF })).toEqual({
      path: 'src/a.ts',
      reveal: { mode: 'line', line: 12 },
      extraPaths: ['src/b.ts'],
    })
  })

  it('首节是新建（--- /dev/null）→ reveal null（整文件即变更，从头看），第二节退为 extraPaths', () => {
    expect(deriveEditTargets({ diff: MULTI_NEW_FIRST })).toEqual({
      path: 'new-file.ts',
      reveal: null,
      extraPaths: ['src/b.ts'],
    })
  })

  it('search/replace → path + 文本锚', () => {
    expect(deriveEditTargets({ file_path: 'a.ts', old_str: 'x', new_str: 'brand new line' })).toEqual({
      path: 'a.ts',
      reveal: { mode: 'text', text: 'brand new line' },
    })
  })

  it('无 file_path 且无 diff → null（无法点名目标文件）', () => {
    expect(deriveEditTargets({ old_str: 'x', new_str: 'y' })).toBeNull()
    expect(deriveEditTargets(null)).toBeNull()
  })
})

// ── ingestAgentEvent：reveal 在 ingest 拍点派生、完成拍点随事件携带 ─────────

function fireAfterStart(startInput: Record<string, unknown>, toolUseId: string, name = 'edit') {
  const known = new Map()
  ingestAgentEvent(known, { type: 'tool_start', toolUseId, name, input: startInput } as never)
  return ingestAgentEvent(known, {
    type: 'tool_status',
    updates: [{ messageId: 'm1', toolUseId, status: 'completed', exitCode: 0 }],
  } as never)
}

describe('ingestAgentEvent reveal 传输', () => {
  it('edit 完成 → 事件携带 reveal 与路径', () => {
    const fired = fireAfterStart({ file_path: 'src/a.ts', diff: SINGLE_DIFF }, 'e1')
    expect(fired).toHaveLength(1)
    expect(fired[0].path).toBe('src/a.ts')
    expect(fired[0].reveal).toEqual({ mode: 'line', line: 12 })
  })

  it('search/replace 的 edit → 文本锚', () => {
    const fired = fireAfterStart({ file_path: 'a.ts', old_str: 'x', new_str: 'fresh text' }, 'e2')
    expect(fired[0].reveal).toEqual({ mode: 'text', text: 'fresh text' })
  })

  it('多文件 edit（无 file_path）→ path=首节、extraPaths=余节', () => {
    const fired = fireAfterStart({ diff: MULTI_DIFF }, 'e3')
    expect(fired[0].path).toBe('src/a.ts')
    expect(fired[0].extraPaths).toEqual(['src/b.ts'])
  })

  it('write 不带 reveal（整文件即变更）', () => {
    const fired = fireAfterStart({ file_path: 'a.ts', content: 'body' }, 'w1', 'write')
    expect(fired[0].reveal).toBeUndefined()
  })

  it('失败的 edit（exitCode 1）不 fire——失败的改动没有落点', () => {
    const known = new Map()
    ingestAgentEvent(known, { type: 'tool_start', toolUseId: 'e4', name: 'edit', input: { file_path: 'a.ts', diff: SINGLE_DIFF } } as never)
    const fired = ingestAgentEvent(known, {
      type: 'tool_status',
      updates: [{ messageId: 'm1', toolUseId: 'e4', status: 'completed', exitCode: 1 }],
    } as never)
    expect(fired).toEqual([])
  })

  it('messages 形（hydration 回放）同样派生 reveal', () => {
    const known = new Map()
    ingestAgentEvent(known, {
      type: 'messages',
      messages: [{ contentBlocks: [{ type: 'tool_use', id: 'e5', name: 'edit', input: { file_path: 'src/a.ts', diff: SINGLE_DIFF } }] }],
    } as never)
    const fired = ingestAgentEvent(known, {
      type: 'tool_status',
      updates: [{ messageId: 'm1', toolUseId: 'e5', status: 'completed', exitCode: 0 }],
    } as never)
    expect(fired[0].reveal).toEqual({ mode: 'line', line: 12 })
  })
})

// ── store：tick 防串、生命周期清理、openInPreviewPane 的 reveal 通路 ─────────

describe('previewPaneStore revealTargets', () => {
  it('requestReveal 递增 tick，consumeReveal 移除；二次 reveal 不被首个定时器吞', () => {
    const s = usePreviewPaneStore.getState()
    s.requestReveal('/w/a.ts', { mode: 'line', line: 12 })
    expect(usePreviewPaneStore.getState().revealTargets['/w/a.ts']).toEqual({ tick: 1, target: { mode: 'line', line: 12 } })
    s.requestReveal('/w/a.ts', { mode: 'text', text: 'second' })
    expect(usePreviewPaneStore.getState().revealTargets['/w/a.ts']?.tick).toBe(2)
    usePreviewPaneStore.getState().consumeReveal('/w/a.ts')
    expect(usePreviewPaneStore.getState().revealTargets['/w/a.ts']).toBeUndefined()
  })

  it('openInPreviewPane 按工作区解析路径后按解析结果记 reveal（两侧同一坐标系）', () => {
    usePreviewPaneStore.getState().setWorkspaceDir('/ws')
    openInPreviewPane('src/rel.ts', { mode: 'line', line: 3 })
    const st = usePreviewPaneStore.getState()
    expect(st.activeByConversation[DRAFT_CONVERSATION_KEY]).toBe('/ws/src/rel.ts')
    expect(st.revealTargets['/ws/src/rel.ts']?.target).toEqual({ mode: 'line', line: 3 })
    usePreviewPaneStore.getState().consumeReveal('/ws/src/rel.ts')
    usePreviewPaneStore.getState().closeTab(null, '/ws/src/rel.ts')
  })

  it('closeTab 丢弃该文件的 reveal 目标', () => {
    usePreviewPaneStore.getState().setWorkspaceDir('/ws')
    openInPreviewPane('src/drop.ts')
    const p = usePreviewPaneStore.getState().activeByConversation[DRAFT_CONVERSATION_KEY]
    expect(p).toBe('/ws/src/drop.ts')
    usePreviewPaneStore.getState().requestReveal(p!, { mode: 'line', line: 5 })
    usePreviewPaneStore.getState().closeTab(null, p!)
    expect(usePreviewPaneStore.getState().revealTargets[p!]).toBeUndefined()
  })
})

// ── wiring 扫描：渲染面四环节都接了线 ───────────────────────────────────────

describe('wiring 扫描', () => {
  const src = (p: string): string => readFileSync(join(root, p), 'utf8')

  it('sync 钩子：edits 与 writes 同过 shouldAutoOpen 门 + reveal 落 store + extraPaths 重载', () => {
    const sync = src('src/renderer/src/hooks/usePreviewPaneSync.ts')
    expect(sync).toContain('store.requestReveal(abs, ev.reveal)')
    expect(sync).toContain('store.bumpReload(resolvePreviewPath(extra, workspaceDir))')
    // edit 自动打开的裁定：reveal 必须可见才有价值
    expect(sync).toContain('if (ev.force || shouldAutoOpen(abs))')
  })

  it('PreviewContent：定位 → TextPreview 穿透 → tick 守卫消费', () => {
    const content = src('src/renderer/src/components/preview/PreviewContent.tsx')
    expect(content).toContain('revealLine={revealLine ?? undefined}')
    expect(content).toContain('st.revealTargets[path]?.tick === capturedTick')
    expect(content).toContain("kind !== 'text'")
    expect(content).toContain('startsWith(target.text)')
  })

  it('CodeHighlight：行号 prop + reveal 的 data 属性与滚动（2026-10-31 快路径，属性产自 fast-code 构建器）', () => {
    const hl = src('src/renderer/src/components/common/CodeHighlight.tsx')
    expect(hl).toContain('lineNumbers')
    expect(hl).toContain('highlightToHtml(code, lang, theme, { lineNumbers, revealLine: revealLine ?? null })')
    expect(hl).toContain("querySelector(`[data-reveal-line=\"${revealLine}\"]`)")
    expect(hl).toContain("el?.scrollIntoView({ block: 'center' })")
    // 值必须字符串化：hast 式属性写入丢弃非字符串属性值（probe 实测）——
    // 构建器里是显式 String(n)。
    expect(src('src/renderer/src/components/common/fast-code.ts')).toContain('data-reveal-line="${String(n)}"')
  })

  it('fast-code：带行号的行是 block 行 + 悬挂缩进（2026-10-30 滚动卡顿根因的延续钉）', () => {
    const fc = src('src/renderer/src/components/common/fast-code.ts')
    // 行号盒沿用库自己的算术：<digits>.25em（minWidth）+ paddingRight 1em，
    // 行行 block + 负缩进一个 gutter——永不回到 display:flex（那是 2026-10-30
    // 窄列滚动 ~260ms/帧的根因形态）。
    expect(fc).toContain('String(largest).length + 1.25')
    expect(fc).toContain("display:block;padding-left:${gutter};text-indent:-${gutter}")
    expect(fc).not.toContain('display:flex')
    expect(fc).toContain("display:inline-block;min-width:${String(largest).length + 1.25}em;padding-right:1em;text-align:right;user-select:none")
  })

  it('TextPreview 常通行号；CommandCard 路径点击 + completed 门 + reveal 随行', () => {
    expect(src('src/renderer/src/components/preview/TextPreview.tsx')).toContain('lineNumbers revealLine={revealLine}')
    const card = src('src/renderer/src/components/terminal/CommandCard.tsx')
    expect(card).toContain('openInPreviewPane(clickablePath, cardReveal(block))')
    expect(card).toContain("block.name === 'edit' && block.status === 'completed'")
    expect(card).toContain('deriveReadReveal(block.input)')
    expect(card).toContain('pm-card-pathlink')
  })

  it('store 生命周期：forgetConversation 清 revealTargets', () => {
    expect(src('src/renderer/src/stores/previewPaneStore.ts')).toContain('revealTargets: omitKeys(s.revealTargets, paths)')
  })
})
