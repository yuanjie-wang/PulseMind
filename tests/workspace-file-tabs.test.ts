/**
 * 工作区布局（2026-10-30 用户裁定）：地址栏下移 + 文件页签条回归。
 *
 * 页签条住的层级是本刀的要害：它不住在 PreviewPane（那是 2026-10-25 被去掉的
 * 形态，也是 `0e3cd23` 删掉的那份内联实现），而住在 WorkspacePane、跨整面板宽；
 * 地址栏落进预览列、贴预览之上，并改说「当前预览的文件」而不是树选中。
 * 数据层（tabsByConversation / setActive / closeTab / preview-tabs.ts）没动，
 * 所以这里钉的是接线与语义，不是列表模型（后者在 preview-tabs.test.ts）。
 * 末尾一组是两端渐隐提示（2026-10-30 用户裁定，鼠标用户的横向线索）：阈值纯函数
 * + 两条页签条共用同一份实现 + 遮罩不吃点击。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DRAFT_CONVERSATION_KEY, usePreviewPaneStore } from '../src/renderer/src/stores/previewPaneStore'
import { makeDraftFromDisk } from '../src/renderer/src/stores/preview-edit'
import { FADE_WIDTH, NO_FADES, stripFadesOf } from '../src/renderer/src/components/common/StripEdgeFades'

const root = join(__dirname, '..')
const src = (p: string): string => readFileSync(join(root, p), 'utf8')

const STRIP = 'src/renderer/src/components/workbench/WorkspaceTabStrip.tsx'
const PANE = 'src/renderer/src/components/workbench/WorkspacePane.tsx'
const BAR = 'src/renderer/src/components/workbench/WorkspaceAddressBar.tsx'
const TREE = 'src/renderer/src/components/workbench/WorkspaceTree.tsx'
const PREVIEW = 'src/renderer/src/components/preview/PreviewPane.tsx'
const FADES = 'src/renderer/src/components/common/StripEdgeFades.tsx'
const BROWSER = 'src/renderer/src/components/browser/BrowserPaneChrome.tsx'

describe('WorkspacePane：页签条跨整面板宽 + 地址栏落进预览列', () => {
  it('页签条是列首行，且排在树/预览那一行之前', () => {
    const pane = src(PANE)
    expect(pane).toContain('<WorkspaceTabStrip conversationId={conversationId} />')
    expect(pane.indexOf('<WorkspaceTabStrip')).toBeGreaterThan(-1)
    // 整面板宽 = 它是 row 的兄弟且在前（树列与预览列都在它下方）。
    expect(pane.indexOf('<WorkspaceTabStrip')).toBeLessThan(pane.indexOf('ref={rowRef}'))
  })

  it('地址栏在预览列内（树列之后、PreviewPane 之前）', () => {
    const pane = src(PANE)
    expect(pane).toContain('<WorkspaceAddressBar conversationId={conversationId} />')
    expect(pane.indexOf('<WorkspaceAddressBar')).toBeGreaterThan(pane.indexOf('data-pm-tree-column'))
    expect(pane.indexOf('<WorkspaceAddressBar')).toBeLessThan(pane.indexOf('<PreviewPane'))
    // 语义改了：地址栏不再收 selectedPath（树选中归树行自己画；树仍收它）。
    expect(pane).toContain('<WorkspaceTree conversationId={conversationId} selectedPath={selectedPath}')
    expect(pane).not.toContain('<WorkspaceAddressBar conversationId={conversationId} selectedPath')
  })

  it('树列与拖拽分栏的几何契约原样（layout-widths 同款约束）', () => {
    const pane = src(PANE)
    expect(pane).toContain('data-pm-tree-drag-handle')
    expect(pane).toContain('clampTreeWidth')
    expect(pane).toContain('setTreeWidth')
    expect(pane).toContain('ResizeObserver')
    expect(pane).toMatch(/direction: 1,/)
    // 模板字符串宽度会绕过 clamp，是 layout-widths 钉的老红线。
    expect(pane).not.toMatch(/width: `\$\{/)
  })
})

describe('WorkspaceTabStrip：接线', () => {
  it('读会话的页签表与激活路径，动作走 store 的 setActive/closeTab', () => {
    const strip = src(STRIP)
    expect(strip).toContain('s.tabsByConversation[key]')
    expect(strip).toContain('s.activeByConversation[key] ?? null')
    expect(strip).toContain('usePreviewPaneStore.getState().setActive(convArg, tab.path)')
    expect(strip).toContain('usePreviewPaneStore.getState().closeTab(convArg, path)')
    expect(strip).toContain('DRAFT_CONVERSATION_KEY')
  })

  it('关闭脏页签先问（D10：编辑不得静默丢弃），干净页签直接关', () => {
    const strip = src(STRIP)
    expect(strip).toContain('const entry = drafts[path]')
    expect(strip).toContain('isDirty(entry)')
    expect(strip).toContain("t('previewPane.closeDirtyTitle')")
    expect(strip).toContain("t('previewPane.closeDirtyBody')")
    expect(strip).toContain("t('previewPane.closeDiscard')")
    expect(strip).toContain('okButtonProps: { danger: true }')
    // 确认与直关都必须落到 closeTab（任一分支漏掉就是关不掉的页签）。
    expect(strip.match(/closeTab\(convArg, path\)/g)?.length).toBe(2)
  })

  it('页签的改动状态落在文字颜色上（2026-10-30 裁定：不要圆点），台账同源', () => {
    const strip = src(STRIP)
    // 台账与拼写不变（树行同款），变的只是表达：ink 从点搬到文字色。
    expect(strip).toContain('useSessionFileChangesStore')
    expect(strip).toContain('fileChangeMarks(changes, workspaceDir)')
    expect(strip).toContain('normalizeChangePath(tab.path)')
    expect(strip).toContain('var(--pm-ws-${mark})')
    // 圆点确已移除（data-ws-tab-dot 是旧表达，残留即回归）。
    expect(strip).not.toContain('data-ws-tab-dot')
    // 未保存橙（状态色字面量）仍在，但作为文字色而非点的背景。
    expect(strip).not.toContain("t('previewPane.dirtyDot')")
    expect(strip).toContain("tabDirty ? '#fa8c16' : mark ? `var(--pm-ws-${mark})` : null")
    // 优先级：脏页签压过台账 ink（要行动的状态赢，保存后 ink 回来），
    // 两者都无才回到常规墨色（激活 strong / 未激活 quiet）。
    expect(strip).toContain("color: tabInk ?? (active ? 'var(--pm-text-strong)' : 'var(--pm-text-quiet)')")
  })

  it('溢出：收缩到下限后横滑 + 滚轮竖转横 + 手工 scrollLeft 露出（不用 scrollIntoView）', () => {
    const strip = src(STRIP)
    expect(strip).toContain('className="pm-ws-tabstrip"')
    expect(strip).toContain('minWidth: 64')
    expect(strip).toContain('maxWidth: 140')
    expect(strip).toContain("addEventListener('wheel', onWheel, { passive: false })")
    expect(strip).toContain('el.scrollLeft = right - el.clientWidth')
    // 注释里会写到这个 API 的名字（说明为什么不用它），钉的是调用。
    expect(strip).not.toMatch(/\.scrollIntoView\(/)
  })

  it('空态保留 32px 行（首个文件打开时布局不跳）', () => {
    const strip = src(STRIP)
    expect(strip).toContain('data-ws-tabstrip-row')
    // 行本身在 tabs 判空之外，只有条内容分叉。
    expect(strip.indexOf('data-ws-tabstrip-row')).toBeLessThan(strip.indexOf('list.length === 0'))
    expect(strip).toContain('data-ws-tabstrip-empty')
    expect(strip).toContain("t('previewPane.tabEmptyHint')")
    expect(strip).toContain('height: 32')
  })

  it('无障碍：tablist/tab/aria-selected + 关闭钮是带 aria-label 的真按钮', () => {
    const strip = src(STRIP)
    expect(strip).toContain('role="tablist"')
    expect(strip).toContain('role="tab"')
    expect(strip).toContain('aria-selected={active}')
    expect(strip).toContain("aria-label={t('previewPane.closeTab')}")
    expect(strip).toContain('e.stopPropagation()')
  })
})

describe('地址栏：说当前预览的文件，不再说树选中', () => {
  it('displayPath = activePath ?? workspaceDir', () => {
    const bar = src(BAR)
    expect(bar).toContain('const displayPath = activePath ?? workspaceDir')
    expect(bar).not.toContain('selectedPath')
  })

  it('探针读的两个锚点属性保留（theme 取色 + 同步等待都靠它们）', () => {
    const bar = src(BAR)
    expect(bar).toContain('data-ws-address')
    expect(bar).toContain('data-ws-address-path')
    expect(bar).toContain('data-ws-open')
    expect(bar).toContain('data-ws-more')
  })

  it('地址栏不带任何圆点，高度与目录树工具栏一致（2026-10-30 用户裁定）', () => {
    const bar = src(BAR)
    // 圆点已撤（改动 ink 归树行与页签文字，脏状态归 ⋯ 菜单的 保存 可用性）。
    expect(bar).not.toContain('data-ws-change-dot')
    expect(bar).not.toContain('#fa8c16')
    expect(bar).not.toContain('dirtyDot')
    // 32 = 树工具栏的 4 + 24(antd small Input) + 4——两列的首条对齐。
    expect(bar).toContain('height: 32')
    expect(bar).not.toContain('height: 36')
  })

  it('菜单动作仍绑 activePath（路径与动作不许各说一个文件）', () => {
    const bar = src(BAR)
    expect(bar).toContain('const activeKind = activePath ? detectFileKind(activePath) : null')
    expect(bar).toContain('if (!activePath || editDisabled) return')
    expect(bar).toContain('if (!activePath) return')
  })
})

describe('树行：在系统中打开（文件夹的 Finder 出口）', () => {
  it('第三个 hover 动作接了 openFolder，且不抢选择/展开', () => {
    const tree = src(TREE)
    expect(tree).toContain('title="在系统中打开"')
    expect(tree).toContain('onOpenOs={openInOs}')
    expect(tree).toContain('window.electronAPI.openFolder(entry.path)')
    const btn = tree.slice(tree.indexOf('title="在系统中打开"'))
    expect(btn.slice(0, 400)).toContain('e.stopPropagation()')
    // 与 diff 按钮不同：这一颗对每个条目都渲染（文件夹也要有出口）。
    expect(tree).not.toMatch(/onOpenOs\s*&&/)
  })
})

describe('PreviewPane：成为地址栏下方的填充盒', () => {
  it('根盒 flex:1（height:100% 会连着地址栏一起溢出），空态同样填充', () => {
    const preview = src(PREVIEW)
    expect(preview).toContain("style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--pm-bg)' }}")
    expect(preview).not.toContain("style={{ height: '100%', display: 'flex', flexDirection: 'column'")
    // 空态也得吃掉剩余高度，否则提示贴在地址栏正下方而不是居中在预览区。
    const empty = preview.slice(preview.indexOf('if (!activePath)'), preview.indexOf('在左侧目录树中点击文件预览'))
    expect(empty).toContain('flex: 1')
    expect(empty).toContain('justifyContent')
  })
})

describe('i18n：关闭确认四键回归 + 空态提示（zh/en 双份）', () => {
  const keys = ['closeDirtyTitle', 'closeDirtyBody', 'closeDiscard', 'closeCancel', 'tabEmptyHint']
  for (const locale of ['zh', 'en']) {
    it(`${locale} 有齐五个键`, () => {
      const text = src(`src/renderer/src/i18n/locales/${locale}.ts`)
      for (const k of keys) expect(text).toContain(`${k}: `)
    })
  }
})

describe('▾ 快速切换（2026-10-30 用户裁定：最左侧下拉列出全部已打开文件）', () => {
  it('触发器在最左侧（滚动器包裹盒之前），是真按钮且空态置灰', () => {
    const strip = src(STRIP)
    expect(strip).toContain('data-ws-tabstrip-menu')
    // 最左侧 = 触发器先于滚动器的 relative 包裹盒渲染。
    expect(strip.indexOf('data-ws-tabstrip-menu')).toBeLessThan(strip.indexOf("style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}"))
    expect(strip).toContain('type="button"')
    expect(strip).toContain("aria-label={t('previewPane.tabList')}")
    // 空态由 Dropdown 的 disabled 落成触发器上的原生 disabled 属性（antd 克隆注入），
    // 比手写 aria-disabled 强；几何仍稳定：只置灰不卸载。
    expect(strip).not.toContain('aria-disabled')
    // 几何稳定：空态只置灰不卸载（首个文件打开时条不位移）。
    expect(strip).toContain('disabled={list.length === 0}')
    expect(strip).toContain('opacity: list.length === 0 ? 0.35 : 1')
  })

  it('菜单 key=路径：一条 onClick 走 setActive，selectedKeys 跟屏上文件', () => {
    const strip = src(STRIP)
    expect(strip).toContain('key: tab.path,')
    expect(strip).toContain('selectedKeys: activePath ? [activePath] : []')
    expect(strip).toContain('onClick: ({ key }) => usePreviewPaneStore.getState().setActive(convArg, key)')
    // 点当前激活项无害（setActive 幂等），所以无需逐项排除。
    expect(strip).toContain("trigger={['click']}")
  })

  it('菜单项与页签同款文字 ink + 完整路径 tooltip（2026-10-30 同批去点）', () => {
    const menu = src(STRIP).slice(src(STRIP).indexOf('const menuItems'))
    expect(menu).toContain('var(--pm-ws-${mark})')
    expect(menu).toContain("tabDirty ? '#fa8c16' : mark ? `var(--pm-ws-${mark})` : undefined")
    expect(menu).not.toContain('data-ws-tab-dot')
    expect(menu).not.toContain('previewPane.dirtyDot')
    expect(menu).toContain('title={tab.path}')
    // 标签要能省略（长文件名），tooltip 给全路径。
    expect(menu).toContain('maxWidth: 260')
  })

  it('i18n：tabList 在 zh/en 双份', () => {
    for (const locale of ['zh', 'en']) {
      expect(src(`src/renderer/src/i18n/locales/${locale}.ts`)).toContain('tabList: ')
    }
  })
})

describe('store 行为：页签点击切换激活文件（真 store 驱动）', () => {
  beforeEach(() => {
    usePreviewPaneStore.setState({
      tabsByConversation: {},
      activeByConversation: {},
      drafts: {},
      activeConversationId: null,
      workspaceDir: null,
    })
  })

  it('setActive 只改激活路径，不动列表顺序', () => {
    const s = usePreviewPaneStore.getState()
    s.openFile(null, '/w/a.md')
    s.openFile(null, '/w/b.md')
    usePreviewPaneStore.getState().setActive(null, '/w/a.md')
    const now = usePreviewPaneStore.getState()
    expect(now.activeByConversation[DRAFT_CONVERSATION_KEY]).toBe('/w/a.md')
    expect(now.tabsByConversation[DRAFT_CONVERSATION_KEY].map((t) => t.path)).toEqual(['/w/a.md', '/w/b.md'])
  })

  it('关掉激活页签 → 后继接位；关掉最后一个 → 空（页签条回空态）', () => {
    const s = usePreviewPaneStore.getState()
    s.openFile(null, '/w/a.md')
    s.openFile(null, '/w/b.md')
    usePreviewPaneStore.getState().closeTab(null, '/w/a.md')
    expect(usePreviewPaneStore.getState().activeByConversation[DRAFT_CONVERSATION_KEY]).toBe('/w/b.md')
    usePreviewPaneStore.getState().closeTab(null, '/w/b.md')
    const now = usePreviewPaneStore.getState()
    expect(now.tabsByConversation[DRAFT_CONVERSATION_KEY]).toEqual([])
    expect(now.activeByConversation[DRAFT_CONVERSATION_KEY]).toBeNull()
  })

  it('脏页签的 draft 与页签同生共死（关页签丢弃草稿——确认弹窗的前提）', () => {
    const s = usePreviewPaneStore.getState()
    s.openFile(null, '/w/a.md')
    usePreviewPaneStore.getState().setDraft('/w/a.md', { ...makeDraftFromDisk('orig\n'), content: 'edited\n' })
    expect(Object.keys(usePreviewPaneStore.getState().drafts)).toEqual(['/w/a.md'])
    usePreviewPaneStore.getState().closeTab(null, '/w/a.md')
    expect(usePreviewPaneStore.getState().drafts).toEqual({})
  })
})

describe('页签条两端渐隐（2026-10-30 用户裁定「两端渐隐提示」）', () => {
  it('阈值矩阵：不溢出两边都不画，中段两边都画，端头各去掉一边', () => {
    // 12 chips 在 402px 里：总量 1004（probe 实测数字）
    const strip = { scrollLeft: 0, clientWidth: 402, scrollWidth: 1004 }
    expect(stripFadesOf(strip)).toEqual({ left: false, right: true })
    expect(stripFadesOf({ ...strip, scrollLeft: 300 })).toEqual({ left: true, right: true })
    expect(stripFadesOf({ ...strip, scrollLeft: 602 })).toEqual({ left: true, right: false })
    // 装得下：两边都没有（空态与少页签态共用这一支）
    expect(stripFadesOf({ scrollLeft: 0, clientWidth: 402, scrollWidth: 402 })).toEqual(NO_FADES)
    // 1px 松弛：HiDPI 的 0.5px 偏移、贴端头时的 1px 差不得闪边
    expect(stripFadesOf({ scrollLeft: 0.5, clientWidth: 402, scrollWidth: 1004 })).toEqual({ left: false, right: true })
    expect(stripFadesOf({ scrollLeft: 601, clientWidth: 402, scrollWidth: 1004 })).toEqual({ left: true, right: false })
    expect(stripFadesOf({ scrollLeft: 602, clientWidth: 402, scrollWidth: 1004 })).toEqual({ left: true, right: false })
  })

  it('遮罩不吃点击（pointerEvents:none 是硬要求——它盖在页签之上）', () => {
    const fades = src(FADES)
    expect(fades).toContain("pointerEvents: 'none'")
    expect(fades).toContain('data-strip-fade="left"')
    expect(fades).toContain('data-strip-fade="right"')
    expect(fades).toContain('linear-gradient(to right, var(--pm-bg), transparent)')
    expect(fades).toContain('linear-gradient(to left, var(--pm-bg), transparent)')
    // 渐隐是兄弟节点、且在相对定位的包裹里（几何必须等于滚动盒，不能算进行的 12/6px 内边距）
    expect(fades).toContain("position: 'absolute'")
    expect(FADE_WIDTH).toBe(16)
  })

  it('hook 三重再同步：滚动监听 + ResizeObserver + 内容签名', () => {
    const fades = src(FADES)
    expect(fades).toContain("el.addEventListener('scroll', sync, { passive: true })")
    expect(fades).toContain('new ResizeObserver(sync)')
    expect(fades).toContain('}, [ref, signature])')
  })

  it('两条页签条都接了同一份渐隐（文件条 + 浏览器条，观感一致）', () => {
    for (const file of [STRIP, BROWSER]) {
      const text = src(file)
      expect(text).toContain("import { StripEdgeFades, useStripFades } from '../common/StripEdgeFades'")
      expect(text).toContain('useStripFades(stripRef, ')
      expect(text).toContain('<StripEdgeFades fades={fades} />')
      // 包裹盒必须与滚动器同盒：relative + flex:1 + minWidth:0
      expect(text).toContain("style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}")
    }
  })
})
