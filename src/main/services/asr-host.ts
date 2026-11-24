/**
 * ASR 推理子进程宿主（2026-11-24，Linux「点停止即闪退」事故）。
 *
 * 为什么必须是独立 OS 进程：`worker_threads` 与主进程同进程，原生层 abort /
 * SIGSEGV / OOM-kill 会连坐整个应用——一条 JS 日志都留不下（index.ts 的
 * uncaughtException 只接得住 JS 异常）。事故现场正是这个形状：点停止 → 首次
 * 模型加载（分段录音让首段转写恰好落在 stop）→ 应用消失，
 * `~/.pulsemind/logs/main.log` 里零证据。进程隔离之后最坏结果是「语音不可用、
 * 应用还在」，并且子进程的退出码与 stderr 都成了可落盘的物证。
 *
 * 两种传输：
 *  - Electron 主进程用 `utilityProcess.fork`（Chromium 的 Node service）。
 *    modulePath 可以落在 app.asar 内——2026-11-24 在 33.4.11 上实测通过
 *    （见 _review/review_20261124.md）；换来独立退出码、可 pipe 的 stderr，
 *    以及 app 的 `child-process-gone`（reason 里直接能读出 oom/crashed）。
 *  - 纯 Node（vitest / smoke-packed-asr / ELECTRON_RUN_AS_NODE）回落
 *    `worker_threads`，与旧实现行为等价，冒烟脚本不动。
 *
 * 两条纪律：
 *  ① utilityProcess 的 postMessage 只能转移 MessagePort，**不能**转移
 *    ArrayBuffer（传 transfer list 直接抛）——样本按结构化克隆拷贝，
 *    320KB/5s 量级可忽略；
 *  ② stdio: 'pipe' 的 stdout 也必须消费，否则子进程写满 64KB 管道会卡死。
 */

import { Worker } from 'node:worker_threads'
import { describeError, logMain } from '../main-log'

/** 出现在 app 的 child-process-gone 里（实测落在 details.name 上，不是 serviceName） */
export const ASR_SERVICE_NAME = 'PulseMind ASR'

/** stderr 环形尾巴：崩溃现场唯一物证，够长能看到 abort 的原因、够短不进不了日志 */
const STDERR_MAX_LINES = 20
const STDERR_LINE_MAX = 600
/** SIGTERM 之后等子进程自行收尸的上限（超时就不再等，反正进程要退） */
const TERMINATE_GRACE_MS = 3000
/** exit 之后再给 stderr 一点时间排空（管道里可能还有最后几行 = 崩溃现场） */
const STDERR_DRAIN_MS = 100
/** 原生层崩溃在 stderr 上最先落的那句：命中就立刻写盘，不等 exit */
const CRASH_HINT = /(abort|segmentation|sigsegv|bad_alloc|terminate called|fatal|out of memory|undefined symbol|version .*not found|assert)/i

export type AsrTransport = 'utility' | 'thread'

export interface AsrExitInfo {
  transport: AsrTransport
  /** POSIX 上 SIGABRT 以 6 出现（waitpid 语义）；SIGKILL 的语义看 child-process-gone 的 reason */
  code: number | null
  /**
   * 仅 utilityProcess、且仅当 app 的 child-process-gone 先到了才有值。
   * 实测顺序是 exit 先于 child-process-gone，所以这里通常为 null——权威判定
   * 由 asr.handler 里那条 child-process-gone 日志给出。
   */
  reason: string | null
  /** 主动 dispose 的退出，不算故障（worker.terminate() 也会报 code 1） */
  expected: boolean
  stderrTail: string[]
}

export interface AsrHostOptions {
  /** 子进程入口（打包态在 app.asar 内：out/main/asr-worker.js） */
  workerPath: string
  onMessage: (message: unknown) => void
  onExit: (info: AsrExitInfo) => void
}

export interface AsrHost {
  readonly transport: AsrTransport
  readonly pid: number | null
  /** 死亡后才非 null（与 onExit 收到的同一份） */
  readonly exitInfo: AsrExitInfo | null
  postMessage(message: unknown): void
  terminate(): Promise<void>
}

/** utilityProcess 用到的最小面（不 import electron 类型：纯 Node 环境要能起模块） */
interface UtilityChildLike {
  readonly pid?: number
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  postMessage(message: unknown): void
  kill(): boolean
  on(event: 'exit', listener: (code: number) => void): void
  on(event: 'message', listener: (message: unknown) => void): void
  on(event: 'error', listener: (type: string, location?: string) => void): void
}

interface ElectronLike {
  utilityProcess?: {
    fork: (modulePath: string, args?: string[], options?: Record<string, unknown>) => UtilityChildLike
  }
  app?: { isReady?: () => boolean }
}

/**
 * 惰性取 electron：纯 Node（vitest / 冒烟 / RUN_AS_NODE）下 import 得到
 * 冒烟的 stub 或直接失败，两条都只是「没有 utilityProcess」。
 *
 * `import()` 对内置模块的命名导出探测在 33.4.11 上是成立的（实测 ns.utilityProcess
 * 有值、ns.default === require('electron')），但探测器不给面子时就只剩 default——
 * 两种形态都认：这里认不出来会静默退回线程，等于把「进程隔离」悄悄关掉。
 */
async function loadElectron(): Promise<ElectronLike | null> {
  try {
    const ns = (await import('electron')) as unknown as ElectronLike & { default?: ElectronLike }
    const mod = ns?.utilityProcess ? ns : (ns?.default ?? ns)
    return mod && typeof mod === 'object' ? mod : null
  } catch {
    return null
  }
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/** stderr 按行收环形尾巴；崩溃关键词即时落盘 */
function collectStderr(stream: NodeJS.ReadableStream | null): { lines: string[]; flush: () => void } {
  const lines: string[] = []
  let buf = ''
  const push = (raw: string): void => {
    const line = raw.trim()
    if (!line) return
    const clipped = line.slice(0, STDERR_LINE_MAX)
    lines.push(clipped)
    while (lines.length > STDERR_MAX_LINES) lines.shift()
    if (CRASH_HINT.test(line)) logMain('ERROR', 'asr', `child stderr: ${clipped.slice(0, 300)}`)
  }
  stream?.on('data', (chunk: Buffer | string) => {
    buf += String(chunk)
    let nl = buf.indexOf('\n')
    while (nl >= 0) {
      push(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      nl = buf.indexOf('\n')
    }
  })
  return {
    lines,
    flush: () => {
      if (buf.trim()) push(buf)
      buf = ''
    },
  }
}

/** 等 stderr 排空到 end/close（或超时）：exit 早于管道读完是常态 */
function drainStderr(stream: NodeJS.ReadableStream | null, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const s = stream as (NodeJS.ReadableStream & { readableEnded?: boolean }) | null
    if (!s || s.readableEnded) return resolve()
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    s.once('end', finish)
    s.once('close', finish)
    s.once('error', finish)
  })
}

function logExit(info: AsrExitInfo): void {
  const label = `${info.transport} code=${info.code ?? '?'}`
  if (info.expected) {
    logMain('INFO', 'asr', `engine process released (${label})`)
    return
  }
  const tail = info.stderrTail.slice(-6).join(' ⏎ ') || '(no stderr)'
  logMain('ERROR', 'asr', `engine process died unexpectedly (${label}) — last stderr: ${tail}`)
}

async function spawnUtility(o: AsrHostOptions): Promise<AsrHost | null> {
  const electron = await loadElectron()
  if (!electron?.utilityProcess?.fork) return null
  // fork 只能在 app ready 之后（官方契约）；未 ready 就用线程顶上，
  // 别让录音按钮在这种情况下报错
  if (electron.app?.isReady && !electron.app.isReady()) return null

  let child: UtilityChildLike
  try {
    child = electron.utilityProcess.fork(o.workerPath, [], { stdio: 'pipe', serviceName: ASR_SERVICE_NAME })
  } catch (e) {
    logMain('WARN', 'asr', `utilityProcess.fork unavailable, falling back to worker_threads: ${describeError(e)}`)
    return null
  }

  const stderr = collectStderr(child.stderr)
  // stdout 也必须消费：pipe 写满会把子进程卡在 write 上（子进程只往 stderr 写）
  child.stdout?.on('data', () => undefined)

  let expected = false
  let dead = false
  let exitInfo: AsrExitInfo | null = null
  const exited = new Promise<void>((resolve) => {
    child.on('exit', (code) => {
      dead = true
      // 先等管道排空再定稿：子进程崩的那一瞬 stderr 往往还没读完，直接快照会
      // 丢掉恰好最重要的最后几行（中止原因就写在那里）。
      void drainStderr(child.stderr, STDERR_DRAIN_MS).then(() => {
        stderr.flush()
        exitInfo = {
          transport: 'utility',
          code: typeof code === 'number' ? code : null,
          reason: null,
          expected,
          stderrTail: [...stderr.lines],
        }
        logExit(exitInfo)
        resolve()
        o.onExit(exitInfo)
      })
    })
  })
  child.on('message', (message) => o.onMessage(message))
  child.on('error', (type, location) => {
    logMain('ERROR', 'asr', `child process error: ${type}${location ? ` @ ${location}` : ''}`)
  })
  logMain('INFO', 'asr', `engine process spawned (utility pid=${child.pid ?? '?'})`)

  return {
    transport: 'utility',
    pid: child.pid ?? null,
    get exitInfo() {
      return exitInfo
    },
    postMessage(message) {
      if (dead) throw new Error('语音引擎进程已退出，请重试')
      child.postMessage(message)
    },
    async terminate() {
      if (dead) return
      expected = true
      child.kill()
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, TERMINATE_GRACE_MS))])
    },
  }
}

function spawnThread(o: AsrHostOptions): AsrHost {
  // stdout/stderr 打开：线程的 console 默认直接落到父进程 stderr，抓不到尾巴——
  // 而 `[asr] …` 里程碑正是「引擎在哪一步死的」的唯一线索。打开后由这里收进
  // 环形尾巴，同时原样转发回 stderr，开发/冒烟时的可见性与以前一致。
  const worker = new Worker(o.workerPath, { stdout: true, stderr: true })
  const stderr = collectStderr(worker.stderr)
  worker.stderr?.on('data', (chunk: Buffer | string) => process.stderr.write(chunk))
  worker.stdout?.on('data', () => undefined)
  let expected = false
  let dead = false
  let exitInfo: AsrExitInfo | null = null
  const exited = new Promise<void>((resolve) => {
    worker.on('exit', (code) => {
      dead = true
      void drainStderr(worker.stderr, STDERR_DRAIN_MS).then(() => {
        stderr.flush()
        exitInfo = {
          transport: 'thread',
          code: typeof code === 'number' ? code : null,
          reason: null,
          expected,
          stderrTail: [...stderr.lines],
        }
        logExit(exitInfo)
        resolve()
        o.onExit(exitInfo)
      })
    })
  })
  worker.on('message', (message) => o.onMessage(message))
  // 没有 handler 的 'error' 会冒成主进程 uncaughtException；这里接住，退出由 exit 收尾
  worker.on('error', (err) => logMain('ERROR', 'asr', `engine worker error: ${describeError(err)}`))
  logMain('INFO', 'asr', 'engine process started (worker_threads fallback)')

  return {
    transport: 'thread',
    pid: null,
    get exitInfo() {
      return exitInfo
    },
    postMessage(message) {
      if (dead) throw new Error('语音引擎进程已退出，请重试')
      worker.postMessage(message)
    },
    async terminate() {
      if (dead) return
      expected = true
      await worker.terminate().catch(() => undefined)
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, TERMINATE_GRACE_MS))])
    },
  }
}

/**
 * 起一个推理子进程：优先 OS 级隔离（utilityProcess），纯 Node 环境回落线程。
 * 只有「两种都起不来」才抛错（例如 workerPath 不存在）。
 */
export async function spawnAsrHost(options: AsrHostOptions): Promise<AsrHost> {
  const utility = await spawnUtility(options)
  if (utility) return utility
  // 在 Electron 主进程里退回线程 = 隔离没接上：必须有痕迹，否则「闪退无日志」
  // 会原样复发。判据用 process.type === 'browser'（Electron 主进程的形态）而不是
  // process.versions.electron —— 后者在 ELECTRON_RUN_AS_NODE（smoke/探针）里也
  // 有值，那时没有 utilityProcess 是正常的，不该留一条假警告。
  if (process.versions.electron && (process as NodeJS.Process & { type?: string }).type === 'browser') {
    logMain('WARN', 'asr', 'utility process unavailable — inference runs in-process (no crash isolation)')
  }
  try {
    return spawnThread(options)
  } catch (e) {
    throw toError(e)
  }
}