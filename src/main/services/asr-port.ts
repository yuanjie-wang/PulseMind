/**
 * 子进程侧的父端口（2026-11-24，与 asr-host.ts 配对）。
 *
 * 同一份 asr-worker.js 要能跑在两种宿主里：
 *  - Electron utilityProcess：父端口是 `process.parentPort`，消息被裹一层
 *    MessageEvent（`e.data`）——Chromium 的实现，不是 node 的；
 *  - worker_threads：`parentPort` 直接给裸值。
 * 差异只在这里收口，协议本身（init/ready/transcribe/result…）两边一致。
 */

import { parentPort as threadParentPort } from 'node:worker_threads'

interface ParentPortLike {
  on(event: 'message', listener: (value: unknown) => void): void
  postMessage(value: unknown): void
}

export type AsrChildChannel = 'utility' | 'thread'

export interface AsrChildPort {
  readonly channel: AsrChildChannel
  postMessage(message: unknown): void
  onMessage(handler: (message: unknown) => void): void
}

/** utilityProcess 的 MessageEvent：带 data + ports（裸值不会同时有这两个键） */
function unwrapUtilityMessage(value: unknown): unknown {
  if (value && typeof value === 'object' && 'data' in value && 'ports' in value) {
    return (value as { data: unknown }).data
  }
  return value
}

/**
 * 取当前进程的父端口。两者都没有 = 这个模块被当普通脚本跑了，
 * 直接抛——静默挂着只会让主进程等满初始化超时。
 */
export function openChildPort(): AsrChildPort {
  return resolveChildPort((process as NodeJS.Process & { parentPort?: ParentPortLike }).parentPort, threadParentPort)
}

/**
 * 两种候选端口的取舍（导出只为单测：真实进程里只有一个存在，测试里两个都能伪造）。
 * utility 优先——Electron 的 `process.parentPort` 只会在 Node service 里出现。
 */
export function resolveChildPort(utility: ParentPortLike | null | undefined, thread: ParentPortLike | null): AsrChildPort {
  if (utility && typeof utility.on === 'function' && typeof utility.postMessage === 'function') {
    return {
      channel: 'utility',
      postMessage: (message) => utility.postMessage(message),
      onMessage: (handler) => utility.on('message', (value) => handler(unwrapUtilityMessage(value))),
    }
  }
  if (thread) {
    return {
      channel: 'thread',
      postMessage: (message) => thread.postMessage(message),
      onMessage: (handler) => thread.on('message', handler),
    }
  }
  throw new Error('ASR worker 启动失败：没有父端口（既不是 utilityProcess 也不是 worker_threads）')
}