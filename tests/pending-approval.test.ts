// ── The 授权 choice made before the conversation exists ──
// The welcome composer draws 授权 with no conversation to write it to: the active
// key is cleared by createNewConversation and the id (`conv_<ts>`) is generated
// only when the first message materializes the row. `changeApprovalMode` used to
// be guarded on `typeof activeConversationKey === 'string'`, so on a new chat the
// click was dropped on the floor and the button never moved — the desktop half of
// "权限选择无法切换". The choice is now held in a one-shot store and applied to the
// conversation the first message creates.
//
// Two layers, because neither covers the other: the store's hold/consume
// semantics run for real here, while "it is consumed *before* the session
// starts" is an ordering invariant of the wiring that no unit test can see
// (vitest has no jsdom and no @testing-library, so the hooks cannot be mounted).

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  usePendingApprovalStore,
  takePendingApprovalMode,
} from '../src/renderer/src/stores/pendingApprovalStore'

describe('pendingApprovalStore', () => {
  beforeEach(() => {
    usePendingApprovalStore.setState({ mode: null })
  })

  it('starts empty, so the welcome composer falls back to 按需确认', () => {
    expect(usePendingApprovalStore.getState().mode).toBeNull()
  })

  it('holds a choice made with no conversation to write to', () => {
    usePendingApprovalStore.getState().setMode('auto')
    expect(usePendingApprovalStore.getState().mode).toBe('auto')
  })

  it('hands the held choice to the materialization path exactly once', () => {
    usePendingApprovalStore.getState().setMode('always-ask')

    expect(takePendingApprovalMode()).toBe('always-ask')
    // Consumed: the next new conversation must not inherit it a second time.
    expect(takePendingApprovalMode()).toBeNull()
    expect(usePendingApprovalStore.getState().mode).toBeNull()
  })

  it('is a no-op take when nothing was chosen', () => {
    expect(takePendingApprovalMode()).toBeNull()
  })

  it('keeps the latest choice when the user changes their mind', () => {
    usePendingApprovalStore.getState().setMode('auto')
    usePendingApprovalStore.getState().setMode('always-ask')
    usePendingApprovalStore.getState().setMode('outside-ask')
    expect(takePendingApprovalMode()).toBe('outside-ask')
  })
})

const REPO = process.cwd()
const APP = join(REPO, 'src', 'renderer', 'src', 'App.tsx')
const CONTROLLER = join(REPO, 'src', 'renderer', 'src', 'hooks', 'useChatController.ts')
const PERSISTENCE = join(REPO, 'src', 'renderer', 'src', 'hooks', 'useConversationPersistence.ts')

describe('desktop 授权 wiring (new conversation)', () => {
  const appSrc = readFileSync(APP, 'utf-8')
  const controllerSrc = readFileSync(CONTROLLER, 'utf-8')
  const persistenceSrc = readFileSync(PERSISTENCE, 'utf-8')

  it('resolves the button through the held choice before the shared default', () => {
    // The chain gained the sticky last-used step (新建会话沿用上次选择) — the
    // held welcome choice still outranks it, and the shared default is still
    // the last resort for a first-ever run.
    expect(appSrc).toContain('pendingApprovalMode ?? settings.lastUsedApprovalMode ?? DEFAULT_APPROVAL_MODE')
  })

  it('holds the click when there is no conversation, and writes when there is', () => {
    expect(appSrc).toContain('usePendingApprovalStore.getState().setMode(mode)')
    expect(appSrc).toContain('updateConversationApproval(activeConvKey, mode)')
    // The key is the *resolved* one, so an empty sdk key (nothing open) takes the
    // branch that holds the choice instead of writing to an id that is not a
    // conversation — see tests/conversation-key.test.ts.
    expect(appSrc).toContain('const activeConvKey = conversationKeyOf(activeConversationKey)')
    expect(appSrc).toContain('if (activeConvKey) updateConversationApproval')
  })

  it('applies the held choice to the conversation the first message creates', () => {
    // Non-vacuity: the materialization block this invariant talks about is there.
    expect(controllerSrc).toContain('takePendingProjectId()')
    expect(controllerSrc).toContain('persistence.addConversation(')

    const take = controllerSrc.indexOf('takePendingApprovalMode()')
    const write = controllerSrc.indexOf('persistence.updateConversationApproval(convId, approvalSeed)')
    const start = controllerSrc.indexOf('.startLoop(content')

    expect(take).toBeGreaterThan(-1)
    expect(write).toBeGreaterThan(take)
    // Before startLoop: main reads `conversations.approval_mode` inside
    // doCreateSession, so a write issued after the loop starts would leave the
    // first turn running at the old level.
    expect(start).toBeGreaterThan(write)
  })

  it('updates the list through the store, not the post-commit ref snapshot', () => {
    // The materialization path calls updateConversationApproval in the same
    // synchronous block as addConversation. conversationsRef only syncs in a
    // useEffect (after commit), so an optimistic update derived from it ran on
    // the pre-add list: it found nothing AND wrote the old list back over the
    // just-added item. The conversation lost its approvalMode (and projectId),
    // the later bare re-add from title generation restored it without either,
    // and the composer flipped back to 按需确认 the moment the first message
    // was sent — while the DB and the engine were at 全部允许 all along.
    // The sdk's per-item setConversation reads the store's live list, which
    // addConversation updated synchronously one statement earlier.
    expect(persistenceSrc).toContain('partialOf(id, { approvalMode: mode })')
    // Non-vacuity: the stale derivation must be gone from this function, not
    // merely accompanied by the new one.
    const from = persistenceSrc.indexOf('const updateConversationApproval = useCallback')
    expect(from).toBeGreaterThan(-1)
    const end = persistenceSrc.indexOf('const activateConversation', from)
    const body = persistenceSrc.slice(from, end)
    expect(body).not.toContain('conversationsRef.current')
    expect(body).toContain('useCallback')
  })

  it('resets the held choice when a new conversation is started', () => {
    // Otherwise 新会话默认按需确认 would depend on what the user picked the last
    // time they composed one: abandon a new chat after choosing 全部允许 and the
    // following conversation would silently start unrestricted.
    const from = persistenceSrc.indexOf('const createNewConversation = useCallback')
    expect(from).toBeGreaterThan(-1)
    // Up to the next top-level `const … = ` declaration: the body, not the file.
    const rest = persistenceSrc.slice(from)
    const nextDecl = rest.slice(1).search(/\n {2}const [A-Za-z]/)
    const body = nextDecl === -1 ? rest : rest.slice(0, nextDecl + 1)

    expect(body).toContain('usePendingApprovalStore.getState().clearMode()')
  })

  it('the title-in-list edit reads the live store too (short first messages)', () => {
    // The same landmine, third trigger: generateTitle's short-message path
    // ("hi" < 6 chars) calls updateConversationTitleInList in the SAME
    // synchronous block as addConversation. Deriving existence from
    // conversationsRef missed the just-added item and took the bare re-add
    // ({key, label, updatedAt} only), REPLACING it — the conversation lost its
    // projectId and fell out of its 项目 group into 对话, while the DB binding
    // written one statement earlier stayed correct ("从工作区可以看出是属于
    // 项目类型了，但是侧边栏中，会话还是归属到了【对话】中").
    const from = persistenceSrc.indexOf('const updateConversationTitleInList = ')
    expect(from).toBeGreaterThan(-1)
    const end = persistenceSrc.indexOf('── Create new conversation', from)
    const body = persistenceSrc.slice(from, end)
    // Existence is consulted on the store's live list, which addConversation
    // updated synchronously one statement earlier.
    expect(body).toContain('getConversation(convId)')
    // The found-branch merges into that item; it may not rebuild the list from
    // the ref snapshot.
    expect(body).toContain('partialOf(convId, { label: title')
    // The genuinely-unknown branch stays, but the whole function must be free
    // of the stale derivation (non-vacuity: fails against the old ref map).
    expect(body).toContain('conversationsRef.current')
    expect(body).toContain('sortConversations(')
  })

  it('the title-in-list re-add carries the project binding (cross-window first sighting)', () => {
    // The same-window race was pinned above; the CROSS-WINDOW twin stayed open
    // (2026-11-01 用户报「沉浸模式新建的会话归到了普通对话」): a conversation
    // created in a secondary window is unknown to the other windows' lists, so
    // the CONVERSATION_TITLE_CHANGED re-add was their FIRST sighting — and it
    // minted the entry without projectId, grouping it under 对话 forever while
    // the DB row stayed correctly bound. The binding now rides the push
    // ('default' normalizes to absent) and the found-branch backfills too
    // (heals entries an older build added bare).
    const from = persistenceSrc.indexOf('const updateConversationTitleInList = ')
    const end = persistenceSrc.indexOf('── Create new conversation', from)
    const body = persistenceSrc.slice(from, end)
    expect(body).toContain('const updateConversationTitleInList = (convId: string, title: string, projectId?: string)')
    expect(body).toContain("projectId && projectId !== 'default' ? projectId : undefined")
    // The re-add entry itself carries the binding (pinned as the full shape —
    // the backfill below also contains the substring, so a bare `toContain`
    // would pass even with the re-add stripped).
    expect(body).toContain('{ key: convId, label: title, updatedAt: stamp, projectId: bound }')
    // …and the found-branch backfill is conditional (an explicit `projectId:
    // undefined` would Object.assign-wipe an entry that already has it).
    expect(body).toContain('...(bound ? { projectId: bound } : {})')
  })
})
