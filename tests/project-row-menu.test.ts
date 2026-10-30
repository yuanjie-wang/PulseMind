/**
 * 项目行的 ⋯ 更多菜单（2026-10-30 用户裁定：编辑、删除收进 ⋯，进入沉浸模式也
 * 收进去，新建任务留在外面）。
 *
 * 这条裁定把标题行从三个悬停图标收敛成「+ 与 ⋯」两个 —— 20px 的行高盒子塞三
 * 个图标本来就挤，而沉浸模式需要一个入口位。删除动作本身零变化：它仍然走既有
 * 的 removeProject（确认弹窗 + 级联删会话），只是触发点从行内按钮搬进菜单。
 *
 * 本文件钉：菜单项集合与顺序（沉浸模式打头、danger 删除收尾）+ 「新建任务仍在
 * 行内」+ 旧行内按钮确已撤除 + 两处 i18n 键齐全 + 回调穿过 AppLayout。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(process.cwd(), 'src')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const list = (): string => read('renderer/src/components/layout/ProjectSidebarList.tsx')

describe('project row ⋯ menu', () => {
  it('the menu follows the conversation row idiom: hover-trigger + controlled open', () => {
    const src = list()
    expect(src).toContain('<EllipsisOutlined style={{ fontSize: 14 }} />')
    // Same contract as ConversationRows (open={menuOpen} onOpenChange=…
    // trigger={['hover']}): a click-trigger here opened on click only, and the
    // hover-only reveal then unmounted the trigger the moment the pointer left
    // the row for the menu — the menu died under the user's cursor.
    expect(src).toContain('open={openMenuId === project.id}')
    expect(src).toContain('onOpenChange={(open) => setOpenMenuId(open ? project.id : null)}')
    expect(src).toContain("trigger={['hover']}")
    expect(src).not.toContain("trigger={['click']}")
    // Placement parity: the conversation row passes NONE (antd default
    // bottomLeft → the menu grows rightward past the trigger). A bottomRight
    // here grew the menu leftward instead — 2026-10-30「一个向左下、一个向右下」;
    // the direction itself is pinned by scripts/probe-row-menus.mjs (real
    // Chromium, measures the overflow on each side of the trigger).
    expect(src).not.toContain('placement=')
    expect(read('renderer/src/components/layout/ConversationRows.tsx')).not.toContain('placement=')
    expect(src).toContain('data-project-more={project.id}')
    // The reveal must include the open state, or the cluster unmounts mid-menu.
    expect(src).toContain('{(hoveredId === project.id || openMenuId === project.id) && (')
  })

  it('the inline 编辑/删除 buttons are gone (moved, not duplicated)', () => {
    const src = list()
    // Neither action is a Button any more — they exist only as menu items.
    expect(src).not.toContain('icon={<EditOutlined style={{ fontSize: 13 }} />}')
    expect(src).not.toContain('icon={<DeleteOutlined style={{ fontSize: 13 }} />}')
    expect(src).not.toContain('project-row-action project-row-action-danger')
    expect(src).not.toContain('onClick={() => onEditProject?.(project)}')
  })

  it('the hover cluster is 新建任务 + ⋯ (two buttons, not three)', () => {
    const src = list()
    // 新建任务 stays a direct icon button…
    expect(src).toContain('icon={<PlusOutlined style={{ fontSize: 13 }} />}')
    expect(src).toContain('onClick={() => onCreateTask?.(project.id)}')
    // …and the rest folds into the ⋯ menu.
    expect(src).toContain('<EllipsisOutlined style={{ fontSize: 14 }} />')
    // The row's icon-button class now wraps exactly two buttons.
    expect(src.match(/className="project-row-action"/g)?.length).toBe(2)
  })

  it('menu items: 沉浸模式 first, divider, then 编辑 / 删除(danger)', () => {
    const src = list()
    const menu = src.slice(src.indexOf('const projectMenu ='), src.indexOf('const sorted ='))
    const order = [
      "key: 'immersive'",
      "type: 'divider'",
      "key: 'edit'",
      "key: 'delete'",
    ].map((needle) => menu.indexOf(needle))
    expect(order.every((i) => i > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Delete is the dangerous one, and nothing else is.
    expect(menu).toContain('danger: true')
    expect(menu.match(/danger/g)?.length).toBe(1)
  })

  it('each item runs its own handler, closes the menu first, and delete stays the existing flow', () => {
    const src = list()
    // With a controlled `open` antd does NOT auto-close on item click — every
    // handler must clear openMenuId itself (ConversationRows' menuFor contract).
    const onClick = src.slice(src.indexOf('onClick: ({ key }) => {'), src.indexOf('const sorted ='))
    expect(onClick.indexOf('setOpenMenuId(null)')).toBeGreaterThan(-1)
    expect(src).toContain("if (key === 'immersive') onEnterImmersive?.(project)")
    expect(src).toContain("else if (key === 'edit') onEditProject?.(project)")
    // The confirm dialog + cascade delete are reused verbatim.
    expect(src).toContain("else if (key === 'delete') removeProject(project, convs)")
    expect(src).toContain('window.electronAPI.projectDelete(project.id)')
  })

  it('沉浸模式 is optional (absent prop → the item is not rendered)', () => {
    const src = list()
    expect(src).toContain('onEnterImmersive?: (project: Project) => void')
    expect(src).toContain('...(onEnterImmersive')
  })

  it('the wiring hands the callback down through AppLayout', () => {
    expect(read('renderer/src/components/layout/AppLayout.tsx')).toContain(
      'onEnterImmersive={(project) => onEnterProjectWindow?.(project.id, project.name)}',
    )
  })
})

describe('project row menu i18n', () => {
  it('both locales carry the new keys', () => {
    for (const loc of ['zh', 'en'] as const) {
      const src = read(`renderer/src/i18n/locales/${loc}.ts`)
      expect(src).toContain('enterImmersive:')
      expect(src).toContain('moreProjectActions:')
      expect(src).toContain('projectWindow:')
      expect(src).toContain('newConversation:')
    }
  })
})
