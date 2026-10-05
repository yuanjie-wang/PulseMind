import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }))
vi.mock('react', async original => {
  const real = await original<typeof import('react')>()
  const useEffect = (effect: () => void | (() => void)) => { hooks.effects.push(effect) }
  return { ...real, useEffect, default: { ...real.default, useEffect } }
})
vi.mock('../src/renderer/src/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@ant-design/x-markdown', () => ({ XMarkdown: () => null }))

async function mount() {
  const module = await import('../src/renderer/src/components/knowledge/KnowledgePanel')
  // The producers' entry point — the panel's own code paths go through the same
  // module-level queue, which is what makes these calls observable at all.
  const queue = await import('../src/renderer/src/components/knowledge/compile-queue')
  const manager = {
    canCompile: true,
    listFilesAdvanced: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getStats: vi.fn().mockResolvedValue({ total: 0, raw: 0, compiled: 0, wikiFileCount: 0 }),
    compileFile: vi.fn().mockResolvedValue({ ok: true, written: 1 }),
  }
  const render = () => {
    hooks.effects.length = 0
    renderToStaticMarkup(React.createElement(module.default, { knowledgeManager: manager as never }))
    return hooks.effects.map(effect => effect()).filter(Boolean) as Array<() => void>
  }
  return { module, queue, manager, render }
}
// Bounded flush is for NEGATIVE assertions only —「还没有发生」无法被等待.
// Positive waits go through `until`, which parks on the production state itself:
// the old fixed 12-turn flush was a guess at scheduling depth, and a loop whose
// promise chain ran deeper read as a stale assertion (the intermittent red this
// file carried until 2026-10-05, see AGENTS.md 工作节奏 rule 5).
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
const until = async (ready: () => boolean, what: string) => {
  for (let i = 0; i < 500; i++) {
    if (ready()) return
    await Promise.resolve()
  }
  throw new Error(`compile queue never reached: ${what}`)
}

beforeEach(() => { vi.resetModules(); hooks.effects.length = 0 })
describe('real KnowledgePanel compile queue', () => {
  it('retains pre-mount entries, deduplicates, and wakes on mounted saves', async () => {
    // The panel's refresh sink rides throttleTrailing (fix C for
    // 「导入大批量文件时会卡死」: enqueue → full list+stats reload per call was one
    // of the churn sources), so this test owns a fake clock.
    vi.useFakeTimers()
    try {
      const { queue, manager, render } = await mount()
      queue.enqueueCompileForFile('before-mount')
      queue.enqueueCompileForFile('before-mount')
      expect(manager.compileFile).not.toHaveBeenCalled()
      const cleanups = render()
      await until(() => manager.compileFile.mock.calls.length === 1, 'first compile after mount')
      expect(manager.compileFile.mock.calls).toEqual([['before-mount']])
      manager.listFilesAdvanced.mockClear()
      let complete!: (value: unknown) => void
      manager.compileFile.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
      queue.enqueueCompileForFile('after-mount')
      queue.enqueueCompileForFile('after-mount')
      expect(manager.compileFile.mock.calls).toEqual([['before-mount'], ['after-mount']])
      // The NEW contract: two enqueues inside the throttle window coalesce —
      // no synchronous reload per enqueue (that per-call reload was the bug)…
      expect(manager.listFilesAdvanced).not.toHaveBeenCalled()
      // …and the burst's last ask still lands one reload on the trailing edge.
      await vi.advanceTimersByTimeAsync(500)
      await until(() => manager.listFilesAdvanced.mock.calls.length === 1, 'trailing-edge reload')
      expect(manager.listFilesAdvanced).toHaveBeenCalledTimes(1)
      complete({ ok: true, written: 1 })
      // The negative below (unmount → enqueue must NOT compile) is only sound
      // once the loop has fully parked: wait on production state, not on a
      // flush guess — a still-draining loop could shift the enqueued id.
      await until(
        () => !queue.compileQueue.running && queue.compileQueue.compilingFileId === null,
        'loop parked after complete'
      )
      cleanups.forEach(cleanup => cleanup())
      queue.enqueueCompileForFile('after-unmount')
      expect(manager.compileFile).toHaveBeenCalledTimes(2)
      render()
      await until(() => manager.compileFile.mock.calls.length === 3, 'post-remount compile')
      expect(manager.compileFile).toHaveBeenLastCalledWith('after-unmount')
    } finally {
      vi.useRealTimers()
    }
  })
  it('keeps raw queued without a key and compiles after configuration becomes available', async () => {
    const { queue, manager, render } = await mount()
    manager.canCompile = false
    queue.enqueueCompileForFile('no-key')
    const cleanups = render()
    await flush()
    expect(manager.compileFile).not.toHaveBeenCalled()
    cleanups.forEach(cleanup => cleanup())
    manager.canCompile = true
    render()
    await until(() => manager.compileFile.mock.calls.length === 1, 'compile after key arrives')
    expect(manager.compileFile.mock.calls).toEqual([['no-key']])
  })
})

// The queue module exists so the producers do not import the panel — a static
// import of KnowledgePanel from the app shell or the chat put its whole subtree
// (panel + x-markdown + the preview system) into the first-paint chunk. vitest
// here cannot measure a bundle, so the rule is pinned as source.
describe('the compile queue stays out of the first-paint graph', () => {
  const readSrc = (p: string) => readFileSync(join(__dirname, '..', p), 'utf-8')

  it('non-vacuity: the scans read real sources', () => {
    expect(readSrc('src/renderer/src/App.tsx')).toContain('enqueueStartupCompile')
    expect(readSrc('src/renderer/src/components/chat/MessageGroup.tsx')).toContain('enqueueCompileForFile')
  })

  it('the two non-panel producers import the queue module, never the panel', () => {
    // App: startup auto-compile; MessageGroup: a chat card's 编译 button.
    expect(readSrc('src/renderer/src/App.tsx')).toContain("from './components/knowledge/compile-queue'")
    expect(readSrc('src/renderer/src/components/chat/MessageGroup.tsx')).toContain("from '../knowledge/compile-queue'")
    for (const p of ['src/renderer/src/App.tsx', 'src/renderer/src/components/chat/MessageGroup.tsx']) {
      expect(readSrc(p)).not.toMatch(/from '[^']*knowledge\/KnowledgePanel'/)
    }
  })

  it('ViewHost imports no view module statically — every branch is lazy', () => {
    const viewHost = readSrc('src/renderer/src/components/layout/ViewHost.tsx')
    const staticViewImports = viewHost.split('\n').filter(l => l.startsWith('import ') && /\.\.\/(centers|routine|search|settings|canvas)\//.test(l))
    expect(staticViewImports).toEqual([])
    expect(viewHost.match(/lazy\(\(\) => import\(/g)?.length ?? 0).toBeGreaterThanOrEqual(7)
  })
})
