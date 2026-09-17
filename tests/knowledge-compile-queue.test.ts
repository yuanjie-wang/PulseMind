import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
  return { module, manager, render }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

beforeEach(() => { vi.resetModules(); hooks.effects.length = 0 })
describe('real KnowledgePanel compile queue', () => {
  it('retains pre-mount entries, deduplicates, and wakes on mounted saves', async () => {
    const { module, manager, render } = await mount()
    module.enqueueCompileForFile('before-mount')
    module.enqueueCompileForFile('before-mount')
    expect(manager.compileFile).not.toHaveBeenCalled()
    const cleanups = render()
    await flush()
    expect(manager.compileFile.mock.calls).toEqual([['before-mount']])
    manager.listFilesAdvanced.mockClear()
    let complete!: (value: unknown) => void
    manager.compileFile.mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    module.enqueueCompileForFile('after-mount')
    module.enqueueCompileForFile('after-mount')
    expect(manager.compileFile.mock.calls).toEqual([['before-mount'], ['after-mount']])
    expect(manager.listFilesAdvanced).toHaveBeenCalled()
    complete({ ok: true, written: 1 })
    await flush()
    cleanups.forEach(cleanup => cleanup())
    module.enqueueCompileForFile('after-unmount')
    expect(manager.compileFile).toHaveBeenCalledTimes(2)
    render()
    await flush()
    expect(manager.compileFile).toHaveBeenLastCalledWith('after-unmount')
  })
  it('keeps raw queued without a key and compiles after configuration becomes available', async () => {
    const { module, manager, render } = await mount()
    manager.canCompile = false
    module.enqueueCompileForFile('no-key')
    const cleanups = render()
    await flush()
    expect(manager.compileFile).not.toHaveBeenCalled()
    cleanups.forEach(cleanup => cleanup())
    manager.canCompile = true
    render()
    await flush()
    expect(manager.compileFile.mock.calls).toEqual([['no-key']])
  })
})
