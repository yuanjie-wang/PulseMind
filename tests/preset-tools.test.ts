import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import jsQR from 'jsqr'
import { mountToolDocument } from '../src/renderer/src/tool-studio/bridge-host'

// The preset tools ship as plain HTML documents, so nothing else in the suite
// can reach their logic. Each one's <script> is run against a minimal DOM stub
// instead: the calculator's evaluator and the pomodoro's countdown + ring maths
// are otherwise uncovered, and both have shipped visibly broken before (a `%`
// key that always errored, a keypad with holes in its last row, a decorative
// ring that never counted down, digits overflowing that ring). The qrcode
// encoder's capacity tables can't be checked by eye at all — a wrong table
// still yields a self-consistent matrix — so its acceptance is a decode
// round-trip through jsQR.

const PRESETS_DIR = fileURLToPath(new URL('../templates/pulsemind/tools/presets/', import.meta.url))

/** Arbitrary but stable epoch base, snapped to local noon so a phase that ends
 *  25 minutes later can never cross into the next local day. */
const CLOCK_BASE = (() => {
  const d = new Date(1_800_000_000_000)
  d.setHours(12, 0, 0, 0)
  return d.getTime()
})()

/** Same local-date key the presets compute, for asserting what they store. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

interface StubEl {
  textContent: string
  className: string
  style: Record<string, string | number>
  children: StubEl[]
  onclick: (() => void) | null
  classList: { toggle(cls: string, on?: boolean): void; contains(cls: string): boolean }
  appendChild(el: StubEl): void
}

interface StubDoc {
  getElementById(id: string): StubEl
  createElement(): StubEl
  addEventListener(type: string, fn: (event: unknown) => void): void
  fireKey(key: string): void
}

function makeDocument(): { doc: StubDoc; nodes: Map<string, StubEl> } {
  const nodes = new Map<string, StubEl>()
  const make = (): StubEl => {
    const classes = new Set<string>()
    return {
      textContent: '',
      className: '',
      style: {},
      children: [],
      onclick: null,
      classList: {
        toggle(cls, on) {
          if (on === undefined) {
            if (classes.has(cls)) classes.delete(cls)
            else classes.add(cls)
          } else if (on) classes.add(cls)
          else classes.delete(cls)
        },
        contains: (cls) => classes.has(cls),
      },
      appendChild(el) {
        this.children.push(el)
      },
    }
  }
  let onKey: ((event: unknown) => void) | null = null
  const doc: StubDoc = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, make())
      return nodes.get(id)!
    },
    createElement: make,
    addEventListener(type, fn) {
      if (type === 'keydown') onKey = fn
    },
    fireKey(key) {
      onKey?.({ key, preventDefault: () => {} })
    },
  }
  return { doc, nodes }
}

interface PresetRunner {
  /** Elements looked up by the script's own id attributes. */
  text(id: string): string
  style(id: string, prop: string): number
  /** Drive the fake clock without ticking the interval. */
  setClock(ms: number): void
  /** Fire the script's interval callback once. */
  tickTimer(): void
  press(key: string): void
  key(key: string): void
  call(name: 'render' | 'tick' | 'start' | 'skip' | 'reset'): void
  setLeft(seconds: number): void
  /** Number of keys the calculator built, straight from its own array. */
  keyLabels(): string[]
  /** qrcode: encode a matrix (null when the content overflows the level). */
  qrMatrix(text: string, ecl: string): boolean[][] | null
  /** Call an internal function that takes arguments (e.g. history writes). */
  invoke(name: string, ...args: unknown[]): unknown
  /** Let the storage promises settle before asserting what was persisted. */
  flush(): Promise<void>
  /** How many timers the preset has scheduled (a startup read needs none). */
  timersScheduled(): number
  /** How many storage.get calls the preset has made so far. */
  getCalls(): number
}

interface PresetOptions {
  /** Tool storage backing the bridge stub; pass the same map back in to
   *  simulate reopening the tool. */
  store?: Map<string, unknown>
}

/** Run a preset's inline script against the stub, exposing its internals. */
function loadPreset(id: string, options: PresetOptions = {}): PresetRunner {
  const html = readFileSync(`${PRESETS_DIR}${id}/app.html`, 'utf-8')
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  if (!script) throw new Error(`no inline <script> in preset ${id}`)

  const { doc, nodes } = makeDocument()
  const store = options.store ?? new Map<string, unknown>()
  let now = CLOCK_BASE
  let interval: (() => void) | null = null
  let timers = 0
  let gets = 0

  // `Date` is shadowed by the stub so both deadlines and the calendar-day key
  // read the fake clock. Real Date handles construction; only `now()` is faked.
  const RealDate = Date
  const stubDate = Object.assign(
    function (this: unknown, ...args: unknown[]) {
      return args.length ? new RealDate(args[0] as number) : new RealDate()
    },
    { now: () => now },
  )

  const windowStub = {
    pulsemind: {
      system: { notify: () => {} },
      storage: {
        get: (key: string) => {
          gets++
          return Promise.resolve(store.get(key))
        },
        set: (key: string, value: unknown) => {
          store.set(key, value)
          return Promise.resolve({ ok: true })
        },
        remove: (key: string) => {
          store.delete(key)
          return Promise.resolve({ ok: true })
        },
        keys: () => Promise.resolve([...store.keys()]),
      },
    },
  }

  const run = new Function(
    'document',
    'setInterval',
    'clearInterval',
    'setTimeout',
    'clearTimeout',
    'window',
    'Date',
    `${script}
     return {
       press: typeof press === 'function' ? press : null,
       render: typeof render === 'function' ? render : null,
       tick: typeof tick === 'function' ? tick : null,
       start: typeof start === 'function' ? start : null,
       skip: typeof skip === 'function' ? skip : null,
       reset: typeof reset === 'function' ? reset : null,
       setLeft: (v) => { left = v },
       keyLabels: typeof keys !== 'undefined' ? keys.slice() : [],
       qrMatrix: typeof qrMatrix === 'function' ? qrMatrix : null,
       commitHistory: typeof commitHistory === 'function' ? commitHistory : null,
     }`,
  )
  const api = run(
    doc,
    (fn: () => void) => {
      interval = fn
      return 1
    },
    () => {
      interval = null
    },
    // Counted, never run: a preset that has to poll the bridge on startup is
    // the bug these tests exist to catch, so it should not be quietly serviced.
    () => {
      timers++
      return timers
    },
    () => {},
    windowStub,
    stubDate,
  )

  // Presets expose different subsets of these (the calculator has no timer);
  // look one up by name so a missing function fails with a clear message.
  const fn = (name: string): ((...args: unknown[]) => unknown) => {
    const found = api[name]
    if (typeof found !== 'function') throw new Error(`preset "${id}" has no ${name}()`)
    return found as (...args: unknown[]) => unknown
  }

  return {
    text: (nodeId) => nodes.get(nodeId)?.textContent ?? '',
    style: (nodeId, prop) => Number(nodes.get(nodeId)?.style[prop] ?? NaN),
    setClock: (ms) => {
      now = ms
    },
    tickTimer: () => interval?.(),
    press: (k) => {
      fn('press')(k)
    },
    key: (k) => doc.fireKey(k),
    call: (name) => {
      fn(name)()
    },
    setLeft: (s) => api.setLeft(s),
    keyLabels: () => api.keyLabels as string[],
    qrMatrix: (text, ecl) => fn('qrMatrix')(text, ecl) as boolean[][] | null,
    invoke: (name, ...args) => fn(name)(...args),
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    timersScheduled: () => timers,
    getCalls: () => gets,
  }
}

/** Type a key sequence from a cleared state and return the shown result. */
function pressAll(run: PresetRunner, keys: string[]): string {
  run.press('C')
  for (const k of keys) run.press(k)
  return run.text('result')
}

describe('preset tool: calculator', () => {
  const calc = () => loadPreset('calculator')

  it('treats % as a postfix operator instead of throwing', () => {
    const run = calc()
    expect(pressAll(run, ['5', '0', '%'])).toBe('0.5')
    expect(pressAll(run, ['2', '0', '0', '*', '1', '0', '%', '='])).toBe('20')
    expect(pressAll(run, ['2', '0', '0', '+', '1', '0', '%', '='])).toBe('200.1')
  })

  it('evaluates the four operations, parentheses and unary minus', () => {
    const run = calc()
    expect(pressAll(run, ['1', '+', '2', '='])).toBe('3')
    expect(pressAll(run, ['(', '1', '+', '2', ')', '*', '3', '='])).toBe('9')
    expect(pressAll(run, ['-', '5', '+', '1', '='])).toBe('-4')
    expect(pressAll(run, ['5', '*', '-', '3', '='])).toBe('-15')
  })

  it('reports a clean error instead of Infinity/NaN', () => {
    const run = calc()
    expect(pressAll(run, ['1', '/', '0', '='])).toBe('错误')
    expect(pressAll(run, ['5', '+', '='])).toBe('错误')
  })

  it('treats an empty = as 0 and strips float noise', () => {
    const run = calc()
    expect(pressAll(run, ['='])).toBe('0')
    expect(pressAll(run, ['0', '.', '1', '+', '0', '.', '2', '='])).toBe('0.3')
  })

  it('refuses malformed input rather than building an unparsable expression', () => {
    const run = calc()
    expect(pressAll(run, ['*', '5'])).toBe('5')
    expect(pressAll(run, ['5', '*', '*', '3', '='])).toBe('15')
    expect(pressAll(run, ['1', '.', '.', '2'])).toBe('1.2')
    expect(pressAll(run, ['.', '5', '+', '1', '='])).toBe('1.5')
  })

  it('keeps working from the keypad and from the keyboard', () => {
    const run = calc()
    run.press('C')
    for (const k of ['7', '*', '6']) run.key(k)
    run.key('Enter')
    expect(run.text('result')).toBe('42')
  })

  it('puts every key the evaluator needs on the keypad', () => {
    // The keypad once shipped without `)`, so parentheses could be opened and
    // never closed — calling press() directly in a test would miss that, hence
    // pinning the on-screen key list itself.
    const run = calc()
    expect(run.keyLabels()).toEqual(['C', '(', ')', '←', '7', '8', '9', '/', '4', '5', '6', '*', '1', '2', '3', '-', '0', '.', '%', '+', '='])
  })

  it('lays the keys out with no holes in the grid', () => {
    // A 4-column grid with a key count that is not a multiple of four, or a
    // span that does not restore the multiple, leaves the last row ragged.
    const run = calc()
    const html = readFileSync(`${PRESETS_DIR}calculator/app.html`, 'utf-8')
    const span = Number(html.match(/grid-column:\s*span\s*(\d+)/)?.[1] ?? 0)
    const cells = run.keyLabels().length + (span > 0 ? span - 1 : 0)
    expect(cells % 4).toBe(0)
  })

  it('holds the running value while an expression is still incomplete', () => {
    // "2+" used to snap the readout back to 0 because a preview of the
    // not-yet-parsable tail failed.
    const run = calc()
    expect(pressAll(run, ['2'])).toBe('2')
    expect(pressAll(run, ['2', '+'])).toBe('2')
    expect(pressAll(run, ['2', '+', '1'])).toBe('3')
  })

  it('ignores a closing paren with nothing to close', () => {
    const run = calc()
    expect(pressAll(run, ['5', ')'])).toBe('5')
    expect(pressAll(run, ['(', '1', '+', '2', ')', '*', '3', '='])).toBe('9')
    expect(pressAll(run, ['5', '('])).toBe('5') // no implicit multiplication
  })
})

describe('preset tool: pomodoro', () => {
  const C = 2 * Math.PI * 115

  function started(options: PresetOptions = {}) {
    const run = loadPreset('pomodoro', options)
    run.setClock(CLOCK_BASE)
    run.call('reset')
    run.call('start')
    return run
  }

  it('draws the ring as a countdown, not as a static border', () => {
    const run = started()
    expect(run.style('progress', 'strokeDasharray')).toBeCloseTo(C, 1)
    expect(run.style('progress', 'strokeDashoffset')).toBeCloseTo(0, 1)

    run.setLeft(750)
    run.call('render')
    expect(run.text('clock')).toBe('12:30')
    expect(run.style('progress', 'strokeDashoffset')).toBeCloseTo(C / 2, 1)
  })

  it('never lets the ring exceed its own circumference', () => {
    const run = started()
    for (const left of [0, 1, 750, 1500, 1500 * 2]) {
      run.setLeft(left)
      run.call('render')
      const offset = run.style('progress', 'strokeDashoffset')
      expect(offset).toBeGreaterThanOrEqual(0)
      expect(offset).toBeLessThanOrEqual(C + 0.01)
    }
  })

  it('counts down to the second without an off-by-one', () => {
    const run = started()
    run.setClock(CLOCK_BASE + 900)
    run.tickTimer()
    expect(run.text('clock')).toBe('25:00') // 25:00 holds through the first second
    run.setClock(CLOCK_BASE + 1000)
    run.tickTimer()
    expect(run.text('clock')).toBe('24:59')
  })

  it('does not drift when a tick lands late', () => {
    // The tool runs in an iframe, where timers are throttled: the remaining
    // time is derived from the deadline, so a missed tick self-corrects.
    const run = started()
    run.setClock(CLOCK_BASE + 10 * 60 * 1000 + 700)
    run.tickTimer()
    expect(run.text('clock')).toBe('15:00')
    run.setClock(CLOCK_BASE + 10 * 60 * 1000 + 1000)
    run.tickTimer()
    expect(run.text('clock')).toBe('14:59')
  })

  it('rolls into the break, counts the pomodoro, then stops', () => {
    const run = started()
    run.setClock(CLOCK_BASE + 25 * 60 * 1000)
    run.tickTimer()
    expect(run.text('clock')).toBe('05:00')
    expect(run.text('mode')).toBe('休息 · 05:00')
    expect(run.text('count')).toBe('今日完成 1 个番茄')
    expect(run.text('start')).toBe('暂停') // the break keeps running

    run.setClock(CLOCK_BASE + 30 * 60 * 1000)
    run.tickTimer()
    expect(run.text('clock')).toBe('25:00') // ready for the next pomodoro
    expect(run.text('mode')).toBe('专注 · 25:00')
    expect(run.text('start')).toBe('开始') // and stopped, waiting for the user
    expect(run.text('count')).toBe('今日完成 1 个番茄')
    expect(run.style('progress', 'strokeDashoffset')).toBeCloseTo(0, 1)
  })

  it('does not count a skipped phase', () => {
    const run = started()
    run.call('skip')
    expect(run.text('mode')).toBe('休息 · 05:00')
    expect(run.text('count')).toBe('今日完成 0 个番茄')
  })

  it('persists the completed count through tool storage', async () => {
    const store = new Map<string, unknown>()
    const run = started({ store })
    expect(run.text('count')).toBe('今日完成 0 个番茄')

    run.setClock(CLOCK_BASE + 25 * 60 * 1000)
    run.tickTimer()
    await run.flush()
    // Stored as { date, count } so a later day can tell the record is stale.
    expect(store.get('pomodoro.done')).toEqual({ date: dayKey(CLOCK_BASE + 25 * 60 * 1000), count: 1 })
  })

  it("restores today's count when the tool is reopened", async () => {
    const store = new Map<string, unknown>([['pomodoro.done', { date: dayKey(CLOCK_BASE), count: 3 }]])
    const run = loadPreset('pomodoro', { store })
    await run.flush()
    expect(run.text('count')).toBe('今日完成 3 个番茄')
  })

  it('discards a count from a previous day', async () => {
    const store = new Map<string, unknown>([['pomodoro.done', { date: '2020-01-01', count: 3 }]])
    const run = loadPreset('pomodoro', { store })
    await run.flush()
    expect(run.text('count')).toBe('今日完成 0 个番茄')
  })

  it('reads its storage once at startup, without polling', async () => {
    // The read used to need a retry loop because the host attached its listener
    // after the tool document could already run. mountToolDocument fixes that
    // ordering, so a single read is enough — a timer reappearing here means the
    // race came back somewhere (see the bridge-host tests below).
    const store = new Map<string, unknown>([['pomodoro.done', { date: dayKey(CLOCK_BASE), count: 4 }]])
    const run = loadPreset('pomodoro', { store })
    await run.flush()
    expect(run.getCalls()).toBe(1)
    expect(run.timersScheduled()).toBe(0)
    expect(run.text('count')).toBe('今日完成 4 个番茄')
  })

  it('sizes the digits to fit inside the ring', () => {
    // The clock used to be 88px inside a 240px ring, so "25:00" (~233px) spilled
    // over the 228px inner edge — the overlap the user reported.
    const html = readFileSync(`${PRESETS_DIR}pomodoro/app.html`, 'utf-8')
    const fontSize = Number(html.match(/\.clock \{[^}]*font-size:\s*(\d+)px/)?.[1])
    const radius = Number(html.match(/r="(\d+)"/)?.[1])
    const stroke = Number(html.match(/stroke-width:\s*(\d+)/)?.[1])
    const innerDiameter = 2 * (radius - stroke / 2)
    // 0.62em per tabular digit is a generous upper bound for "MM:SS".
    expect(fontSize * 0.62 * 5).toBeLessThan(innerDiameter)
  })

  it('keeps the ring inside its viewBox', () => {
    const html = readFileSync(`${PRESETS_DIR}pomodoro/app.html`, 'utf-8')
    const radius = Number(html.match(/r="(\d+)"/)?.[1])
    const stroke = Number(html.match(/stroke-width:\s*(\d+)/)?.[1])
    expect(radius + stroke / 2).toBeLessThanOrEqual(120)
  })
})

/** Turn a module matrix into an RGBA bitmap (4-module quiet zone, 4× scale)
 *  and read it back with jsQR — the only trustworthy check of the encoder. */
function decodeMatrix(matrix: boolean[][]): string | undefined {
  const n = matrix.length
  const quiet = 4
  const scale = 4
  const dim = (n + quiet * 2) * scale
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255)
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!matrix[y][x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const i = (((y + quiet) * scale + dy) * dim + (x + quiet) * scale + dx) * 4
          rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
        }
      }
    }
  }
  return jsQR(rgba, dim, dim)?.data
}

describe('preset tool: qrcode', () => {
  it('encodes text that scans back to the original', () => {
    const run = loadPreset('qrcode')
    const matrix = run.qrMatrix('HELLO WORLD', 'M')
    expect(matrix).not.toBeNull()
    expect(matrix!.length).toBe(21) // 11 bytes at M fits version 1
    expect(decodeMatrix(matrix!)).toBe('HELLO WORLD')
  })

  it('keeps multibyte content intact at every error-correction level', () => {
    const run = loadPreset('qrcode')
    const text = 'https://pulsemind.app/二维码 · PulseMind'
    for (const ecl of ['L', 'M', 'Q', 'H']) {
      expect(decodeMatrix(run.qrMatrix(text, ecl)!)).toBe(text)
    }
  })

  it('reaches high versions with the 16-bit length header and stays readable', () => {
    // 600 bytes at M needs version 19 — past the 8-bit count (v1-9) and the
    // version-info blocks (v7+), so this exercises both extra structures.
    const run = loadPreset('qrcode')
    const text = 'A'.repeat(600)
    const matrix = run.qrMatrix(text, 'M')!
    expect(matrix.length).toBeGreaterThanOrEqual(57)
    expect(decodeMatrix(matrix)).toBe(text)
  })

  it('bumps the version at the boundary instead of corrupting the code', () => {
    // 17 bytes tops out version 1 at L; one more byte must spill into version 2.
    const run = loadPreset('qrcode')
    expect(run.qrMatrix('a'.repeat(17), 'L')!.length).toBe(21)
    expect(run.qrMatrix('a'.repeat(18), 'L')!.length).toBe(25)
    // ...and content past version 40's capacity (2953 bytes at L) is refused.
    expect(run.qrMatrix('a'.repeat(2953), 'L')).not.toBeNull()
    expect(run.qrMatrix('a'.repeat(2954), 'L')).toBeNull()
  })

  it('is deterministic for the same input', () => {
    const run = loadPreset('qrcode')
    expect(run.qrMatrix('determinism', 'Q')).toEqual(run.qrMatrix('determinism', 'Q'))
  })

  it('persists and dedupes history through tool storage', async () => {
    const store = new Map<string, unknown>()
    const run = loadPreset('qrcode', { store })
    await run.flush()
    run.invoke('commitHistory', 'first', 'M')
    run.invoke('commitHistory', 'second', 'H')
    run.invoke('commitHistory', 'first', 'L') // same content again: bumped, level updated
    await run.flush()
    const hist = store.get('qrcode.history') as Array<{ text: string; ecl: string }>
    expect(hist.map((it) => it.text)).toEqual(['first', 'second'])
    expect(hist[0].ecl).toBe('L')
  })

  it('caps the history at 8 entries', async () => {
    const store = new Map<string, unknown>()
    const run = loadPreset('qrcode', { store })
    for (let i = 0; i < 12; i++) run.invoke('commitHistory', 'text-' + i, 'M')
    await run.flush()
    const hist = store.get('qrcode.history') as Array<{ text: string }>
    expect(hist.length).toBe(8)
    expect(hist[0].text).toBe('text-11')
  })

  it("restores a previous session's history when reopened", async () => {
    const store = new Map<string, unknown>([['qrcode.history', [{ text: 'kept', ecl: 'M', ts: 1 }]]])
    const run = loadPreset('qrcode', { store })
    await run.flush()
    run.invoke('commitHistory', 'new', 'M')
    await run.flush()
    const hist = store.get('qrcode.history') as Array<{ text: string }>
    expect(hist.map((it) => it.text)).toEqual(['new', 'kept'])
  })
})

// ── The host half of the bridge ──
// The preset tests above hand the tool its own stubbed `window.pulsemind`, so
// none of them can see the ordering that decides whether a startup bridge call
// is answered at all. That ordering is the whole contract of mountToolDocument,
// so it gets pinned here rather than inferred from a preset's behaviour.
describe('tool bridge host: the listener is attached before the document', () => {
  const seen = { attached: 0, order: [] as string[] }
  const savedWindow = (globalThis as { window?: unknown }).window

  // `connectToolBridge` reads the global `window` at both attach and detach, so
  // the stub has to stay installed for the whole block (not just around mount).
  beforeAll(() => {
    ;(globalThis as { window?: unknown }).window = {
      addEventListener(type: string) {
        if (type === 'message') {
          seen.attached++
          seen.order.push('listen')
        }
      },
      removeEventListener(type: string) {
        if (type === 'message') seen.attached--
      },
    }
  })
  afterAll(() => {
    ;(globalThis as { window?: unknown }).window = savedWindow
  })
  beforeEach(() => {
    seen.attached = 0
    seen.order = []
  })

  /** An iframe that records when its document is assigned. */
  function probeIframe(): { iframe: HTMLIFrameElement; doc: () => string } {
    let doc = ''
    const iframe = {
      contentWindow: null,
      get srcdoc() {
        return doc
      },
      set srcdoc(value: string) {
        seen.order.push('srcdoc')
        doc = value
      },
    } as unknown as HTMLIFrameElement
    return { iframe, doc: () => doc }
  }

  it('attaches the listener, then the tool document', () => {
    const { iframe } = probeIframe()
    mountToolDocument(iframe, 'preset_pomodoro', '<html><body><p>x</p></body></html>')
    expect(seen.order).toEqual(['listen', 'srcdoc'])
    expect(seen.attached).toBe(1)
  })

  it('mounts a real preset with the SDK ahead of its own markup', () => {
    const html = readFileSync(`${PRESETS_DIR}pomodoro/app.html`, 'utf-8')
    const { iframe, doc } = probeIframe()
    mountToolDocument(iframe, 'preset_pomodoro', html)
    expect(seen.order).toEqual(['listen', 'srcdoc'])
    // The SDK is inserted first, so `window.pulsemind` exists by the time the
    // tool's own script (which reads storage at the bottom) runs.
    expect(doc().indexOf('pulsemind-tool-host')).toBeGreaterThanOrEqual(0)
    expect(doc().indexOf('pulsemind-tool-host')).toBeLessThan(doc().indexOf('id="clock"'))
  })

  it('detaches the listener it attached', () => {
    const { iframe } = probeIframe()
    const detach = mountToolDocument(iframe, 'preset_pomodoro', '<html></html>')
    expect(seen.attached).toBe(1)
    detach()
    expect(seen.attached).toBe(0)
  })

  it('does not reload an unchanged document, but does reload a changed one', () => {
    // StrictMode double-invokes effects in dev. Re-assigning the same srcdoc
    // would restart the tool — and re-run its startup bridge calls — on every
    // mount, so an unchanged document is left alone.
    const { iframe, doc } = probeIframe()
    const first = '<html><body><p>x</p></body></html>'
    mountToolDocument(iframe, 'preset_pomodoro', first)
    mountToolDocument(iframe, 'preset_pomodoro', first)
    expect(seen.order).toEqual(['listen', 'srcdoc', 'listen'])
    expect(doc()).toContain('<p>x</p>')

    mountToolDocument(iframe, 'preset_pomodoro', '<html><body><p>y</p></body></html>')
    // Each mount brings its own listener (the caller detaches the previous one);
    // only the document assignment is the part that must not repeat.
    expect(seen.order).toEqual(['listen', 'srcdoc', 'listen', 'listen', 'srcdoc'])
    expect(doc()).toContain('<p>y</p>')
  })
})
