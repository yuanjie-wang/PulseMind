import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createBrowserFacade } from '../src/shared/browser-client/facade'
import { effectiveApiText, getDocument, documentationText } from '../src/shared/browser-client/documentation'
import { BROWSER_API_MANIFEST } from '../src/shared/browser-client/manifest'
import { memberSupported } from '../src/shared/browser-client/api-policy'
import type { BackendDescriptor } from '../src/shared/browser-client/protocol'
import type { BrowserCommand, BrowserCommandResult } from '../src/shared/browser-client/protocol'

const read = (p: string): string => readFileSync(new URL('../' + p, import.meta.url), 'utf-8')

const BOTH_BACKENDS: BackendDescriptor[] = [
  { id: 'managed', type: 'managed', capabilities: { browser: ['open', 'tabs', 'fetchRendered'], tab: ['navigate', 'snapshot', 'screenshot', 'playwright', 'evaluate', 'download'] } },
  { id: 'app-view', type: 'app-view', capabilities: { browser: ['open', 'tabs', 'user'], tab: ['navigate', 'snapshot', 'screenshot', 'playwright', 'evaluate', 'recording'] } },
]

/** Facade bound to a tab (listTabs seeds one) that records every command. */
async function tabWithRecorder(sent: BrowserCommand[]) {
  const facade = createBrowserFacade({
    execute: (cmd) => {
      sent.push(cmd)
      if (cmd.method === 'listTabs') return { ok: true, value: [{ id: 't1', url: 'https://sheet.example/' }] }
      if (cmd.method === 'clipboardRead') return { ok: true, value: 'a\tb\n1\t2' }
      return { ok: true }
    },
    emitImage: () => {},
  })
  return facade.agent.browsers.open('https://sheet.example/')
}

describe('real-input primitives — facade wire shapes', () => {
  it('mouse.click sends coordinates and optional modifiers as one command', async () => {
    const sent: BrowserCommand[] = []
    const tab = await tabWithRecorder(sent)
    await tab.mouse.click(172, 203)
    await tab.mouse.click(75, 239, { button: 'right' })
    await tab.mouse.click(10, 20, { clickCount: 2, delayMs: 40 })
    const clicks = sent.filter((c): c is Extract<BrowserCommand, { method: 'mouseClick' }> => c.method === 'mouseClick')
    expect(clicks[0]).toEqual({ method: 'mouseClick', tabId: 't1', x: 172, y: 203 })
    expect(clicks[1]).toEqual({ method: 'mouseClick', tabId: 't1', x: 75, y: 239, button: 'right' })
    expect(clicks[2]).toEqual({ method: 'mouseClick', tabId: 't1', x: 10, y: 20, clickCount: 2, delayMs: 40 })
  })

  it('mouse move/wheel/drag map to their commands', async () => {
    const sent: BrowserCommand[] = []
    const tab = await tabWithRecorder(sent)
    await tab.mouse.move(300, 400)
    await tab.mouse.wheel(0, 240)
    await tab.mouse.drag({ x: 5, y: 6 }, { x: 105, y: 206 }, { steps: 12 })
    expect(sent.slice(-3)).toEqual([
      { method: 'mouseMove', tabId: 't1', x: 300, y: 400 },
      { method: 'mouseWheel', tabId: 't1', deltaX: 0, deltaY: 240 },
      { method: 'mouseDrag', tabId: 't1', fromX: 5, fromY: 6, toX: 105, toY: 206, steps: 12 },
    ])
  })

  it('keyboard press/type carry the key and text verbatim', async () => {
    const sent: BrowserCommand[] = []
    const tab = await tabWithRecorder(sent)
    await tab.keyboard.press('Control+a')
    await tab.keyboard.type('C7')
    await tab.keyboard.type('héllo', { delayMs: 15 })
    expect(sent.slice(-3)).toEqual([
      { method: 'keyboardPress', tabId: 't1', key: 'Control+a' },
      { method: 'keyboardType', tabId: 't1', text: 'C7' },
      { method: 'keyboardType', tabId: 't1', text: 'héllo', delayMs: 15 },
    ])
  })

  it('clipboard.read returns the payload; write sends it as one command', async () => {
    const sent: BrowserCommand[] = []
    const tab = await tabWithRecorder(sent)
    const tsv = await tab.clipboard.read()
    expect(tsv).toBe('a\tb\n1\t2')
    expect(sent.at(-1)).toEqual({ method: 'clipboardRead' })
    await tab.clipboard.write('x\ty\n1\t2')
    expect(sent.at(-1)).toEqual({ method: 'clipboardWrite', text: 'x\ty\n1\t2' })
  })
})

describe('real-input primitives — documentation surface', () => {
  it('the three members are visible on BOTH backends', () => {
    for (const descriptor of BOTH_BACKENDS) {
      for (const member of ['mouse', 'keyboard', 'clipboard']) {
        expect(memberSupported(BROWSER_API_MANIFEST.objects['tab'].members[member]!, descriptor), `${member} on ${descriptor.type}`).toBe(true)
      }
    }
  })

  it('effectiveApiText teaches the canvas lesson (both backends)', () => {
    for (const descriptor of BOTH_BACKENDS) {
      const text = effectiveApiText(descriptor)
      expect(text).toContain('`mouse`')
      expect(text).toContain('`keyboard`')
      expect(text).toContain('`clipboard`')
      expect(text).toContain('canvas')
    }
  })

  it("documentation.get('real-input') carries the read-back loop on both backends", () => {
    for (const descriptor of BOTH_BACKENDS) {
      const body = getDocument('real-input', descriptor)
      expect(body).toBeTruthy()
      expect(body).toContain('clipboard.read()')
      expect(body).toContain('Control+c')
      expect(body).toContain('NEVER guess')
      // the privacy red line is part of the doc, not an afterthought
      expect(body).toContain('audited')
    }
    expect(documentationText(BOTH_BACKENDS[1]!)).toContain('real-input')
  })
})

describe('real-input primitives — service wiring (source scan)', () => {
  // The service imports electron (native ABI) and the storage stack, so vitest
  // cannot instantiate it — the favorites-pane wiring scan is the house pattern.
  const service = read('src/main/browser/BrowserService.ts')

  it('dispatches every real-input command', () => {
    for (const method of ['mouseClick', 'mouseMove', 'mouseWheel', 'mouseDrag', 'keyboardPress', 'keyboardType', 'clipboardRead', 'clipboardWrite']) {
      expect(service, method).toContain(`case '${method}':`)
    }
  })

  it('routes real input through page.mouse/page.keyboard — trusted events for BOTH backends', () => {
    expect(service).toContain('page.mouse.click(')
    expect(service).toContain('page.mouse.wheel(')
    expect(service).toContain('page.keyboard.press(')
    expect(service).toContain('page.keyboard.type(')
    // the drag is a composed down→move→up, not a locator dragTo
    expect(service).toContain('page.mouse.down()')
    expect(service).toContain('page.mouse.up()')
  })

  it('reads the clipboard in the main process (electron clipboard, not the page)', () => {
    expect(service).toContain("import { clipboard, shell")
    expect(service).toContain('clipboard.readText()')
    expect(service).toContain('clipboard.writeText(')
  })

  it('audits clicks/drags/keys and BOTH clipboard directions; hover/wheel stay out', () => {
    for (const method of ['mouseClick', 'mouseDrag', 'keyboardPress', 'keyboardType', 'clipboardRead', 'clipboardWrite']) {
      expect(service).toContain(`'${method}',`)
    }
    const mutating = service.slice(service.indexOf('const MUTATING_METHODS'), service.indexOf('])'))
    expect(mutating).not.toContain('mouseMove')
    expect(mutating).not.toContain('mouseWheel')
  })
})

describe('real-input primitives — manual points at the playbook and the lookup doc', () => {
  it('the browser manual names the lookup doc and the installed skill', () => {
    // 2026-10-26: the browser manual moved from tool-instructions.ts into the
    // `browser` built-in skill — the cross-references moved with it, verbatim.
    const manual = read('src/renderer/src/skills/built-in/browser.ts')
    expect(manual).toContain("agent.documentation.get('real-input')")
    expect(manual).toContain('online-spreadsheet')
    expect(manual).toContain('tab.clipboard')
  })
})
