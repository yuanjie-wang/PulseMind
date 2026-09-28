import { mkdirSync, readFileSync, writeFileSync, utimesSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { app } from 'electron'
import { dumpLlmRequest, dumpLlmResponse, summarizeResponseUsage, LLM_DUMP_DIR, LLM_DUMP_MAX_FILES } from '../src/main/llm/request-dump'
import { performLlmStream, performSimpleFetch } from '../src/main/ipc/api-proxy.handler'

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

/** The `.response.txt` siblings written by dumpLlmResponse. */
function responseFiles(): string[] {
  try {
    return readdirSync(LLM_DUMP_DIR).filter(n => n.endsWith('.response.txt')).sort()
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

// A packaged process always has resourcesPath; plain Node does not, and
// storage/index.ts reads it to locate the bundled templates. Emulating
// "packaged" therefore means providing it, or the settings read throws and
// the gate — correctly — falls back to off. Shared by the sibling describes.
const realResourcesPath = process.resourcesPath
const setPackaged = (packaged: boolean): void => {
  app.isPackaged = packaged
  if (packaged) process.resourcesPath = app.getAppPath()
  else if (realResourcesPath === undefined) delete (process as { resourcesPath?: string }).resourcesPath
  else process.resourcesPath = realResourcesPath
}

describe('LLM request dump', () => {
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

  it('obeys the settings switch in dev — flipping it off stops dumping', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // The switch writes the key; an explicit value is the user's call even in
    // dev, whose untouched default stays on. get() cannot tell "never touched"
    // from "off" (both read as false) — the gate reads the raw file's tri-state.
    writeSettings({ debugLlmRequests: false })
    await dumpLlmRequest({ requestId: 'api_dev_off', url: 'u', method: 'POST', body: '{"a":1}' })
    expect(dumpFiles()).toHaveLength(0)

    writeSettings({ debugLlmRequests: true })
    await dumpLlmRequest({ requestId: 'api_dev_on', url: 'u', method: 'POST', body: '{"a":1}' })
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

    // The response half: the SSE events exactly as the server wrote them.
    expect(responseFiles()).toHaveLength(1)
    expect(readFileSync(join(LLM_DUMP_DIR, responseFiles()[0]), 'utf-8'))
      .toBe('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')
  }, 20_000)
})

// dumpLlmResponse pairs each response with its request file and re-runs the
// same gate; the pairing (and the sibling prune) is what keeps one call's two
// halves together in a directory the next tool loop keeps churning.
describe('LLM response dump', () => {
  beforeEach(() => {
    rmSync(LLM_DUMP_DIR, { recursive: true, force: true })
    setPackaged(false)
  })
  afterEach(() => {
    setPackaged(false)
    vi.restoreAllMocks()
  })

  it('lands next to its request file, byte-identical to what was received', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const requestFile = await dumpLlmRequest({ requestId: 'api_pair', url: 'u', method: 'POST', body: '{"a":1}' })
    const sse = 'data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[]}\n\ndata: [DONE]\n\n'
    await dumpLlmResponse({ requestId: 'api_pair', requestFile, status: '200', body: sse })

    const requests = dumpFiles()
    const responses = responseFiles()
    expect(requests).toHaveLength(1)
    expect(responses).toHaveLength(1)
    expect(responses[0]).toBe(requests[0]!.replace(/\.json$/, '.response.txt'))
    expect(readFileSync(join(LLM_DUMP_DIR, responses[0]), 'utf-8')).toBe(sse)
  })

  it('carries the usage readout on the log line', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await dumpLlmResponse({
      requestId: 'api_usage', requestFile: null, status: '200',
      body: 'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_cache_hit_tokens":80}}\n\ndata: [DONE]\n\n',
    })
    const line = spy.mock.calls.map(c => String(c[0])).find(l => l.includes('[LLM Dump] response'))
    expect(line).toBeDefined()
    expect(line).toContain('status=200')
    expect(line).toContain('usage=in=120 cached=80 out=30')
  })

  it('obeys the same gate as the request dump', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    setPackaged(true)
    writeSettings({})
    await dumpLlmResponse({ requestId: 'api_gated', requestFile: null, status: '200', body: 'data: x\n\n' })
    expect(responseFiles()).toHaveLength(0)
  })

  it('prunes a response together with its request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const overflow = 3
    for (let i = 0; i < LLM_DUMP_MAX_FILES + overflow; i++) {
      const id = `api_${String(i).padStart(4, '0')}`
      const requestFile = await dumpLlmRequest({ requestId: id, url: 'u', method: 'POST', body: `{"i":${i}}` })
      await dumpLlmResponse({ requestId: id, requestFile, status: '200', body: 'data: [DONE]\n\n' })
    }
    expect(dumpFiles()).toHaveLength(LLM_DUMP_MAX_FILES)
    expect(responseFiles()).toHaveLength(LLM_DUMP_MAX_FILES)
    expect(dumpFiles().some(f => f.includes('api_0000'))).toBe(false)
    expect(responseFiles().some(f => f.includes('api_0000'))).toBe(false)
    const newest = `api_${String(LLM_DUMP_MAX_FILES + overflow - 1).padStart(4, '0')}`
    expect(responseFiles().some(f => f.includes(newest))).toBe(true)
  })
})

describe('summarizeResponseUsage', () => {
  it('reads an OpenAI-style final usage chunk', () => {
    expect(summarizeResponseUsage('data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_cache_hit_tokens":80}}\n\ndata: [DONE]\n\n'))
      .toBe(' usage=in=120 cached=80 out=30')
  })

  it('reads Anthropic usage across message_start (head) and message_delta (tail)', () => {
    const middle = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'.repeat(30)
    const sse = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":100}}}\n\n'
      + middle
      + 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":7}}\n\n'
    expect(summarizeResponseUsage(sse)).toBe(' usage=in=25 cached=100 out=7')
  })

  it('reads a non-streaming body\'s top-level usage', () => {
    expect(summarizeResponseUsage('{"id":"msg_1","usage":{"prompt_tokens":9,"completion_tokens":2}}'))
      .toBe(' usage=in=9 out=2')
  })

  it('stays silent when nothing reports usage', () => {
    expect(summarizeResponseUsage('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')).toBe('')
    expect(summarizeResponseUsage('not json at all')).toBe('')
  })
})

// The simple-fetch funnel (Anthropic-format one-shots, the connection probe)
// used to leave no trace at all — the documented dump blind spot. This drives
// it against a loopback server and asserts both halves land, and that a
// webfetch-shaped call (no withProfileHeaders) still writes nothing.
describe('LLM dump wiring (performSimpleFetch)', () => {
  beforeEach(() => {
    rmSync(LLM_DUMP_DIR, { recursive: true, force: true })
    setPackaged(false)
  })
  afterEach(() => {
    setPackaged(false)
    vi.restoreAllMocks()
  })

  it('dumps request and response for an LLM call, nothing for a webfetch-shaped one', async () => {
    const responseBody = JSON.stringify({ id: 'msg_1', usage: { input_tokens: 10, output_tokens: 5 } })
    let receivedBody = ''
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString('utf-8')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(responseBody)
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/v1/messages`

    // Same SSRF shape as the streaming wiring test: a private host is admitted
    // only when the configured profile points at it.
    writeSettings({ profiles: [{ id: 'p1', name: 'loopback', baseURL: `http://127.0.0.1:${port}`, model: 'm', maxTokens: 16 }] })

    const logs: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => { logs.push(args.map(String).join(' ')) })

    const body = JSON.stringify({ model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] })
    const result = await performSimpleFetch(url, {
      method: 'POST',
      headers: { 'x-api-key': 'sk-shouldnotleak1234', 'content-type': 'application/json' },
      body,
      withProfileHeaders: true,
    })

    expect(result).toBe(responseBody)
    expect(dumpFiles()).toHaveLength(1)
    expect(responseFiles()).toHaveLength(1)
    expect(readFileSync(join(LLM_DUMP_DIR, dumpFiles()[0]), 'utf-8')).toBe(receivedBody)
    expect(readFileSync(join(LLM_DUMP_DIR, responseFiles()[0]), 'utf-8')).toBe(responseBody)
    const line = logs.find(l => l.includes('[LLM Dump] response'))
    expect(line).toContain('usage=in=10 out=5')
    expect(logs.join('\n')).not.toContain('sk-shouldnotleak')

    // A webfetch-shaped call (no withProfileHeaders, no profileId) dumps
    // nothing. The server must still be listening here: a refused connection
    // would vanish into fetchWithRetry's backoff, not into a dump decision.
    const before = dumpFiles().length + responseFiles().length
    await performSimpleFetch(url, { method: 'POST', body: '{"ping":1}' })
    expect(dumpFiles().length + responseFiles().length).toBe(before)
    server.close()
  }, 20_000)
})
