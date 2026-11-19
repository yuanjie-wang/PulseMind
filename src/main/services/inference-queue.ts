/**
 * 共享的「内存大户」串行闸 —— OCR 与 ASR 等本地推理共用一条队列。
 *
 * 本地推理（OCR +126~235MB、ASR int8 模型 + 数百 MB 激活）并发没有收益只有
 * 内存峰值，所以在进程级串行。抽成独立模块（PLAN-voice-input M1）是因为两
 * 个消费方各自持一条队列等于没有闸——ASR 与 OCR 必须互斥，这里只有一条。
 *
 * 语义与 ocr.ts 原内联版逐字节一致（2026-11-19 抽取时的原样）：异常不堵队列，
 * 后续任务照常执行；返回值只承载本次任务的结局。
 */
let queue: Promise<unknown> = Promise.resolve()

export function enqueueInference<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
