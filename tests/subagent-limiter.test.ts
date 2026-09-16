import { describe, expect, it, beforeEach } from 'vitest'
import {
  MAX_PARALLEL_SUBAGENTS,
  acquireSubAgentSlot,
  activeSubAgentCount,
  queuedSubAgentCount,
  releaseQueuedSubAgents,
  resetSubAgentLimiter,
  subAgentBudgetKey,
  type ReleaseSubAgentSlot,
} from '../src/renderer/src/agent/engine/subagent-limiter'

/**
 * 并行专家上限（PLAN-parallel-experts P2）：同一会话最多三个专家同时在跑。
 *
 * 这里的每一条都是"用户会看到什么"的直接翻译——第四个专家要排队而不是也起一个
 * 引擎；空出的槽位交给队首（否则重活先到的专家永远排不上）；停止会话时排队者不
 * 能再起（用户刚按了停止）；一个会话的预算不能挡住另一个会话（两个对话各跑三个
 * 是正常的，不是超额）。
 *
 * 模块级状态：`resetSubAgentLimiter()` 在 beforeEach 里，因为同一会话键会跨测试
 * 存活，泄漏的槽位会让后面的用例假失败。
 */

/** 拿到 n 个槽位，断言它们都是立刻给的（不排队）。 */
async function takeSlots(key: string, n: number): Promise<ReleaseSubAgentSlot[]> {
  const slots = await Promise.all(Array.from({ length: n }, () => acquireSubAgentSlot(key)))
  for (const s of slots) expect(s).toBeTypeOf('function')
  return slots as ReleaseSubAgentSlot[]
}

/** 一个不会自己 resolve 的排队者：返回它的结果探针。 */
function queueWaiter(key: string): { resolved: boolean; release: ReleaseSubAgentSlot | null } {
  const probe = { resolved: false, release: null as ReleaseSubAgentSlot | null }
  void acquireSubAgentSlot(key).then((r) => {
    probe.resolved = true
    probe.release = r
  })
  return probe
}

beforeEach(() => {
  resetSubAgentLimiter()
})

describe('parallel expert cap: three per session', () => {
  it('caps a session at three experts (the number the user set)', () => {
    expect(MAX_PARALLEL_SUBAGENTS).toBe(3)
  })

  it('gives the first three slots immediately and parks the fourth', async () => {
    const key = 'conv_a'
    const held = await takeSlots(key, MAX_PARALLEL_SUBAGENTS)
    expect(activeSubAgentCount(key)).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(queuedSubAgentCount(key)).toBe(0)

    const fourth = queueWaiter(key)
    await Promise.resolve()
    await Promise.resolve()
    expect(fourth.resolved).toBe(false)
    expect(queuedSubAgentCount(key)).toBe(1)

    // 一个专家收工：槽位**转交**而不是释放重建——排队者立刻拿到，且占用数不变。
    held[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(fourth.resolved).toBe(true)
    expect(fourth.release).toBeTypeOf('function')
    expect(activeSubAgentCount(key)).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(queuedSubAgentCount(key)).toBe(0)

    for (const release of [...held.slice(1), fourth.release!]) release()
    expect(activeSubAgentCount(key)).toBe(0)
  })

  it('hands a freed slot to the queue head, FIFO', async () => {
    const key = 'conv_fifo'
    const held = await takeSlots(key, MAX_PARALLEL_SUBAGENTS)
    const order: number[] = []
    const waiting = [1, 2, 3].map((n) =>
      acquireSubAgentSlot(key).then((release) => {
        order.push(n)
        return release
      })
    )

    held[1]()
    await waiting[0]
    expect(order).toEqual([1])
    held[0]()
    await waiting[1]
    expect(order).toEqual([1, 2])
    held[2]()
    await waiting[2]
    expect(order).toEqual([1, 2, 3])

    for (const release of await Promise.all(waiting)) release!()
    expect(activeSubAgentCount(key)).toBe(0)
  })

  it('releases a slot exactly once, however often the release is called', async () => {
    const key = 'conv_idempotent'
    const release = await acquireSubAgentSlot(key)
    release!()
    release!() // a double release must not hand out a second slot
    expect(activeSubAgentCount(key)).toBe(0)

    const held = await takeSlots(key, MAX_PARALLEL_SUBAGENTS)
    const fifth = queueWaiter(key)
    await Promise.resolve()
    expect(fifth.resolved).toBe(false)
    expect(queuedSubAgentCount(key)).toBe(1)
    for (const r of held) r()
  })

  it('frees every slot when the session is stopped, and the queue never starts', async () => {
    const key = 'conv_stop'
    const held = await takeSlots(key, MAX_PARALLEL_SUBAGENTS)
    const queued = [queueWaiter(key), queueWaiter(key)]
    await Promise.resolve()
    expect(queuedSubAgentCount(key)).toBe(2)

    releaseQueuedSubAgents(key)
    await Promise.resolve()
    await Promise.resolve()
    // 排队者拿到 null：派发方据此收摊，不会在用户按停止之后再起一个专家。
    for (const waiter of queued) {
      expect(waiter.resolved).toBe(true)
      expect(waiter.release).toBeNull()
    }
    expect(queuedSubAgentCount(key)).toBe(0)

    for (const r of held) r()
    expect(activeSubAgentCount(key)).toBe(0)

    // 会话没有被打成永久满额：下一条消息照样能立刻起三个。
    const fresh = await takeSlots(key, MAX_PARALLEL_SUBAGENTS)
    for (const r of fresh) r()
  })

  it('keeps each session on its own three slots', async () => {
    const heldA = await takeSlots('conv_left', MAX_PARALLEL_SUBAGENTS)
    const heldB = await takeSlots('conv_right', MAX_PARALLEL_SUBAGENTS)
    expect(activeSubAgentCount('conv_left')).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(activeSubAgentCount('conv_right')).toBe(MAX_PARALLEL_SUBAGENTS)
    expect(queuedSubAgentCount('conv_left')).toBe(0)
    expect(queuedSubAgentCount('conv_right')).toBe(0)

    // 停止一个会话不影响另一个。
    releaseQueuedSubAgents('conv_left')
    expect(activeSubAgentCount('conv_right')).toBe(MAX_PARALLEL_SUBAGENTS)
    for (const r of [...heldA, ...heldB]) r()
  })
})

describe('expert budget key: the session, not the expert', () => {
  it('roots a nested spawn at its parent session', () => {
    // 专家的 conversationId 是 sub_…，但它要花的是父会话的三个槽位。
    expect(subAgentBudgetKey({ sessionRootId: 'conv_root', conversationId: 'sub_abc' })).toBe('conv_root')
    // 普通引擎没有 sessionRootId，会话就是它自己的会话。
    expect(subAgentBudgetKey({ conversationId: 'conv_root' })).toBe('conv_root')
    // 两者都缺（派生引擎，如工具工作室）时不能崩，也不能和真会话撞车。
    expect(subAgentBudgetKey({})).toBe('default')
  })

  it('does not let a nested spawn borrow an unspent budget', async () => {
    const root = subAgentBudgetKey({ conversationId: 'conv_root' })
    const held = await takeSlots(root, MAX_PARALLEL_SUBAGENTS)
    // 孙辈专家的键同样是根会话 → 排在同一个队里，不会另开三个槽位。
    const nested = queueWaiter(subAgentBudgetKey({ sessionRootId: 'conv_root', conversationId: 'sub_child' }))
    await Promise.resolve()
    expect(nested.resolved).toBe(false)
    expect(queuedSubAgentCount(root)).toBe(1)
    for (const r of held) r()
  })
})
