/**
 * 后台任务悬浮条的数据层钉子（PLAN-background-tasks D，2026-11-08）。
 *
 * useBackgroundTasksStore 是悬浮条（BackgroundTasksStrip）与事件折登
 * （useConversationEngine）之间的唯一数据面：upsert 按 pid 去重、exit 按
 * pid 退场、镜像驱逐按会话整组退场。组件层（条子的展开/轮询）不在这里测。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { useBackgroundTasksStore, backgroundTaskLabel } from '../src/renderer/src/stores/backgroundTasksStore'

const reset = (): void => {
  useBackgroundTasksStore.setState({ byConversation: {} })
}

describe('backgroundTasksStore', () => {
  beforeEach(reset)

  it('upsert adds a row per pid and dedupes replays', () => {
    const { upsert } = useBackgroundTasksStore.getState()
    upsert('conv1', { pid: 100, label: 'npm run build', startedAt: 1 })
    upsert('conv1', { pid: 101, label: 'curl example.com', startedAt: 2 })
    // same pid again — replay of the same diff must not stack rows; a label
    // change (block patched late) updates in place
    upsert('conv1', { pid: 100, label: 'npm run build', startedAt: 1 })
    expect(useBackgroundTasksStore.getState().byConversation.conv1).toHaveLength(2)
    upsert('conv1', { pid: 100, label: 'npm run build --verbose', startedAt: 1 })
    const rows = useBackgroundTasksStore.getState().byConversation.conv1
    expect(rows).toHaveLength(2)
    expect(rows[0].label).toBe('npm run build --verbose')
  })

  it('remove deletes exactly one pid and drops the session key when empty', () => {
    const { upsert, remove } = useBackgroundTasksStore.getState()
    upsert('conv1', { pid: 100, label: 'a', startedAt: 1 })
    upsert('conv1', { pid: 101, label: 'b', startedAt: 2 })
    remove('conv1', 100)
    expect(useBackgroundTasksStore.getState().byConversation.conv1.map((r) => r.pid)).toEqual([101])
    remove('conv1', 101)
    expect(useBackgroundTasksStore.getState().byConversation.conv1).toBeUndefined()
    // removing an unknown pid/session is a no-op (stale exit replays)
    remove('conv1', 999)
    remove('conv2', 100)
    expect(useBackgroundTasksStore.getState().byConversation).toEqual({})
  })

  it('drop clears the whole conversation (mirror eviction)', () => {
    const { upsert, drop } = useBackgroundTasksStore.getState()
    upsert('conv1', { pid: 100, label: 'a', startedAt: 1 })
    upsert('conv2', { pid: 200, label: 'b', startedAt: 2 })
    drop('conv1')
    expect(useBackgroundTasksStore.getState().byConversation.conv1).toBeUndefined()
    expect(useBackgroundTasksStore.getState().byConversation.conv2).toHaveLength(1)
  })

  describe('backgroundTaskLabel — the display name off the tool block', () => {
    it('prefers the model-supplied short name over the command', () => {
      expect(backgroundTaskLabel({ name: '前端构建', command: 'npm run build' }, 'exec')).toBe('前端构建')
    })

    it('caps the model name at 40 chars', () => {
      expect(backgroundTaskLabel({ name: 'x'.repeat(60) }, 'exec')).toHaveLength(40)
    })

    it('falls back to the command input (same object the tool card shows)', () => {
      expect(backgroundTaskLabel({ command: 'npm run build' }, 'exec')).toBe('npm run build')
    })

    it('truncates to 64 chars and keeps only the FIRST line', () => {
      const long = `echo ${'x'.repeat(200)}`
      const label = backgroundTaskLabel({ command: long }, 'exec')
      expect(label.length).toBeLessThanOrEqual(64)
      expect(label.endsWith('…')).toBe(true)
      expect(backgroundTaskLabel({ command: 'line1\nline2' }, 'exec')).toBe('line1')
    })

    it('falls back to query, then the tool name', () => {
      expect(backgroundTaskLabel({ query: 'SELECT 1' }, 'search')).toBe('SELECT 1')
      expect(backgroundTaskLabel({}, 'some_skill')).toBe('some_skill')
      expect(backgroundTaskLabel(undefined, 'exec')).toBe('exec')
    })
  })
})
