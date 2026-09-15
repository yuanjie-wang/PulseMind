import { mkdirSync, readFileSync, writeFileSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { dumpLlmRequest, LLM_DUMP_DIR, LLM_DUMP_MAX_FILES } from '../src/main/llm/request-dump'
import { performLlmStream } from '../src/main/ipc/api-proxy.handler'

const HOME = process.env.HOME as string
const SETTINGS_PATH = join(HOME, '.pulsemind', 'settings.json')

// settings-store caches on mtime, so each settings write is given a distinct
// (monotonically newer) mtime — otherwise a same-millisecond rewrite is served
// from cache and the flag never appears to change.
let clockTick = 0
function writeSettings(raw: Record<string, unknown>): void {
  mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
  writeFileSync(SETTINGS_PATH, JSON.stringify({ profiles: [{ id: 'p1' }], activeProfileId: 'p1', ...raw }), 'utf-8')
  const stamp = new Date(Date.now() + ++clockTick * 1000)
  utimesSync(SETTINGS_PATH, stamp, stamp)
}

function dumpFiles(): string[] {
  try {
    return readdirSync(LLM_DUMP_DIR).filter(n => n.endsWith('.json')).sort()
  } catch {
    return []
  }
}

/** The console line carrying url/method/headers (the second of the pair). */
function metaLine(spy: ReturnType<typeof vi.spyOn>): string {
  const line = spy.mock.calls.map(c => String(c[0])).filter(l => l.includes('headers=')).pop()
  expect(line, 'no [LLM Dump] metadata line was logged').toBeDefined()
  return line as string
}

describe('LLM request dump', () => {
  // A packaged process always has resourcesPath; plain Node does not, and
  // storage/index.ts reads it to locate the bundled templates. Emulating
  // "packaged" therefore means providing it, or the settings read throws and
  // the gate — correctly — falls back to off.
  const realResourcesPath = process.resourcesPath
  const setPackaged = (packaged: boolean): void => {
    app.isPackaged = packaged
    if (packaged) process.resourcesPath = app.getAppPath()
    else if (realResourcesPath === undefined) delete (process as { resourcesPath?: string }).resourcesPath
    else process.resourcesPath = realResourcesPath
  }

  beforeEach(() => {
    rmSync(LLM_DUMP_DIR, { recursive: true, force: true })
    setPackaged(false)
  })
  afterEach(() => {
    setPackaged(false)
    vi.restoreAllMocks()
  })

  it('writes the body verbatim, so the file is the payload and not a re-render of it', async () => {
    // Deliberately unpretty: whitespace and key order must survive. A dump that
    // re-serialized would normalize this and could not be byte-compared against
    // the next request, which is the whole point of keeping it.
    const body = '{"model":"m","messages":[{"role":"user","content":"hi"}] }'
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await dumpLlmRequest({ requestId: 'api_1', url: 'https://api.deepseek.com/v1/chat/completions', method: 'POST', body })

    const files = dumpFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('api_1')
    expect(readFileSync(join(LLM_DUMP_DIR, files[0]), 'utf-8')).toBe(body)
    expect(spy.mock.calls.map(c => String(c[0])).some(l => l.includes(join(LLM_DUMP_DIR, files[0])))).toBe(true)
  })

  it('masks credential headers in the log and never writes headers to disk', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const body = '{"model":"deepseek-flash"}'

    await dumpLlmRequest({
      requestId: 'api_2',
      url: 'https://api.deepseek.com/v1/chat/completions',
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk-supersecretvalue1234',
        'x-api-key': 'sk-anothersecret9999',
        'Content-Type': 'application/json',
      },
      body,
    })

    const line = metaLine(spy)
    expect(line).not.toContain('supersecretvalue')
    expect(line).not.toContain('anothersecret')
    expect(line).toContain('***1234')
    expect(line).toContain('application/json') // non-secret headers stay readable
    // Headers live only in the log: the dump file is the body, exactly.
    expect(readFileSync(join(LLM_DUMP_DIR, dumpFiles()[0]), 'utf-8')).toBe(body)
  })

  it('keeps the directory bounded, dropping the oldest dumps first', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const overflow = 3
    for (let i = 0; i < LLM_DUMP_MAX_FILES + overflow; i++) {
      // requestId is zero-padded so lexical order matches write order.
      await dumpLlmRequest({ requestId: `api_${String(i).padStart(4, '0')}`, url: 'u', method: 'POST', body: `{"i":${i}}` })
    }

    const files = dumpFiles()
    expect(files).toHaveLength(LLM_DUMP_MAX_FILES)
    // The first `overflow` writes are the ones gone; the newest survived.
    expect(files.some(f => f.includes('api_0000'))).toBe(false)
    expect(files.some(f => f.includes(`api_${String(LLM_DUMP_MAX_FILES + overflow - 1).padStart(4, '0')}`))).toBe(true)
  })

  it('skips an empty body instead of littering the directory', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await dumpLlmRequest({ requestId: 'api_empty', url: 'u', method: 'POST', body: '' })

    expect(dumpFiles()).toHaveLength(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('labels each dump with message and tool counts', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})

    // An agent turn: tools present.
    await dumpLlmRequest({
      requestId: 'api_agent',
      url: 'u',
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'system' }, { role: 'user' }], tools: [{}, {}, {}] }),
    })
    expect(metaLine(spy)).toContain('msgs=2 tools=3')

    // A one-shot call (title, greeting, memory consolidation, session review):
    // two messages and no `tools` key at all — counted as zero rather than
    // omitted, so the log line distinguishes it from an agent turn.
    await dumpLlmRequest({
      requestId: 'ns_oneshot',
      url: 'u',
      method: 'POST',
      body: JSON.stringify({ model: 'm', messages: [{ role: 'system' }, { role: 'user' }] }),
    })
    expect(metaLine(spy)).toContain('msgs=2 tools=0')

    // An unparseable body (a hook can produce anything) is still written, and
    // still gets a log line — it just cannot be labelled.
    await dumpLlmRequest({ requestId: 'weird', url: 'u', method: 'POST', body: 'not json at all' })
    expect(metaLine(spy)).toContain('msgs=? tools=?')
    expect(readFileSync(join(LLM_DUMP_DIR, dumpFiles().at(-1)!), 'utf-8')).toBe('not json at all')
  })

  it('is on in dev without any setting', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    writeSettings({}) // no debugLlmRequests key at all

    await dumpLlmRequest({ requestId: 'api_dev', url: 'u', method: 'POST', body: '{"a":1}' })

    expect(dumpFiles()).toHaveLength(1)
  })

  it('stays off in a packaged build unless debugLlmRequests is set', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setPackaged(true)
    writeSettings({})

    await dumpLlmRequest({ requestId: 'api_packaged_off', url: 'u', method: 'POST', body: '{"a":1}' })
    expect(dumpFiles()).toHaveLength(0)

    // Flipping the flag in settings.json is enough — no restart, because the
    // request path re-reads it (mtime-cached) on every call.
    writeSettings({ debugLlmRequests: true })
    await dumpLlmRequest({ requestId: 'api_packaged_on', url: 'u', method: 'POST', body: '{"a":1}' })

    const files = dumpFiles()
    expect(files).toHaveLength(1)
    expect(files[0]).toContain('api_packaged_on')
  })
})

// The unit cases above never touch the call site, and the call site is where a
// mistake is quiet: a dump taken before the llm-request hook, or off a copy of
// the body, still produces a file that looks right. This drives the real
// transport against a loopback server and compares the file to the bytes the
// server actually received.
describe('LLM request dump wiring (performLlmStream)', () => {
  beforeEach(() => {
    // A sibling describe, not a child: the outer beforeEach does not reach here.
    rmSync(LLM_DUMP_DIR, { recursive: true, force: true })
    app.isPackaged = false
  })
  afterEach(() => vi.restoreAllMocks())

  it('writes the same bytes the provider receives, and masks the key it was sent with', async () => {
    let receivedBody = ''
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf-8')
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
        res.end('data: [DONE]\n\n')
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/v1/chat/completions`

    // The SSRF guard admits a private host only when the configured profile
    // points at that same host, so the loopback server has to be the profile.
    mkdirSync(join(HOME, '.pulsemind'), { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify({
      activeProfileId: 'p1',
      profiles: [{ id: 'p1', name: 'loopback', baseURL: `http://127.0.0.1:${port}`, model: 'm', maxTokens: 16 }],
    }), 'utf-8')

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.map(String).join(' ')) })

    const body = { model: 'm', stream: true, messages: [{ role: 'user', content: 'hello' }] }
    await performLlmStream('api_wired', url, {
      method: 'POST',
      headers: { Authorization: 'Bearer sk-shouldnotleak1234', 'Content-Type': 'application/json' },
      body,
    }, { onError: () => {}, onRetry: () => {}, onChunk: () => {}, onDone: () => {} }, new AbortController())
    server.close()

    const files = dumpFiles()
    expect(files).toHaveLength(1)
    const dumped = readFileSync(join(LLM_DUMP_DIR, files[0]), 'utf-8')
    expect(dumped).toBe(receivedBody)
    expect(JSON.parse(dumped)).toEqual(body)

    const line = metaLine(vi.mocked(console.log))
    expect(line).toContain(url)
    expect(line).toContain(`bytes=${dumped.length}`)
    expect(logs.join('\n')).not.toContain('sk-shouldnotleak')
  }, 20_000)
})
