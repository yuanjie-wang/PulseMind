// ── The 新建任务 guidance shake ──
// The sidebar's 新建任务 button and the history list's + land on the welcome
// view, and each click wiggles the surface the user must act on next: the
// composer in chat mode, the whole project picker in project mode (user
// 2026-09-23). Three layers here, because none covers the others:
//
//   - the store's request/cancel semantics run for real (a monotone
//     {target, seq, at} triple — seq so a consumer mounting after the bump
//     still sees it, at + a grace window so an old token never shakes a later
//     mount);
//   - shouldPlayShake is the pure decision the consuming hook defers to (the
//     animation itself is a DOM fact — probe-welcome-focus.mjs §2.5);
//   - the wiring is an ordering/placement invariant of four files that no
//     unit test can see (vitest is node-env, no mounting), so it is asserted
//     as source: the two named entries raise the shake inside handleNewTask,
//     the two deliberate no-guide entries cancel, and each welcome surface
//     subscribes with its own target.

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useNewTaskStore, type NewTaskShake } from '../src/renderer/src/stores/newTaskStore'
import { SHAKE_GRACE_MS, shouldPlayShake } from '../src/renderer/src/utils/welcome-shake'

const NOW = 1_000_000

describe('newTaskStore.requestShake', () => {
  beforeEach(() => {
    useNewTaskStore.setState({ shake: { target: null, seq: 0, at: 0 } })
  })

  it('starts silent', () => {
    expect(useNewTaskStore.getState().shake).toEqual({ target: null, seq: 0, at: 0 })
  })

  it('raises a request with a fresh timestamp and a bumped seq', () => {
    useNewTaskStore.getState().requestShake('composer')
    const shake = useNewTaskStore.getState().shake
    expect(shake.target).toBe('composer')
    expect(shake.seq).toBe(1)
    expect(shake.at).toBeGreaterThan(0)

    useNewTaskStore.getState().requestShake('projectPicker')
    const second = useNewTaskStore.getState().shake
    expect(second.seq).toBe(2)
    expect(second.target).toBe('projectPicker')
  })

  it('a cancel bumps seq so pending consumers re-decide, but leaves nothing to play', () => {
    useNewTaskStore.getState().requestShake('projectPicker')
    useNewTaskStore.getState().requestShake(null)
    const shake = useNewTaskStore.getState().shake
    expect(shake.seq).toBe(2)
    expect(shake.target).toBeNull()
    expect(shake.at).toBe(0)
  })
})

describe('shouldPlayShake', () => {
  const fresh = (target: NewTaskShake['target'], age = 0): NewTaskShake => ({
    target,
    seq: 1,
    at: NOW - age,
  })

  it('plays a fresh request for the matching target', () => {
    expect(shouldPlayShake(fresh('composer'), 'composer', NOW)).toBe(true)
    expect(shouldPlayShake(fresh('projectPicker'), 'projectPicker', NOW)).toBe(true)
  })

  it('routes by target — a composer click never wiggles the picker', () => {
    expect(shouldPlayShake(fresh('composer'), 'projectPicker', NOW)).toBe(false)
    expect(shouldPlayShake(fresh('projectPicker'), 'composer', NOW)).toBe(false)
  })

  it('honors the grace window exactly, then goes stale', () => {
    expect(shouldPlayShake(fresh('composer', SHAKE_GRACE_MS), 'composer', NOW)).toBe(true)
    expect(shouldPlayShake(fresh('composer', SHAKE_GRACE_MS + 1), 'composer', NOW)).toBe(false)
  })

  it('never plays a cancel, however fresh', () => {
    expect(shouldPlayShake(fresh(null, 0), 'composer', NOW)).toBe(false)
    expect(shouldPlayShake(fresh(null, 0), 'projectPicker', NOW)).toBe(false)
  })
})

// ── Wiring scans ──

const REPO = process.cwd()
const read = (...parts: string[]): string => readFileSync(join(REPO, ...parts), 'utf8')

/** The body of one handler in AppLayout — from its declaration to the first
 *  closing brace at the handler's own indent (inner closures indent deeper). */
const handlerBody = (src: string, name: string): string => {
  const start = src.indexOf(`const ${name} =`)
  if (start === -1) return ''
  const end = src.indexOf('\n  }', start)
  return end === -1 ? src.slice(start) : src.slice(start, end)
}

describe('wiring', () => {
  const appLayout = read('src', 'renderer', 'src', 'components', 'layout', 'AppLayout.tsx')
  const chatView = read('src', 'renderer', 'src', 'components', 'layout', 'ChatView.tsx')
  const projectCards = read('src', 'renderer', 'src', 'components', 'welcome', 'ProjectCards.tsx')

  it('handleNewTask raises the shake, targeted by the mode it just set', () => {
    const body = handlerBody(appLayout, 'handleNewTask')
    expect(body).toContain("requestShake(mode === 'project' ? 'projectPicker' : 'composer')")
    // Inside the same handler — after setMode/setProjectId, before onCreateNew —
    // so the token is always in place when the welcome view it announces lands.
    expect(body.indexOf('requestShake')).toBeGreaterThan(body.indexOf('setMode'))
    expect(body.indexOf('requestShake')).toBeLessThan(body.indexOf('onCreateNew'))
  })

  it('both named entries route through handleNewTask (the + only on the chats tab)', () => {
    expect(appLayout).toContain('onCreateNew={handleNewTask}')
    expect(handlerBody(appLayout, 'handleTabAdd')).toContain('handleNewTask()')
  })

  it('the no-guide entries cancel instead of staying silent', () => {
    // A cancel, not silence: within the grace window their mount would
    // otherwise replay a just-clicked shake (same-mode remount, target match).
    expect(handlerBody(appLayout, 'handleProjectNewTask')).toContain('requestShake(null)')
    expect(handlerBody(appLayout, 'startPlainNewTask')).toContain('requestShake(null)')
  })

  it('the welcome composer subscribes as composer, on its wrapper (not InputArea)', () => {
    expect(chatView).toContain("useWelcomeShake('composer', composerShakeRef)")
    expect(chatView).toContain('data-welcome-shake="composer"')
    // The ref rides the wrapper div around InputArea — remounting InputArea
    // itself would drop the draft text.
    const at = chatView.indexOf('data-welcome-shake="composer"')
    const wrapper = chatView.slice(at - 200, at + 200)
    expect(wrapper).toContain('ref={composerShakeRef}')
    expect(wrapper).toContain('<InputArea')
  })

  it('the project picker subscribes as projectPicker, on the region root (heading + cards)', () => {
    expect(projectCards).toContain("useWelcomeShake('projectPicker', pickerShakeRef)")
    // The ref is on the component's ROOT div, so a shake moves the heading row
    // and the card grid together — the user ruling chose the whole region.
    const root = projectCards.indexOf('data-welcome-shake="projectPicker"')
    expect(root).toBeGreaterThan(projectCards.indexOf('return ('))
    expect(projectCards.slice(root - 120, root)).toContain('ref={pickerShakeRef}')
  })

  it('a send refused by sendBlocked shakes the picker and warns (user report 2026-10-07)', () => {
    // The refusal itself is Composer-internal and silent; without the callback
    // the grey button explained nothing and Enter was a no-op ("发送无效").
    const composer = read('src', 'renderer', 'src', 'components', 'chat', 'Composer.tsx')
    expect(composer).toContain('onSendBlocked?.()')
    // The semantics live in ChatView — the component that owns sendBlocked:
    // shake the picker (the surface that owes the choice) and name the reason.
    expect(chatView).toContain("useNewTaskStore.getState().requestShake('projectPicker')")
    expect(chatView).toContain("content: t('welcome.selectProjectFirst')")
    // The toast centers over the CHAT COLUMN, not the window: antd's message
    // holder is body-level fixed (window-centered forever), the shell is
    // asymmetric (sidebar + workbench), so the notice is shifted by
    // columnCenter - windowCenter via a relative `left` — user report
    // 2026-10-07 「弹出的toast没有水平居中」.
    expect(chatView).toContain('rect.left + rect.width / 2 - window.innerWidth / 2')
    expect(chatView).toContain("style: dx ? { position: 'relative', left: dx } : undefined")
    // 2026-11-04 两形态裁定: the MAIN welcome no longer passes sendBlocked —
    // project mode with nothing picked hides the composer entirely (below), so
    // there is nothing to refuse. The refusal path survives in exactly ONE
    // place: the dock's narrow welcome (ChatBody's welcome arm), which has no
    // project cards to click — hiding the composer there would dead-end.
    const chatBody = read('src', 'renderer', 'src', 'components', 'chat', 'ChatBody.tsx')
    const narrow = chatBody.indexOf("sendBlocked={taskMode === 'project' && !newTaskProjectId}")
    expect(narrow).toBeGreaterThan(-1)
    expect(chatBody.slice(narrow, narrow + 200)).toContain('onSendBlocked={onSendBlocked}')
    expect(chatView).not.toContain('sendBlocked={taskMode')
    // And the refused attempt never reaches the controller's guard below —
    // that warning is the belt for paths that bypass the composer, not the
    // voice of this one.
    expect(composer).toContain('if (sendBlocked)')
  })

  it('project mode on the main welcome has TWO composer forms, derived from projectId alone', () => {
    // 未选中: composer not rendered at all (no grey-button limbo). chat stays
    // unconditional — except for the API-key gate (2026-11-04: a keyless
    // install hides the welcome composer outright; the guide card takes its
    // place) — browser stays hidden; the condition must render the composer
    // for project mode ONLY once a project is picked.
    expect(chatView).toContain("hasApiKey && (taskMode === 'chat' || (taskMode === 'project' && !!newTaskProjectId))")
    // 已选: the quick band cedes its height floor to the composer, same rule
    // as browser mode.
    const welcomeContent = read('src', 'renderer', 'src', 'components', 'chat', 'WelcomeContent.tsx')
    expect(welcomeContent).toContain("mode === 'browser' || (mode === 'project' && !!projectId) ? 0 : QUICK_AREA_HEIGHT")
    // ProjectCards renders the compressed strip (wash background + 更换) and
    // the picker full — the strip is the only place 更换 clears the pick.
    const projectCards = read('src', 'renderer', 'src', 'components', 'welcome', 'ProjectCards.tsx')
    expect(projectCards).toContain('data-welcome-project-strip')
    expect(projectCards).toContain('onClick={() => setProjectId(null)}')
    // The swap reads as a transition through the INCOMING surface: a one-shot
    // WAAPI enter (fade + drift) keyed by the form token on both hosts — the
    // picker root in ProjectCards, the composer wrapper in ChatView. The
    // conditional render has no exit arm by design (no dual-tree machinery for
    // a polish pass).
    expect(projectCards).toContain('playWelcomeEnter(pickerShakeRef.current')
    expect(projectCards).toContain('formKey === null')
    expect(chatView).toContain('playWelcomeEnter(composerShakeRef.current')
  })

  it('the 对话/项目/浏览器 mode swap gets the same one-shot enter (band root, mode-keyed)', () => {
    // 用户 2026-11-04: 「项目的 welcome 块的切换动效不错，对话和浏览器这两个
    // 能加吗」——同一条 playWelcomeEnter 配方，锚点是快捷区 root：它在换档时
    // 不卸载（只换内部面板），所以是三档共用的稳定过渡面；项目形态自己的
    // 选中/更换入场仍归 ProjectCards 的 form token。
    const welcomeContent = read('src', 'renderer', 'src', 'components', 'chat', 'WelcomeContent.tsx')
    expect(welcomeContent).toContain("playWelcomeEnter(bandRef.current, 'below')")
    // Keyed on `mode` ALONE: a project pick under the same mode must not
    // replay the band (ProjectCards owns that beat), and projectId must stay
    // out of this dep list.
    expect(welcomeContent).toContain('}, [mode])')
    // 挂载首跑不播（新挂载必须静止，同 ProjectCards 的 ref 闸门）。
    expect(welcomeContent).toContain('bandMountedRef.current')
    // The ref rides the band wrapper — the element that survives the swap.
    const bandAt = welcomeContent.indexOf('data-welcome-band')
    expect(bandAt).toBeGreaterThan(-1)
    expect(welcomeContent.slice(bandAt - 80, bandAt)).toContain('ref={bandRef}')
  })
})
