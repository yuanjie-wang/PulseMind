// ── Staged-queue wiring (暂存区的接线) ──
// The store and the edge rule are unit-tested for real; the React hook that
// consumes them cannot be mounted (vitest is node-env — the house style, see
// tests/pending-approval.test.ts), so the ordering invariants are asserted as
// source scans: the drain effect uses the pure edge rule + atomic take +
// restore-on-failure, 立即发送 stops the running turn BEFORE asking for a new
// one, and the strip is wired into BOTH InputArea sites through the controller.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const INPUT_AREA = read('src', 'renderer', 'src', 'components', 'chat', 'InputArea.tsx')
const CHAT_VIEW = read('src', 'renderer', 'src', 'components', 'layout', 'ChatView.tsx')
const CHAT_BODY = read('src', 'renderer', 'src', 'components', 'chat', 'ChatBody.tsx')
const APP = read('src', 'renderer', 'src', 'App.tsx')
const CONTROLLER = read('src', 'renderer', 'src', 'hooks', 'useChatController.ts')

describe('InputArea: Enter mid-run stages instead of silently dropping', () => {
  it('gates the stage branch on the staging prop + a busy turn + plain Enter', () => {
    // The three-line shape of the gate: feature on, turn running, plain Enter
    // with text — IME composition excluded, modifiers excluded. (Anchor on the
    // multiline `staging && isRequesting` gate itself: a bare 'staging &&'
    // first hits the subscription's stagedCount line above it.)
    const gate = INPUT_AREA.indexOf('staging &&\n      isRequesting')
    expect(gate).toBeGreaterThan(-1)
    const branch = INPUT_AREA.slice(gate, INPUT_AREA.indexOf('return false', gate))
    expect(branch).toContain('isRequesting')
    expect(branch).toContain("e.key === 'Enter'")
    expect(branch).toContain('!e.nativeEvent.isComposing')
    expect(branch).toContain('inputValue.trim()')
    // It stages through the store and vetoes Sender's submit (return false is
    // the contract — without it the loading flag just swallows the key).
    expect(branch).toContain('.stage(staging.convId')
    expect(INPUT_AREA.slice(INPUT_AREA.indexOf('return false', gate) - 40, INPUT_AREA.indexOf('return false', gate) + 'return false'.length)).toContain(
      'return false',
    )
  })

  it('renders the strip above the card with both per-state hints', () => {
    expect(INPUT_AREA).toContain('data-staged-strip')
    expect(INPUT_AREA).toContain('data-staged-item')
    // The hint branch is the drain rule (staged-drain.ts ACTIVE_TURN_STATUSES):
    // isRequesting covers streaming/executing/retrying/awaiting_approval and
    // isAwaitingInput the last park — keying on isRequesting alone read "won't
    // auto-send" to a user parked on ask_user while the drain sent anyway
    // (review0924 M3, also scanned in staged-drain-edge.test.ts).
    expect(INPUT_AREA).toContain("t(isRequesting || isAwaitingInput ? 'chatView.staged.hintBusy' : 'chatView.staged.hintSettled'")
    // The strip anchors through the same aboveCard slot as the mention popup
    // (inside the measured persistent group — see above-card-reserve.test.ts).
    expect(INPUT_AREA).toContain('topSlot || hasStagedStrip')
  })

  it('wires 立即发送 through takeById → onSendNow → restore on failure', () => {
    const sendNow = INPUT_AREA.indexOf('sendStagedRowById')
    expect(sendNow).toBeGreaterThan(-1)
    expect(INPUT_AREA).toContain('data-staged-sendnow')
    expect(INPUT_AREA).toContain('staging.onSendNow(item.text).then(')
    // The send never left (ok=false or rejection) → the row comes back.
    expect(INPUT_AREA).toContain('if (!ok) restore()')
    // The take IS the commit: removed before the send.
    expect(INPUT_AREA).toContain('.takeById(staging.convId, id)')
  })

  it('keeps FIFO when a fresh send happens at rest with rows queued', () => {
    // Fresh text joins the BACK, the HEAD goes out — never the fresh text
    // directly, which would jump the queue.
    const fresh = INPUT_AREA.indexOf('if (staging && stagedCount > 0)')
    expect(fresh).toBeGreaterThan(-1)
    const body = INPUT_AREA.slice(fresh, INPUT_AREA.indexOf('onSendMessage(outgoing)', fresh))
    expect(body).toContain('.stage(staging.convId, outgoing)')
    expect(body).toContain('sendStagedHead()')
    // Order inside the branch: stage first, then drain the head.
    expect(body.indexOf('.stage(staging.convId, outgoing)')).toBeLessThan(body.indexOf('sendStagedHead()'))
  })

  it('the feature is off entirely when the staging prop is absent', () => {
    // The subscription collapses to no queue and stagedCount stays 0, so every
    // reuse site (tool studio, routine, form assist) keeps today's behavior.
    expect(INPUT_AREA).toContain('staging ? s.queues[staging.convId] : undefined')
    expect(INPUT_AREA).toContain('staging && stagedQueue ? stagedQueue.length : 0')
  })
})

describe('useChatController: the drain effect and 立即发送', () => {
  it('keys the drain on the pure edge rule, not a status value', () => {
    expect(CONTROLLER).toContain('shouldDrainOnStatusChange(prev, { convId, status })')
    // The transition ref is written on every pass — mount/switch/StrictMode
    // become rebases rather than value-check drains.
    expect(CONTROLLER).toContain('stagedStatusRef.current = { convId, status }')
    // A value check must not sneak in alongside the edge check.
    const effect = CONTROLLER.slice(CONTROLLER.indexOf('const stagedStatusRef'), CONTROLLER.indexOf('const sendStagedNow'))
    expect(effect).not.toMatch(/status\s*===\s*'completed'/)
  })

  it('takes atomically and restores in place when the send never left', () => {
    const effect = CONTROLLER.slice(CONTROLLER.indexOf('const stagedStatusRef'), CONTROLLER.indexOf('const sendStagedNow'))
    expect(effect).toContain('takeStagedHead(convId)')
    expect(effect).toContain('restoreStaged(convId, item, 0)')
    // Restore is wired to BOTH the false resolution and the rejection.
    // prettier 展开单行回调——对空白鲁棒。
    expect(effect).toMatch(/\(ok\) => \{\s*if \(!ok\) restore\(\)\s*\}/)
    // 拒绝臂也恢复（prettier 重排 then 的收尾形态——对空白鲁棒）。
    expect(effect).toMatch(/,\s*restore\s*\)/)
  })

  it('handleRequest reports true/false so the caller knows whether to restore', () => {
    const from = CONTROLLER.indexOf('const handleRequest')
    const end = CONTROLLER.indexOf('const stagedStatusRef', from)
    const body = CONTROLLER.slice(from, end)
    // Success path leaves the turn.
    expect(body).toContain('return true')
    // Every bail is a false (counted, so a new early return cannot silently
    // become a message drop): api key, parse bails, busy /compact, project.
    const bails = body.match(/return false/g) ?? []
    expect(bails.length).toBeGreaterThanOrEqual(4)
    expect(body).not.toMatch(/return\s*\n\s*\}/) // no bare `return` early-exit
  })

  it('立即发送 stops the running turn BEFORE asking for a new one (stop-first)', () => {
    const from = CONTROLLER.indexOf('const sendStagedNow')
    expect(from).toBeGreaterThan(-1)
    const dep = CONTROLLER.indexOf('[engine, handleRequest]', from)
    expect(dep).toBeGreaterThan(-1)
    const body = CONTROLLER.slice(from, dep)
    const stop = body.indexOf('engine.stopExecution()')
    const ask = body.indexOf('handleRequest(text)')
    expect(stop).toBeGreaterThan(-1)
    expect(ask).toBeGreaterThan(-1)
    // prepareTurn only aborts the LLM stream — starting a turn onto a running
    // engine lets a late tool result re-enter continueLoop alongside it (two
    // loops, one transcript). stopExecution settles the tree first.
    expect(stop).toBeLessThan(ask)
  })

  it('exposes both paths to the view and sweeps queues on teardown', () => {
    expect(CONTROLLER).toContain('sendStagedNow,')
    // deleteConversation / clear-all drop the queue with the conversation.
    const del = CONTROLLER.indexOf('clearStagedMessages(key)')
    expect(del).toBeGreaterThan(-1)
    expect(CONTROLLER).toContain('clearAllStagedMessages()')
    // And handleRequest is returned (the drain calls it directly).
    expect(CONTROLLER).toMatch(/handleRequest,\n/)
  })
})

describe('ChatView / App: the strip reaches both composers', () => {
  it('ChatView accepts the interrupt path and hands staging to BOTH InputArea sites', () => {
    expect(CHAT_VIEW).toContain('onSendStaged?: (text: string) => Promise<boolean>')
    expect(CHAT_VIEW).toContain('onSendStaged,')
    // One shared expression, keyed by the open conversation.
    expect(CHAT_VIEW).toContain('onSendStaged && conversationId')
    // PLAN-layout-modes: both InputArea sites (welcome inline + main floating)
    // moved into ChatBody — the transcript face both hosts render. Exactly two
    // sites, both wired.
    const sites = (CHAT_BODY.match(/<InputArea/g) ?? []).length
    expect(sites).toBe(2)
    const wired = (CHAT_BODY.match(/staging=\{staging\}/g) ?? []).length
    expect(wired).toBe(sites)
  })

  it('App passes the controller’s stop-first sender into the view', () => {
    expect(APP).toContain('sendStagedNow,')
    expect(APP).toContain('onSendStaged={sendStagedNow}')
  })
})

describe('i18n: the strip’s copy exists in both locales', () => {
  it('zh and en carry the same four staged keys', () => {
    const zh = read('src', 'renderer', 'src', 'i18n', 'locales', 'zh.ts')
    const en = read('src', 'renderer', 'src', 'i18n', 'locales', 'en.ts')
    for (const src of [zh, en]) {
      expect(src).toContain('hintBusy:')
      expect(src).toContain('hintSettled:')
      expect(src).toContain('sendNow:')
      expect(src).toContain('remove:')
    }
    // The count placeholder rides both hints, or the number goes missing.
    expect(zh).toContain('{{count}}')
    expect(en).toContain('{{count}}')
  })
})
