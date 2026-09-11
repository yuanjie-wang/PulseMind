import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { isAbsolute } from 'node:path'
import { currentSessionSandbox } from '../sandbox/session-context'

// ── Transport Interface ─────────────────────────────────────────────

export interface MCPTransport {
  connect(): Promise<void>
  send(data: string): void
  disconnect(): Promise<void>
  onMessage: ((data: string) => void) | null
  onError: ((error: Error) => void) | null
  onClose: (() => void) | null
}

// ── Stdio Transport (local subprocess) ──────────────────────────────

export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null

  onMessage: ((data: string) => void) | null = null
  onError: ((error: Error) => void) | null = null
  onClose: (() => void) | null = null

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string>,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      // shell:true on Windows makes Node join command + args with spaces
      // (quoting nothing) and hand the string to cmd.exe, which re-parses it.
      // An absolute exe path containing a space (e.g. an install dir with the
      // app version) then gets split and cmd.exe can't find the executable.
      // Only bare command names (resolved via PATH) or .cmd/.bat scripts need
      // the shell; absolute exe paths spawn directly via CreateProcess, which
      // handles spaces in the path natively.
      const lower = this.command.toLowerCase()
      const needsShell =
        process.platform === 'win32' &&
        (!isAbsolute(this.command) || lower.endsWith('.cmd') || lower.endsWith('.bat'))
      const child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: this.env,
        windowsHide: true,
        shell: needsShell,
        // M3.11: MCP subprocesses inherit the session's project workspace so
        // relative-path servers land inside the jailed root.
        cwd: currentSessionSandbox()?.workspaceDir,
      })
      this.process = child

      const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })
      rl.on('line', (line) => {
        const trimmed = line.trim()
        if (!trimmed) return
        this.onMessage?.(trimmed)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8').trim()
        if (!text) return
        // Filter out known noisy Chrome DevTools Protocol messages
        if (text.includes('No handler registered for issue code')) return
        console.log(`[MCP:stdio] stderr:`, text.slice(0, 500))
      })

      child.on('exit', (code, signal) => {
        this.process = null
        console.log(`[MCP:stdio] exited (code=${code}, signal=${signal})`)
        this.onClose?.()
      })

      child.on('error', (err) => {
        this.process = null
        reject(err)
      })

      child.on('spawn', () => {
        resolve()
      })
    })
  }

  send(data: string): void {
    if (!this.process?.stdin) throw new Error('MCP server not running')
    this.process.stdin.write(data + '\n')
  }

  disconnect(): Promise<void> {
    const child = this.process
    if (!child) return Promise.resolve()

    this.onMessage = null
    this.onError = null
    this.onClose = null

    return new Promise((resolve) => {
      if (process.platform === 'win32') {
        if (child.pid) {
          import('child_process').then(({ execFile }) => {
            execFile('taskkill', ['/F', '/T', '/PID', String(child.pid)], () => resolve())
          })
          return
        }
        resolve()
        return
      }

      child.kill('SIGTERM')
      setTimeout(() => {
        if (!child.killed) child.kill('SIGKILL')
        resolve()
      }, 3000)
    })
  }
}

// ── SSE Transport (remote HTTP server) ──────────────────────────────

interface SSESession {
  messageUrl: string
  sessionId: string
}

/** Parse SSE text lines into events, returning dispatched events + remaining partial state. */
function parseSSEBuffer(
  buf: string,
  state: { currentEvent: string; currentData: string },
): { events: Array<{ type: string; data: string }>; remaining: string; nextEvent: string; nextData: string } {
  const events: Array<{ type: string; data: string }> = []
  let { currentEvent, currentData } = state
  let remaining = buf

  while (remaining.includes('\n')) {
    const idx = remaining.indexOf('\n')
    const line = remaining.slice(0, idx).replace(/\r$/, '')
    remaining = remaining.slice(idx + 1)

    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      currentData += line.slice(6) + '\n'
    } else if (line === '') {
      if (currentEvent || currentData) {
        events.push({ type: currentEvent || 'message', data: currentData.replace(/\n$/, '') })
      }
      currentEvent = ''
      currentData = ''
    }
  }

  return { events, remaining, nextEvent: currentEvent, nextData: currentData }
}

export class SSETransport implements MCPTransport {
  private abortController: AbortController | null = null
  private session: SSESession | null = null
  onMessage: ((data: string) => void) | null = null
  onError: ((error: Error) => void) | null = null
  onClose: (() => void) | null = null

  constructor(
    private url: string,
    private headers?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    this.abortController = new AbortController()

    const response = await fetch(this.url, {
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        ...this.headers,
      },
      signal: this.abortController.signal,
    })

    if (!response.ok) {
      throw new Error(`MCP SSE 连接失败: HTTP ${response.status} ${response.statusText}`)
    }

    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    let currentData = ''

    // Phase 1 — wait for the endpoint event before resolving connect()
    while (this.session === null) {
      const { done, value } = await reader.read()
      if (done) throw new Error('SSE 连接已关闭，未收到 endpoint')

      buffer += decoder.decode(value, { stream: true })
      const result = parseSSEBuffer(buffer, { currentEvent, currentData })
      currentEvent = result.nextEvent
      currentData = result.nextData
      buffer = result.remaining

      for (const evt of result.events) {
        if (evt.type !== 'endpoint') continue
        try {
          const parsed = JSON.parse(evt.data)
          this.session = {
            messageUrl: parsed.url || parsed.messageUrl || evt.data,
            sessionId: parsed.sessionId || '',
          }
        } catch { this.session = { messageUrl: evt.data, sessionId: '' } }
        break
      }

      // If we didn't find the endpoint in the latest chunk, keep looping
      if (!this.session) continue
    }

    // Phase 2 — background read for message events
    this.backgroundRead(reader, buffer, currentEvent, currentData)
  }

  private async backgroundRead(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    initialBuf: string,
    initialEvent: string,
    initialData: string,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = initialBuf
    let currentEvent = initialEvent
    let currentData = initialData

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const result = parseSSEBuffer(buffer, { currentEvent, currentData })
        buffer = result.remaining
        currentEvent = result.nextEvent
        currentData = result.nextData

        for (const evt of result.events) {
          if (evt.type === 'message' || evt.type === '') {
            this.onMessage?.(evt.data)
          }
          // endpoint events after phase 1 are ignored (protocol advertises only once)
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      this.onClose?.()
    }
  }

  send(data: string): void {
    if (!this.session?.messageUrl) {
      throw new Error('MCP SSE 尚未连接完毕')
    }

    // Fire-and-forget POST — JSON-RPC responses arrive via the SSE stream
    fetch(this.session.messageUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.headers },
      body: data,
    }).catch((err) => {
      this.onError?.(err instanceof Error ? err : new Error(String(err)))
    })
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort()
    this.abortController = null
    this.session = null
  }
}


// ── Streamable HTTP Transport (MCP Streamable HTTP / 高德 MCP) ──

/**
 * MCP Streamable HTTP 传输层
 *
 * 与传统 SSE（先 GET 建立流再 POST）不同，Streamable HTTP 是：
 * 1. 客户端将 JSON-RPC 消息直接 POST 到服务端 URL
 * 2. 服务端直接返回 JSON-RPC 响应（同步或流式）
 * 3. 不需要初始 GET 握手，也不需要 endpoint 协商
 *
 * 适用于高德 MCP Server (https://mcp.amap.com/mcp?key=xxx)
 */
export class StreamableHTTPTransport implements MCPTransport {
  private abortController: AbortController | null = null
  private connected = false

  onMessage: ((data: string) => void) | null = null
  onError: ((error: Error) => void) | null = null
  onClose: (() => void) | null = null

  constructor(
    private url: string,
    private headers?: Record<string, string>,
  ) {}

  async connect(): Promise<void> {
    this.abortController = new AbortController()
    this.connected = true

    try {
      const response = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...this.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'ping', method: 'ping' }),
        signal: this.abortController.signal,
      })

      if (!response.ok) {
        this.connected = false
        throw new Error(`MCP Streamable HTTP 连接失败: HTTP ${response.status} ${response.statusText}`)
      }

      const text = await response.text().catch(() => '')
      if (text.trim()) {
        this.onMessage?.(text)
      }
    } catch (err) {
      this.connected = false
      if ((err as Error).name !== 'AbortError') {
        this.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  send(data: string): void {
    if (!this.connected) {
      throw new Error('MCP Streamable HTTP 尚未连接')
    }

    fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...this.headers,
      },
      body: data,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`MCP Streamable HTTP 请求失败: HTTP ${response.status} ${response.statusText}`)
        }

        const contentType = response.headers.get('content-type') || ''

        if (contentType.includes('application/json')) {
          const text = await response.text()
          if (text.trim()) {
            this.onMessage?.(text)
          }
        } else if (contentType.includes('text/event-stream')) {
          await this.readStreamingResponse(response)
        }
      })
      .catch((err) => {
        if ((err as Error).name !== 'AbortError') {
          this.onError?.(err instanceof Error ? err : new Error(String(err)))
        }
      })
  }

  private async readStreamingResponse(response: Response): Promise<void> {
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = ''
    let currentData = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const result = parseSSEBuffer(buffer, { currentEvent, currentData })
        buffer = result.remaining
        currentEvent = result.nextEvent
        currentData = result.nextData

        for (const evt of result.events) {
          this.onMessage?.(evt.data)
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        this.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    }
  }

  async disconnect(): Promise<void> {
    this.abortController?.abort()
    this.abortController = null
    this.connected = false
  }
}
