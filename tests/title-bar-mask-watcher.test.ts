// @vitest-environment jsdom
// The DOM half of the caption-button fix (tests/title-bar-mask.test.ts pins the
// blend and the wiring): the watcher is what actually SEES a modal open, and
// none of that is visible from source — an observer that never fires, a
// selector that matches nothing, or a report swallowed by an epsilon all read
// identically in review. Drives the real watcher over a real jsdom body.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  combineMaskAlphas,
  currentMaskAlpha,
  maskAlphaOf,
  startTitleBarMaskWatcher,
} from '../src/renderer/src/utils/title-bar-mask'

/** Let jsdom's mutation-observer microtask (and the timers after it) run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

const report = vi.fn()
const lastAlpha = (): number => report.mock.calls.at(-1)![0]

function mask(alpha: number, className = 'ant-modal-mask'): HTMLElement {
  const el = document.createElement('div')
  el.className = className
  el.style.backgroundColor = `rgba(0, 0, 0, ${alpha})`
  return el
}

const setApi = (api: unknown): void => {
  ;(window as unknown as { electronAPI: unknown }).electronAPI = api
}

// Every watcher started in a test is disposed here, so an assertion failure
// mid-test cannot leak an observer into the next one and pollute `report`.
const stops: Array<() => void> = []
const watch = (): (() => void) => {
  const stop = startTitleBarMaskWatcher(window)
  stops.push(stop)
  return stop
}

beforeEach(() => {
  document.body.innerHTML = ''
  report.mockClear()
  // The watcher reports through the bridge; the probes' stub shape is enough.
  setApi({ setTitleBarMaskAlpha: report })
})

afterEach(() => {
  for (const stop of stops.splice(0)) stop()
  document.body.innerHTML = ''
  setApi(undefined)
})

describe('maskAlphaOf — computed background-color → alpha', () => {
  it('reads the antd default and any black rgba', () => {
    expect(maskAlphaOf('rgba(0, 0, 0, 0.45)')).toBe(0.45)
    expect(maskAlphaOf('rgba(0,0,0,0.85)')).toBe(0.85)
  })

  it('opaque rgb is alpha 1; transparent/none/blank/unparseable are 0', () => {
    expect(maskAlphaOf('rgb(0, 0, 0)')).toBe(1)
    expect(maskAlphaOf('transparent')).toBe(0)
    expect(maskAlphaOf('none')).toBe(0)
    expect(maskAlphaOf('')).toBe(0)
    expect(maskAlphaOf('not a color')).toBe(0)
    expect(maskAlphaOf('hsl(0, 0%, 0%)')).toBe(0)
  })

  it('accepts percentage alphas and clamps above 1', () => {
    expect(maskAlphaOf('rgba(0, 0, 0, 45%)')).toBe(0.45)
    expect(maskAlphaOf('rgba(0, 0, 0, 150%)')).toBe(1)
  })
})

describe('combineMaskAlphas — stacked masks composite multiplicatively', () => {
  it('no masks dim nothing', () => {
    expect(combineMaskAlphas([])).toBe(0)
    expect(combineMaskAlphas([0, 0])).toBe(0)
  })

  it('one mask is its own alpha (within float error)', () => {
    expect(combineMaskAlphas([0.45])).toBeCloseTo(0.45, 12)
  })

  it('modal + drawer at 0.45 each read 1 - 0.55²', () => {
    expect(combineMaskAlphas([0.45, 0.45])).toBeCloseTo(0.6975, 12)
  })

  it('clamps stray values instead of letting them push the product negative', () => {
    expect(combineMaskAlphas([-1, 0.5])).toBeCloseTo(0.5, 12)
    expect(combineMaskAlphas([2])).toBe(1)
  })
})

describe('currentMaskAlpha — what is on screen right now', () => {
  it('finds an antd mask wherever the portal put it', () => {
    document.body.appendChild(mask(0.45))
    expect(currentMaskAlpha()).toBeCloseTo(0.45, 5)
  })

  it('stacks two families', () => {
    document.body.appendChild(mask(0.45))
    document.body.appendChild(mask(0.45, 'ant-drawer-mask'))
    expect(currentMaskAlpha()).toBeCloseTo(0.6975, 5)
  })

  it('picks up a hand-rolled [data-pm-mask] overlay at its own alpha', () => {
    const el = mask(0.85, '')
    el.setAttribute('data-pm-mask', '')
    document.body.appendChild(el)
    expect(currentMaskAlpha()).toBeCloseTo(0.85, 5)
  })

  it('skips a mask that is in the DOM but display:none', () => {
    const hidden = mask(0.45)
    hidden.style.display = 'none'
    document.body.appendChild(hidden)
    expect(currentMaskAlpha()).toBe(0)
  })

  it('a mask whose background is transparent dims nothing (blur-only masks)', () => {
    const el = document.createElement('div')
    el.className = 'ant-modal-mask'
    document.body.appendChild(el)
    expect(currentMaskAlpha()).toBe(0)
  })
})

describe('startTitleBarMaskWatcher — the report', () => {
  it('reports the empty body once at start', () => {
    watch()
    expect(report).toHaveBeenCalledTimes(1)
    expect(report).toHaveBeenCalledWith(0)
  })

  it('a modal opening reports its alpha, closing reports 0', async () => {
    watch()
    document.body.appendChild(mask(0.45))
    await flush()
    expect(lastAlpha()).toBeCloseTo(0.45, 5)

    document.body.lastElementChild!.remove()
    await flush()
    expect(lastAlpha()).toBe(0)
    expect(report).toHaveBeenCalledTimes(3)
  })

  it('reports the combined alpha when a second mask stacks', async () => {
    watch()
    document.body.appendChild(mask(0.45))
    await flush()
    const second = mask(0.85, '')
    second.setAttribute('data-pm-mask', '')
    document.body.appendChild(second)
    await flush()
    expect(lastAlpha()).toBeCloseTo(1 - 0.55 * 0.15, 5)
  })

  it('sees a mask filled into an already-present portal wrapper (antd appends the container first)', async () => {
    watch()
    const wrap = document.createElement('div')
    document.body.appendChild(wrap)
    await flush()
    expect(report).toHaveBeenCalledTimes(1) // empty wrapper is not a mask
    wrap.appendChild(mask(0.45))
    await flush()
    expect(lastAlpha()).toBeCloseTo(0.45, 5)
  })

  it('ignores the chat-streaming churn around it (no report per DOM node)', async () => {
    watch()
    const before = report.mock.calls.length
    for (let i = 0; i < 20; i++) {
      const span = document.createElement('span')
      span.textContent = `chunk ${i}`
      document.body.appendChild(span)
    }
    await flush()
    expect(report.mock.calls.length).toBe(before)
  })

  it('no electronAPI (probes, early boot) does not throw, and a later bridge connects', async () => {
    setApi(undefined)
    watch()
    document.body.appendChild(mask(0.45))
    await flush()
    expect(report).not.toHaveBeenCalled()
    // Reconnect: the next REAL change must go out (lastSent holds 0.449…, so a
    // second 0.45 mask at 0.6975 clears the epsilon).
    setApi({ setTitleBarMaskAlpha: report })
    document.body.appendChild(mask(0.45, 'ant-drawer-mask'))
    await flush()
    expect(lastAlpha()).toBeCloseTo(0.6975, 5)
  })

  it('the disposer silences every later mutation', async () => {
    watch()
    document.body.appendChild(mask(0.45))
    await flush()
    expect(report).toHaveBeenCalledTimes(2)
    for (const stop of stops.splice(0)) stop()
    document.body.appendChild(mask(0.45, 'ant-drawer-mask'))
    await flush()
    expect(report).toHaveBeenCalledTimes(2)
  })
})
