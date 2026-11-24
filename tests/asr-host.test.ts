// ── ASR 推理子进程宿主（2026-11-24，Linux「点停止即闪退」事故的修法）──
// worker_threads 与主进程同进程：原生层 abort/SIGSEGV/OOM-kill 会连坐整个应用，
// 一条 JS 日志都留不下。改成 Electron utilityProcess 之后，子进程的死法全部变成
// 可观测对象（退出码 + stderr 尾 + child-process-gone 的 reason）。
//
// 这里钉的是宿主适配层本身：
//  · 线程回落（纯 Node / smoke / vitest）真的能收发；
//  · 非预期退出与主动 terminate 分得清（后者不许报故障）；
//  · 死后 postMessage 抛可读错误，而不是往虚空里发；
//  · utility 分支的 fork 选项（可用 asar 内的 modulePath、stderr 必须 pipe）、
//    stderr 环形尾巴的上限、以及 stdout 必须被消费（不消费 = 子进程写满 64KB
//    管道后卡死）。

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AsrExitInfo, AsrHost } from '../src/main/services/asr-host'

const cleanup: Array<() => void> = []
const hosts: AsrHost[] = []

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.terminate().catch(() => undefined)
  for (const fn of cleanup.splice(0)) fn()
  vi.doUnmock('electron')
  vi.resetModules()
})

function scriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-host-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function writeScript(dir: string, name: string, body: string): string {
  const p = join(dir, name)
  writeFileSync(p, body, 'utf-8')
  return p
}

/** 每个测试都拿一份新模块：loadElectron 的 import('electron') 在模块加载期才解析 */
async function loadHost(): Promise<typeof import('../src/main/services/asr-host')> {
  vi.resetModules()
  return import('../src/main/services/asr-host')
}

async function spawn(
  mod: typeof import('../src/main/services/asr-host'),
  workerPath: string,
  sink: { messages: unknown[]; exits: AsrExitInfo[] },
): Promise<AsrHost> {
  const host = await mod.spawnAsrHost({
    workerPath,
    onMessage: (m) => sink.messages.push(m),
    onExit: (i) => sink.exits.push(i),
  })
  hosts.push(host)
  return host
}

async function waitFor(pred: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

// ── 线程回落（纯 Node：electron stub 没有 utilityProcess）──

describe('线程回落（纯 Node / smoke / RUN_AS_NODE）', () => {
  it('真能收发：transport=thread，消息原样往返', async () => {
    const mod = await loadHost()
    const dir = scriptDir()
    const worker = writeScript(
      dir,
      'echo.js',
      "const { parentPort } = require('node:worker_threads')\nparentPort.on('message', (m) => parentPort.postMessage({ echo: m }))\n",
    )
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, worker, sink)
    expect(host.transport).toBe('thread')
    expect(host.pid).toBeNull()
    host.postMessage({ type: 'ping', n: 1 })
    await waitFor(() => sink.messages.length > 0, 'echo')
    expect(sink.messages[0]).toEqual({ echo: { type: 'ping', n: 1 } })
  })

  it('非预期退出：code 透出且 expected=false（原生产崩溃就是这条路径）', async () => {
    const mod = await loadHost()
    const dir = scriptDir()
    const worker = writeScript(dir, 'exit3.js', 'process.exit(3)\n')
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    await spawn(mod, worker, sink)
    await waitFor(() => sink.exits.length > 0, 'exit')
    expect(sink.exits[0]).toMatchObject({ transport: 'thread', code: 3, expected: false })
    expect(sink.exits[0].stderrTail).toEqual([]) // 线程没有独立 stderr
  })

  it('workerPath 不存在：onExit code 1 + expected=false（不许静默挂着让主进程等超时）', async () => {
    const mod = await loadHost()
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    await spawn(mod, join(scriptDir(), 'no-such-worker.js'), sink)
    await waitFor(() => sink.exits.length > 0, 'exit')
    expect(sink.exits[0].expected).toBe(false)
    expect(sink.exits[0].code).not.toBeNull()
  })

  it('terminate()：expected=true，且死后 postMessage 抛可读错误', async () => {
    const mod = await loadHost()
    const dir = scriptDir()
    const worker = writeScript(dir, 'idle.js', 'setInterval(() => undefined, 1000)\n')
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, worker, sink)
    expect(host.exitInfo).toBeNull()
    await host.terminate()
    expect(host.exitInfo).toMatchObject({ expected: true })
    expect(() => host.postMessage({ type: 'transcribe' })).toThrow(/语音引擎进程已退出/)
    // terminate 幂等（dispose 与空闲释放可能各调一次）
    await host.terminate()
  })
})

// ── utilityProcess 分支（假 electron）──

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new PassThrough()
  stderr = new PassThrough()
  sent: unknown[] = []
  killed = false
  postMessage(message: unknown): void {
    this.sent.push(message)
  }
  kill(): boolean {
    this.killed = true
    setImmediate(() => this.emit('exit', 0))
    return true
  }
}

interface ForkCall {
  modulePath: string
  args: string[]
  options: Record<string, unknown>
}

async function loadWithElectron(fake: Record<string, unknown>): Promise<typeof import('../src/main/services/asr-host')> {
  vi.resetModules()
  vi.doMock('electron', () => fake)
  return import('../src/main/services/asr-host')
}

function electronWith(child: FakeChild, calls: ForkCall[], opts: { ready?: boolean; forkThrows?: string } = {}): Record<string, unknown> {
  return {
    app: { isReady: () => opts.ready !== false },
    utilityProcess: {
      fork(modulePath: string, args: string[], options: Record<string, unknown>) {
        if (opts.forkThrows) throw new Error(opts.forkThrows)
        calls.push({ modulePath, args, options })
        return child
      },
    },
  }
}

describe('utilityProcess 分支', () => {
  it('fork 选项：stdio=pipe + serviceName，modulePath 原样（打包态是 asar 内路径）', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const mod = await loadWithElectron(electronWith(child, calls))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, '/app.asar/out/main/asr-worker.js', sink)
    expect(host.transport).toBe('utility')
    expect(host.pid).toBe(4242)
    expect(calls).toHaveLength(1)
    expect(calls[0].modulePath).toBe('/app.asar/out/main/asr-worker.js')
    expect(calls[0].options).toMatchObject({ stdio: 'pipe', serviceName: mod.ASR_SERVICE_NAME })
  })

  it('serviceName 是 app 侧唯一可认的标签（不是 mojom 的默认名）', async () => {
    const mod = await loadHost()
    expect(mod.ASR_SERVICE_NAME.length).toBeGreaterThan(0)
    // child-process-gone 里 details.serviceName 恒为 node.mojom.NodeService，
    // 我们的名字落在 details.name —— 两个字段同名就没法区分是哪条服务
    expect(mod.ASR_SERVICE_NAME).not.toBe('node.mojom.NodeService')
  })

  it('消息透传：child 的 message 原样给 onMessage（不解包——解包是子进程侧的事）', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const mod = await loadWithElectron(electronWith(child, calls))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, 'worker.js', sink)
    child.emit('message', { type: 'ready' })
    expect(sink.messages).toEqual([{ type: 'ready' }])
    host.postMessage({ type: 'init' })
    expect(child.sent).toEqual([{ type: 'init' }])
  })

  it('stderr 环形尾巴：保留最后 20 行、逐行截到 600 字符，退出时随 exitInfo 交出', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const mod = await loadWithElectron(electronWith(child, calls))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    await spawn(mod, 'worker.js', sink)
    for (let i = 0; i < 25; i++) child.stderr.write(`line-${i}\n`)
    child.stderr.write('x'.repeat(900) + '\n')
    child.emit('exit', 6) // SIGABRT 的 waitpid 形态
    await waitFor(() => sink.exits.length > 0, 'exit')
    const info = sink.exits[0]
    expect(info).toMatchObject({ transport: 'utility', code: 6, expected: false })
    expect(info.stderrTail).toHaveLength(20)
    // 25 行 + 1 长行 = 26 → 尾巴是 line-6..line-24 + 长行，line-0 已被挤掉
    expect(info.stderrTail[0]).toBe('line-6')
    expect(info.stderrTail.at(-1)?.length).toBe(600)
  })

  it('半行（没有换行的最后一段）在退出时也会被收进尾巴', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const mod = await loadWithElectron(electronWith(child, calls))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    await spawn(mod, 'worker.js', sink)
    child.stderr.write('decode start: samples=8000') // 没有 \n 就死了
    child.emit('exit', 139) // SIGSEGV
    await waitFor(() => sink.exits.length > 0, 'exit')
    expect(sink.exits[0].stderrTail).toEqual(['decode start: samples=8000'])
  })

  it('stdout 必须被消费（pipe 写满 64KB 会把子进程卡在 write 上）', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const mod = await loadWithElectron(electronWith(child, calls))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    await spawn(mod, 'worker.js', sink)
    // 有消费者时 write 返回 true；无人读的 PassThrough 在高水位后返回 false
    expect(child.stdout.write(Buffer.alloc(1024))).toBe(true)
    // 再灌一大片：没有 'data' 监听的话这里会持续 false
    let last = true
    for (let i = 0; i < 1024; i++) last = child.stdout.write(Buffer.alloc(4096))
    expect(last).toBe(true)
  })

  it('terminate()：kill 一次、exit 定成 expected=true', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const mod = await loadWithElectron(electronWith(child, calls))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, 'worker.js', sink)
    await host.terminate()
    expect(child.killed).toBe(true)
    expect(host.exitInfo?.expected).toBe(true)
    await host.terminate() // 幂等：dead 之后不再 kill
    expect(sink.exits).toHaveLength(1)
  })

  it('fork 抛异常 → 回落线程（录音按钮不该在这种情况下直接报错）', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const dir = scriptDir()
    const worker = writeScript(
      dir,
      'echo.js',
      "const { parentPort } = require('node:worker_threads')\nparentPort.on('message', (m) => parentPort.postMessage(m))\n",
    )
    const mod = await loadWithElectron(electronWith(child, calls, { forkThrows: 'not ready' }))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, worker, sink)
    expect(host.transport).toBe('thread')
    host.postMessage({ type: 'ping' })
    await waitFor(() => sink.messages.length > 0, 'echo')
    expect(sink.messages[0]).toEqual({ type: 'ping' })
  })

  it('app 未 ready（fork 的官方前提）→ 直接用线程，不试 fork', async () => {
    const child = new FakeChild()
    const calls: ForkCall[] = []
    const dir = scriptDir()
    const worker = writeScript(dir, 'idle.js', 'setInterval(() => undefined, 1000)\n')
    const mod = await loadWithElectron(electronWith(child, calls, { ready: false }))
    const sink = { messages: [] as unknown[], exits: [] as AsrExitInfo[] }
    const host = await spawn(mod, worker, sink)
    expect(host.transport).toBe('thread')
    expect(calls).toHaveLength(0)
  })
})