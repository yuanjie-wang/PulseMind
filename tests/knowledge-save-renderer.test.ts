import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createKnowledgeSaveAction, type KnowledgeSaveInput } from '../src/renderer/src/components/chat/knowledge-save'
import type { KnowledgeFile } from '../src/shared/types/knowledge'

const input: KnowledgeSaveInput = { content: 'Exact answer\nwith detail', messageId: 'msg', conversationId: 'conv', title: 'Title', writable: true, favorited: false }
const file = { id: 'raw-id', status: 'raw' } as KnowledgeFile
function setup() {
  const deps = { save: vi.fn().mockResolvedValue(file), enqueue: vi.fn(), pending: vi.fn(), success: vi.fn(), error: vi.fn() }
  return { deps, action: createKnowledgeSaveAction(deps) }
}
describe('one-way knowledge save', () => {
  it('locks synchronously across handlers recreated with the same React ref', async () => {
    const { deps } = setup()
    let finish!: (file: KnowledgeFile) => void
    deps.save.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const ref = { current: { pending: false, saved: false } }
    const first = createKnowledgeSaveAction(deps, ref.current)(input)
    await createKnowledgeSaveAction(deps, ref.current)(input)
    expect(deps.save).toHaveBeenCalledTimes(1)
    expect(deps.success).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
    finish(file)
    await first
    await createKnowledgeSaveAction(deps, ref.current)(input)
    expect(deps.save).toHaveBeenCalledTimes(1)
    expect(deps.enqueue).toHaveBeenCalledWith(file)
    expect(deps.success).toHaveBeenCalledTimes(1)
    expect(deps.pending.mock.calls).toEqual([[true], [false]])
  })
  it('passes exact content and identifiers, without a renderer metadata write', async () => {
    const { deps, action } = setup()
    await action(input)
    expect(deps.save).toHaveBeenCalledWith({ content: input.content, messageId: 'msg', conversationId: 'conv', title: 'Title' })
  })
  it('reports failure visibly and allows retry', async () => {
    const { deps, action } = setup()
    const failure = new Error('disk full')
    deps.save.mockRejectedValueOnce(failure)
    await action(input)
    expect(deps.error).toHaveBeenCalledWith(failure)
    expect(deps.success).not.toHaveBeenCalled()
    expect(deps.enqueue).not.toHaveBeenCalled()
    await action(input)
    expect(deps.save).toHaveBeenCalledTimes(2)
    expect(deps.success).toHaveBeenCalledTimes(1)
  })
  it('rejects a missing saved file and stays retryable', async () => {
    const { deps, action } = setup()
    deps.save.mockResolvedValueOnce(undefined)
    await action(input)
    expect(deps.error).toHaveBeenCalledTimes(1)
    await action(input)
    expect(deps.success).toHaveBeenCalledTimes(1)
  })
  it.each([
    { writable: false }, { favorited: true }, { content: ' \n' },
    { messageId: ' ' }, { conversationId: '' }, { conversationId: undefined }
  ])('never writes invalid or read-only input %j', async patch => {
    const { deps, action } = setup()
    await action({ ...input, ...patch })
    expect(deps.save).not.toHaveBeenCalled()
    expect(deps.pending).not.toHaveBeenCalled()
  })
})

describe('wiring — the save action reaches the embedded hosts (full_20261011 M5-P1)', () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf-8')

  it('TranscriptView threads conversationId to SegmentBlock; both hosts pass an id', () => {
    const tv = read('../src/renderer/src/components/chat/TranscriptView.tsx')
    expect(tv).toContain('conversationId?: string')
    expect(tv).toContain('conversationId={conversationId}')
    const fac = read('../src/renderer/src/components/form-assist/FormAssistColumn.tsx')
    expect(fac).toContain('conversationId={session.conversationId}')
    const sasv = read('../src/renderer/src/components/subagent/SubAgentSessionView.tsx')
    expect(sasv).toContain('conversationId={subConvId}')
    // The hook exposes the id the column threads through:
    expect(read('../src/renderer/src/components/form-assist/useFormAssistSession.ts')).toContain('conversationId: convId ?? undefined')
  })
})
