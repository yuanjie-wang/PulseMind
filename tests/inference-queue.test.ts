import { describe, it, expect } from 'vitest'
import { enqueueInference } from '../src/main/services/inference-queue'

/**
 * PLAN-voice-input M1：从 ocr.ts 抽出的共享串行闸。OCR 与 ASR 共用一条队列，
 * 语义必须与原内联版一致——串行、异常不堵队列。
 */
describe('inference-queue', () => {
  it('runs tasks strictly serially in submission order', async () => {
    const order: number[] = []
    const release: Array<() => void> = []
    const gate = (i: number) =>
      new Promise<void>((resolve) => {
        release[i] = resolve
      })

    const p1 = enqueueInference(async () => {
      order.push(1)
      await gate(0)
      return 'one'
    })
    const p2 = enqueueInference(async () => {
      order.push(2)
      return 'two'
    })

    // task 2 must not start while task 1 is still running
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual([1])

    release[0]()
    expect(await p1).toBe('one')
    expect(await p2).toBe('two')
    expect(order).toEqual([1, 2])
  })

  it('a throwing task does not block the queue', async () => {
    const boom = enqueueInference(async () => {
      throw new Error('boom')
    })
    const after = enqueueInference(async () => 'recovered')
    await expect(boom).rejects.toThrow('boom')
    expect(await after).toBe('recovered')
  })

  it('rejects carry the original error, not an swallowed one', async () => {
    const err = Object.assign(new Error('original'), { code: 'X' })
    await expect(
      enqueueInference(async () => {
        throw err
      }),
    ).rejects.toBe(err)
  })

  it('value-returning (non-promise) results pass through', async () => {
    const r = await enqueueInference(async () => 42)
    expect(r).toBe(42)
  })
})
