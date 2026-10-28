/**
 * webfetch 信封 + exec 空闲超时回声（PLAN-tool-issues #1/#2/#10，2026-10-28）。
 *
 * 三条同源于一份自复盘报告的代码复核：
 * - #1 手册曾声称大响应落盘 `~/.pulsemind/tmp/webfetch_<url>.txt`、只内联前 10KB——
 *   全仓零实现，模型照着去读一个从未被写过的文件。真实后盾是引擎级护栏
 *   （MAX_TOOL_RESULT_TOKENS + tmp/trunc 落盘），手册的义务是描述它。
 * - #2 元数据头无条件硬编码，JSON/API 调用方 parse 必崩（原库 19 会话 ~30 次）；
 *   `raw: true` 直出 body。顺带修死参数：schema 一直 advertised `maxLength`，执行器
 *   却从未读过。
 * - #10 exec 的 idle 超时是设计（60s 无输出即杀 + 独立 wall-clock 帽），缺的只是
 *   信封没把「idle 语义 + background:true 逃生口」回声给模型。
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.HOME = mkdtempSync(join(tmpdir(), 'pulsemind-webfetch-display-'))

const { ToolExecutor, buildWebFetchDisplay } = await import('../src/renderer/src/agent/tool-executors')
const { setHost } = await import('../src/renderer/src/agent/host')
const { BUILT_IN_TOOLS } = await import('../src/renderer/src/tools/built-in-tools')
const { toolInstructions } = await import('../src/renderer/src/tools/tool-instructions')
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

const SRC = (rel: string): string => readFileSync(join(process.cwd(), 'src', rel), 'utf8')

const URL = 'https://wttr.in/Shanghai?format=j1'
const JSON_BODY = JSON.stringify({ current_condition: [{ temp_C: '21', weatherDesc: [{ value: 'Sunny' }] }] })

// ── buildWebFetchDisplay（纯函数） ──────────────────────────────────────────

describe('buildWebFetchDisplay', () => {
  it('default: metadata header wraps the body, Size reports the ORIGINAL length', () => {
    const out = buildWebFetchDisplay(URL, 'GET', JSON_BODY)
    expect(out.startsWith('--- WebFetch ---\n')).toBe(true)
    expect(out).toContain(`  URL: ${URL}`)
    expect(out).toContain('  Method: GET')
    expect(out).toContain(`  Size: ${JSON_BODY.length.toLocaleString()} chars`)
    expect(out).toContain('--- End WebFetch ---\n\n')
    expect(out.endsWith(JSON_BODY)).toBe(true)
    // The header is exactly what broke json.loads() — the default shape must still be unparseable
    // so the raw:true contrast below is a real contrast, not a vacuous one.
    expect(() => JSON.parse(out)).toThrow()
  })

  it('raw: the body comes back byte-for-byte — a JSON payload parses', () => {
    const out = buildWebFetchDisplay(URL, 'GET', JSON_BODY, { raw: true })
    expect(out).toBe(JSON_BODY)
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON_BODY))
  })

  it('maxLength clips the body and states the original size; Size stays original', () => {
    const out = buildWebFetchDisplay(URL, 'GET', JSON_BODY, { maxLength: 10 })
    expect(out).toContain(`  Size: ${JSON_BODY.length.toLocaleString()} chars`)
    expect(out).toContain(`--- End WebFetch ---\n\n${JSON_BODY.slice(0, 10)}\n\n[Clipped by maxLength: showing 10 of ${JSON_BODY.length.toLocaleString()} chars]`)
    expect(out).not.toContain(JSON_BODY.slice(10, 30))
  })

  it('raw + maxLength: clipped body plus the note — a clipped payload is not JSON anyway, so the note costs nothing and tells the model why', () => {
    const out = buildWebFetchDisplay(URL, 'GET', JSON_BODY, { raw: true, maxLength: 10 })
    expect(out).toBe(`${JSON_BODY.slice(0, 10)}\n\n[Clipped by maxLength: showing 10 of ${JSON_BODY.length.toLocaleString()} chars]`)
    expect(out).not.toContain('--- WebFetch ---')
  })

  it('maxLength ≥ length, 0, negative or NaN: no clip, no note', () => {
    for (const maxLength of [JSON_BODY.length, JSON_BODY.length + 1, 0, -5, Number.NaN]) {
      const out = buildWebFetchDisplay(URL, 'GET', JSON_BODY, { raw: true, maxLength })
      expect(out).toBe(JSON_BODY)
    }
    expect(buildWebFetchDisplay(URL, 'GET', JSON_BODY, { maxLength: 0 })).not.toContain('Clipped')
  })
})

// ── execWebFetch 集成（真 executor + apiFetch 桩） ───────────────────────────

let lastResult: { content: string; isError: boolean } | null = null

function makeExecutor(fetched: string | null): InstanceType<typeof ToolExecutor> {
  setHost({ apiFetch: async () => fetched } as never)
  const ex = new ToolExecutor(
    { workspaceDir: '/ws', platformInfo: { platform: 'darwin' } } as never,
    new Map(), {} as never, {} as never, () => {}, () => {},
  )
  ;(ex as unknown as { addToolResult: unknown }).addToolResult = (
    _id: string, content: string, isError: boolean,
  ) => { lastResult = { content, isError } }
  lastResult = null
  return ex
}

const doFetch = async (input: Record<string, unknown>, fetched: string | null = JSON_BODY): Promise<ToolUseBlock> => {
  const ex = makeExecutor(fetched)
  const t = { type: 'tool_use', id: 't_wf', name: 'webfetch', input: { url: URL, ...input }, status: 'queued' } as ToolUseBlock
  await ex.execWebFetch(t)
  return t
}

describe('execWebFetch wiring', () => {
  it('default call keeps the metadata header (back-compat for every existing caller)', async () => {
    const t = await doFetch({})
    expect(t.exitCode).toBe(0)
    expect(lastResult?.isError).toBe(false)
    expect(lastResult?.content.startsWith('--- WebFetch ---')).toBe(true)
    expect(lastResult?.content.endsWith(JSON_BODY)).toBe(true)
  })

  it('raw:true reaches the display builder — the tool result IS the JSON body', async () => {
    const t = await doFetch({ raw: true })
    expect(t.exitCode).toBe(0)
    expect(lastResult?.content).toBe(JSON_BODY)
    expect(JSON.parse(lastResult!.content)).toEqual(JSON.parse(JSON_BODY))
  })

  it('maxLength is no longer a dead parameter — the executor reads it and clips', async () => {
    await doFetch({ raw: true, maxLength: 12 })
    expect(lastResult?.content.startsWith(JSON_BODY.slice(0, 12))).toBe(true)
    expect(lastResult?.content).toContain('[Clipped by maxLength: showing 12 of')
  })

  it('a string raw ("true") is NOT raw — only the boolean true is honoured, like every other flag here', async () => {
    await doFetch({ raw: 'true' })
    expect(lastResult?.content.startsWith('--- WebFetch ---')).toBe(true)
  })

  it('blocked fetch (host null) still errors out as before', async () => {
    const t = await doFetch({ raw: true }, null)
    expect(t.exitCode).toBe(-1)
    expect(lastResult?.isError).toBe(true)
    expect(lastResult?.content).toContain('Request failed or was blocked')
  })
})

// ── schema 与手册：文档不再虚报 ─────────────────────────────────────────────

describe('webfetch schema and manual tell the truth', () => {
  const def = BUILT_IN_TOOLS.find((d) => d.name === 'webfetch')!
  const props = def.input_schema.properties as Record<string, { type: string; description: string }>

  it('schema carries raw (boolean) and an honest maxLength', () => {
    expect(props.raw?.type).toBe('boolean')
    expect(props.raw.description).toMatch(/JSON/)
    expect(props.maxLength?.type).toBe('integer')
    expect(props.maxLength.description).toMatch(/[Cc]lip/)
    expect(props.maxLength.description).toContain('tmp/trunc/')
    expect(def.description).toContain('raw:true')
  })

  it('manual: the phantom webfetch_<url>.txt path and the 10KB figure are gone', () => {
    const manual = toolInstructions.webfetch
    expect(manual).not.toContain('webfetch_')
    expect(manual).not.toContain('10KB')
    expect(manual).not.toMatch(/Note:/)
  })

  it('manual describes the real mechanism: raw:true, maxLength, the engine-wide guardrail and its trunc/ offload', () => {
    const manual = toolInstructions.webfetch
    expect(manual).toContain('raw: true')
    expect(manual).toContain('maxLength')
    expect(manual).toContain('~/.pulsemind/tmp/trunc/')
    expect(manual).toContain('[Tool result truncated:')
    expect(manual).toContain('50MB')
    expect(manual).toContain('30s')
  })

  it('nothing in the whole source tree writes a webfetch_ file — the doc claim had no implementation to point at', () => {
    // If someone later implements a webfetch-specific offload, this pin is the
    // place to retire — together with the manual line that would describe it.
    for (const rel of ['renderer/src/agent/tool-executors.ts', 'main/ipc/api-proxy.handler.ts', 'main/agent/main-host.ts']) {
      expect(SRC(rel)).not.toContain('webfetch_')
    }
  })

  it('executor routes through buildWebFetchDisplay and reads raw + maxLength off the input', () => {
    const src = SRC('renderer/src/agent/tool-executors.ts')
    const fn = src.slice(src.indexOf('async execWebFetch('), src.indexOf('async execPickTool('))
    expect(fn).toContain("t.input?.raw === true")
    expect(fn).toContain('t.input?.maxLength')
    expect(fn).toContain('buildWebFetchDisplay(url, method, result, { raw, maxLength })')
    // The old inline template must not survive alongside the helper.
    expect(fn).not.toContain('`--- WebFetch ---')
  })
})

// ── #10 exec 空闲超时信封（terminal.ts 源码扫描——主进程文件拖 better-sqlite3，vitest 不可 import） ──

describe('exec idle-timeout notice names the rule and the escape hatch', () => {
  const term = SRC('main/services/terminal.ts')

  it('all three foreground idle paths emit the shared notice; the old literal is gone', () => {
    // svcExecuteCommand's per-command spawn, svcExecSync, and the persistent
    // shell's beginCommand (review P0-1) — one notice, three timers.
    const calls = term.match(/idleTimeoutNotice\(effectiveTimeout\)/g) ?? []
    expect(calls).toHaveLength(3)
    expect(term).not.toContain('s with no output]`')
  })

  it('the notice keeps the probe anchor and adds idle semantics + background:true', () => {
    const start = term.indexOf('export function idleTimeoutNotice(')
    const body = term.slice(start, term.indexOf('\n}\n', start))
    expect(body).toContain('with no output')            // scripts/probe-terminal-limits.mjs matches on this
    expect(body).toContain('idle timeout')
    expect(body).toContain('background: true')
    expect(body).toContain('may have been working quietly')
  })

  it('the wall-clock death keeps its own distinct line (the two deaths stay tellable apart)', () => {
    expect(term).toContain('wall-clock limit (total duration)')
    expect(term.match(/wall-clock limit \(total duration\)/g)).toHaveLength(3)
  })
})
