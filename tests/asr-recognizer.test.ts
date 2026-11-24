// ── ASR 转写编排（PLAN-voice-input §3.4；2026-11-24 子进程化）──
// 这里的编排语义是「懒加载 / 串行 / 键变即换进程 / 失败不缓存 / 空闲释放」，
// 以及事故修复的核心承诺：**子进程死了，主进程只收到一个可重试的错误**。
// 推理本身用假 worker 顶替（真 dlopen 由 probe-asr-m0 与 smoke-packed-asr 验），
// 于是崩溃路径可以被确定性地复现——这正是主进程里做不到的事。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENGINE_FILES: Record<string, string[]> = {
  darwin: ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib'],
  win32: ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll'],
  linux: ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so'],
}

const FAKE_WORKER = `'use strict'
const { parentPort } = require('node:worker_threads')
const fs = require('node:fs')
const log = process.env.FAKE_ASR_LOG
const note = (s) => { if (log) fs.appendFileSync(log, s + '\\n') }
parentPort.on('message', (m) => {
  if (m.type === 'init') {
    note('init')
    if (process.env.FAKE_ASR_FAIL_INIT === '1') {
      // 真事故里是 dlopen 失败 → 原生层直接 abort。这里用一条 stderr + 延迟退出
      // 复现「崩溃原因写在 stderr 上」的形状（紧贴 exit 的写有被截断的风险，
      // 真进程也一样，宿主侧的排空窗口就是为此留的）。
      console.error('fake engine: undefined symbol: nope')
      setTimeout(() => process.exit(2), 20)
      return
    }
    parentPort.postMessage({ type: 'ready' })
    return
  }
  if (m.type === 'transcribe') {
    note('transcribe:' + m.samples.length)
    if (m.samples.length > 0 && m.samples[0] === -1) process.exit(7)
    parentPort.postMessage({ type: 'result', id: m.id, text: 'ok-' + m.samples.length })
  }
})
`

const cleanup: Array<() => void> = []
let dispose: (() => Promise<void>) | null = null

afterEach(async () => {
  if (dispose) await dispose()
  dispose = null
  for (const fn of cleanup.splice(0)) fn()
  delete process.env.PULSEMIND_ASR_ENGINE
  delete process.env.PULSEMIND_ASR_WORKER
  delete process.env.FAKE_ASR_LOG
  delete process.env.FAKE_ASR_FAIL_INIT
  vi.resetModules()
})

interface Fixture {
  mod: typeof import('../src/main/services/asr-recognizer')
  modelDir: string
  logFile: string
  /** 假 worker 写过几行、各是什么（跨线程只能靠文件计数） */
  events: () => string[]
  inits: () => number
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'pulsemind-asr-rec-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))

  // 引擎目录：必备文件齐、无 manifest（sha 门在 manifest 缺席时跳过）
  const engineDir = join(root, 'engine')
  const modelDir = join(root, 'model')
  mkdirSync(engineDir)
  mkdirSync(modelDir)
  for (const f of ENGINE_FILES[process.platform] ?? ENGINE_FILES.linux) writeFileSync(join(engineDir, f), 'dummy')
  const workerPath = join(root, 'fake-worker.js')
  writeFileSync(workerPath, FAKE_WORKER)
  const logFile = join(root, 'fake-worker.log')
  writeFileSync(logFile, '')

  process.env.PULSEMIND_ASR_ENGINE = engineDir
  process.env.PULSEMIND_ASR_WORKER = workerPath
  process.env.FAKE_ASR_LOG = logFile

  vi.resetModules()
  const mod = await import('../src/main/services/asr-recognizer')
  dispose = mod.disposeAsr
  const events = (): string[] => readFileSync(logFile, 'utf-8').split('\n').filter(Boolean)
  return {
    mod,
    modelDir,
    logFile,
    events,
    inits: () => events().filter((e) => e === 'init').length,
  }
}

function samples(n = 160, first = 0): Float32Array {
  const s = new Float32Array(n)
  s[0] = first
  return s
}

describe('transcribeSamples — 成功路径与进程复用', () => {
  it('首段转写：懒起子进程 → init → result，文本与耗时都回到调用方', async () => {
    const f = await fixture()
    const r = await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    expect(r.text).toBe('ok-160')
    expect(r.ms).toBeGreaterThanOrEqual(0)
    expect(f.events()).toEqual(['init', 'transcribe:160'])
    expect(f.mod.getAsrEngineStatus().workerAlive).toBe(true)
  })

  it('同一模型/语言连续转写复用同一个子进程（recognizer 只建一次）', async () => {
    const f = await fixture()
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    await f.mod.transcribeSamples(samples(320), 16000, f.modelDir, { language: 'auto' })
    expect(f.inits()).toBe(1)
    expect(f.events().filter((e) => e.startsWith('transcribe'))).toEqual(['transcribe:160', 'transcribe:320'])
  })

  it('语言变了 = 换 recognizer：旧子进程被终止，新子进程重新 init', async () => {
    const f = await fixture()
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir, { language: 'zh' })
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir, { language: 'en' })
    expect(f.inits()).toBe(2)
  })

  it('getAsrEngineStatus 只定位引擎，绝不起子进程、绝不算 sha（设置页每挂载一次都问）', async () => {
    const f = await fixture()
    const st = f.mod.getAsrEngineStatus()
    expect(st.engine?.source).toBe('env')
    expect(st.engineError).toBeNull()
    expect(st.workerAlive).toBe(false)
    expect(f.events()).toEqual([])
  })
})

describe('子进程死亡 = 可重试错误，不是应用消失（2026-11-24 事故的验收面）', () => {
  it('转写途中崩溃（exit 7）：报错带退出码与日志路径，且下次调用自动重建', async () => {
    const f = await fixture()
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    const err = await f.mod.transcribeSamples(samples(160, -1), 16000, f.modelDir).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    // 用户看到的必须是「语音崩了，应用没事」，而不是应用消失后什么都没有
    expect((err as Error).message).toMatch(/语音引擎进程崩溃（code 7）/)
    expect((err as Error).message).toContain('~/.pulsemind/logs/main.log')
    // 崩溃不缓存：下一次正常调用重新起进程（init 计数 +1）
    const r = await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    expect(r.text).toBe('ok-160')
    expect(f.inits()).toBe(2)
    expect(f.mod.getAsrEngineStatus().workerAlive).toBe(true)
  })

  it('启动期死亡（引擎 dlopen 就崩）：报「启动失败」并带上 stderr 的最后一句', async () => {
    const f = await fixture()
    process.env.FAKE_ASR_FAIL_INIT = '1'
    const err = await f.mod.transcribeSamples(samples(160), 16000, f.modelDir).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/语音引擎启动失败：推理子进程退出（code 2）/)
    expect((err as Error).message).toContain('undefined symbol: nope')
    expect((err as Error).message).toContain('~/.pulsemind/logs/main.log')
    expect(f.mod.getAsrEngineStatus().workerAlive).toBe(false)

    // 失败不缓存：同一进程内换掉故障条件就能立刻重试成功（用户重按麦克风即可）
    delete process.env.FAKE_ASR_FAIL_INIT
    const r = await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    expect(r.text).toBe('ok-160')
  })
})

describe('入参门（渲染端回归的哨兵）', () => {
  it('采样率不是 16000 → 可读错误，且不起子进程', async () => {
    const f = await fixture()
    await expect(f.mod.transcribeSamples(samples(160), 8000, f.modelDir)).rejects.toThrow(/必须是 16000Hz（收到 8000）/)
    expect(existsSync(f.logFile)).toBe(true)
    expect(f.events()).toEqual([])
  })

  it('空音频 → 可读错误（没录到声音，不是引擎问题）', async () => {
    const f = await fixture()
    await expect(f.mod.transcribeSamples(new Float32Array(0), 16000, f.modelDir)).rejects.toThrow(/音频为空/)
    expect(f.events()).toEqual([])
  })
})

describe('disposeAsr — 释放与重建', () => {
  it('释放后 workerAlive=false，再次转写重新懒加载（导入模型前必须先走这一步）', async () => {
    const f = await fixture()
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    expect(f.mod.getAsrEngineStatus().workerAlive).toBe(true)
    await f.mod.disposeAsr()
    expect(f.mod.getAsrEngineStatus().workerAlive).toBe(false)
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    expect(f.inits()).toBe(2)
  })

  it('在跑的转写因释放而失败时，错误文案是「已释放」而不是「崩溃」', async () => {
    const f = await fixture()
    await f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    const p = f.mod.transcribeSamples(samples(160), 16000, f.modelDir)
    // 立刻释放：pending 里那条要么已回 result，要么被 reject 成「已释放」
    await f.mod.disposeAsr()
    const outcome = await p.then(
      (r) => r.text,
      (e: Error) => e.message,
    )
    expect(outcome === 'ok-160' || /语音引擎已释放/.test(outcome)).toBe(true)
  })
})