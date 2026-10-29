// ── review_20261028 中5：网络失败分类——结构化信号为主、文案兜底、降级可见 ──
// 旧判据是人读字符串（'terminated' / 'socket hang up'…）：Node 换版本、代理改
// 措辞、上 i18n，任何一处变动都让无人值守的重试静默关闭且无报错。新判据：先走
// err→cause 链上的机器码（code/errno），文案数组降级为第二臂；命中不了但形似
// 传输类错误码时给出 unknownCode 旗——stream-runner 据此 warn，降级可见。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const { classifyTransportFailure } = await import('../src/renderer/src/agent/engine/engine-constants')

describe('classifyTransportFailure — structured first', () => {
  it('a transport code on the error itself is retryable, no text needed', () => {
    const err = Object.assign(new Error('weird surface text'), { code: 'ECONNRESET' })
    expect(classifyTransportFailure(err, 'weird surface text').retryable).toBe(true)
  })

  it('undici nesting: the real code lives in err.cause under a bare TypeError', () => {
    const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
    const err = Object.assign(new TypeError('fetch failed'), { cause })
    expect(classifyTransportFailure(err, 'fetch failed').retryable).toBe(true)
  })

  it('deep nesting (fetch → cause → errno chain) is walked', () => {
    const err = Object.assign(new Error('a'), {
      cause: Object.assign(new Error('b'), { cause: Object.assign(new Error('c'), { errno: 'EPIPE' }) }),
    })
    expect(classifyTransportFailure(err, 'a').retryable).toBe(true)
  })

  it('the undici socket family maps by code — "other side closed" needs no wording', () => {
    const err = Object.assign(new Error('whatever the next Node says'), { code: 'UND_ERR_SOCKET' })
    expect(classifyTransportFailure(err, 'whatever the next Node says').retryable).toBe(true)
  })

  it('the fetch abort shape (ABORT_ERR) rides the structured arm like "Request aborted" did', () => {
    const err = Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' })
    expect(classifyTransportFailure(err, 'Request aborted').retryable).toBe(true)
  })
})

describe('classifyTransportFailure — text markers stay as the fallback arm', () => {
  it('proxy prose with no code anywhere still retries (the cancel sweep)', () => {
    expect(classifyTransportFailure(new Error('Request aborted by shutdown'), 'Request aborted by shutdown').retryable).toBe(true)
  })

  it('undici bare "terminated" / "other side closed" with no cause still retries', () => {
    expect(classifyTransportFailure(new Error('terminated'), 'terminated').retryable).toBe(true)
    expect(classifyTransportFailure(new Error('other side closed'), 'other side closed').retryable).toBe(true)
  })

  it('a reworded surface does not disable the retry when the code survived', () => {
    // The 中5 scenario in reverse: the TEXT drifted but the machine code is
    // still there — structured-first is exactly what keeps the retry on.
    const err = Object.assign(new Error('upstream connection severed unexpectedly'), { code: 'ECONNRESET' })
    expect(classifyTransportFailure(err, 'upstream connection severed unexpectedly').retryable).toBe(true)
  })
})

describe('classifyTransportFailure — non-transport errors', () => {
  it('HTTP status errors are never retryable at this layer', () => {
    expect(classifyTransportFailure(new Error('HTTP 500 upstream error'), 'HTTP 500 upstream error').retryable).toBe(false)
  })

  it('semantic errors with no codes and no markers stay non-retryable', () => {
    expect(classifyTransportFailure(new Error('invalid api key'), 'invalid api key').retryable).toBe(false)
    expect(classifyTransportFailure(null, 'invalid api key').retryable).toBe(false)
  })

  it('an errno-shaped code outside the set is flagged as unknownCode — the visible fall-through', () => {
    const err = Object.assign(new Error('some new transport failure'), { code: 'EAI_OVERFLOW' })
    const verdict = classifyTransportFailure(err, 'some new transport failure')
    expect(verdict.retryable).toBe(false)
    expect(verdict.unknownCode).toBe('EAI_OVERFLOW')
  })

  it('a non-transport code (HTTP status as code) is not claimed as transport-shaped', () => {
    const err = Object.assign(new Error('client error'), { code: 418 })
    const verdict = classifyTransportFailure(err, 'client error')
    expect(verdict.retryable).toBe(false)
    expect(verdict.unknownCode).toBeUndefined()
  })
})

describe('stream-runner wiring — the classifier replaced the inline marker scan', () => {
  const src = readFileSync('src/renderer/src/agent/engine/stream-runner.ts', 'utf8')

  it('gates the retry on classifyTransportFailure and keeps the HTTP guard', () => {
    expect(src).toContain('classifyTransportFailure(err, message)')
    expect(src).toContain("!message.startsWith('HTTP ') && transport.retryable")
    expect(src).not.toContain('STREAM_NETWORK_ERROR_MARKERS.some')
  })

  it('warns on the unknownCode flag so a silent retry-off becomes visible', () => {
    expect(src).toContain('transport.unknownCode')
    expect(src).toContain('review_20261028 中5 watch')
  })
})
