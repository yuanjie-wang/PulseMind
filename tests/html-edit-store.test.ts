// The htmlEditStore write pipeline (PLAN-html-element-edit M3): resolve →
// patch → verify → write → undo record → fileText adopt, plus the structural
// edits (delete / undo / restore / external change). Runs in plain node with
// a stubbed electronAPI — the store itself stays DOM-free.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  useHtmlEditStore,
  consumeFailure,
  MAX_UNDO_STEPS,
} from '../src/renderer/src/stores/htmlEditStore'

const FILE = '/tmp/w/page.html'
const SRC =
  '<html>\n<body>\n<div class="hero">\n<h1 style="color: red" id="t">Hello</h1>\n<p>para</p>\n</div>\n</body>\n</html>'
const H1 = 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)'

const written: { path: string; content: string; expectContent?: string }[] = []
/** Simulated disk content — the stub enforces the same expectContent contract
 *  the main side does (file-ops.ts: refuse when it differs). */
let disk = SRC

beforeEach(() => {
  written.length = 0
  disk = SRC
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      writeFile: async (args: { filePath: string; content: string; expectContent?: string }) => {
        if (args.expectContent !== undefined && args.expectContent !== disk) {
          return { success: false, error: 'file changed on disk since it was read — re-read and retry（文件已被外部修改，请刷新后重试）' }
        }
        disk = args.content
        written.push(args)
        return { success: true }
      },
      readFile: async () => disk,
    },
  }
  useHtmlEditStore.getState().forgetFile(FILE)
  useHtmlEditStore.getState().initSession(FILE, SRC)
  useHtmlEditStore.getState().select(FILE, {
    pmPath: H1,
    tag: 'h1',
    rect: { x: 0, y: 0, w: 10, h: 10 },
    text: 'Hello',
    ancestors: [],
    computed: {},
  })
})

describe('direct edits (apply → write, no reload)', () => {
  it('applyStyle patches the file text, records undo, and adopts the new text', async () => {
    const ok = await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    expect(ok).toBe(true)
    expect(written).toHaveLength(1)
    expect(written[0].content).toContain('<h1 style="color: blue" id="t">')
    const session = useHtmlEditStore.getState().sessions[FILE]
    expect(session.fileText).toBe(written[0].content)
    expect(session.undo).toHaveLength(1)
    expect(session.undo[0].before).toBe(SRC)
    expect(session.undo[0].selectPath).toBe(H1)
  })

  it('applyText escapes the text and verifies the result', async () => {
    const ok = await useHtmlEditStore.getState().applyText(FILE, 'a < b')
    expect(ok).toBe(true)
    expect(written[0].content).toContain('<h1 style="color: red" id="t">a &lt; b</h1>')
  })

  it('a style patch on a missing property of the expectation refuses to write', async () => {
    // Forcing the session's pmPath at a div whose style will not verify.
    useHtmlEditStore.getState().select(FILE, {
      pmPath: 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(9)',
      tag: 'h1',
      rect: { x: 0, y: 0, w: 0, h: 0 },
      text: '',
      ancestors: [],
      computed: {},
    })
    const ok = await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    expect(ok).toBe(false)
    expect(written).toHaveLength(0)
    expect(consumeFailure()).toContain('找不到')
  })

  it('applyAttrs writes href/target attributes', async () => {
    useHtmlEditStore.getState().select(FILE, {
      pmPath: 'html>body:nth-child(2)>div:nth-child(1)>p:nth-child(2)',
      tag: 'p',
      rect: { x: 0, y: 0, w: 0, h: 0 },
      text: 'para',
      ancestors: [],
      computed: {},
    })
    const ok = await useHtmlEditStore.getState().applyAttrs(FILE, { title: 'T' })
    expect(ok).toBe(true)
    expect(written[0].content).toContain('<p title="T">para</p>')
  })
})

describe('structural edits', () => {
  it('deleteElement removes the element, clears the selection, arms the parent reselect', async () => {
    const ok = await useHtmlEditStore.getState().deleteElement(FILE)
    expect(ok).toBe(true)
    expect(written[0].content).not.toContain('<h1')
    const session = useHtmlEditStore.getState().sessions[FILE]
    expect(session.selection).toBeNull()
    expect(session.pendingReselect?.pmPath).toBe('html>body:nth-child(2)>div:nth-child(1)')
    expect(session.undo).toHaveLength(1)
  })

  it('undo writes the previous text back and arms its reselect path', async () => {
    await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    const ok = await useHtmlEditStore.getState().undo(FILE)
    expect(ok).toBe(true)
    const last = written[written.length - 1]
    expect(last.content).toBe(SRC)
    const session = useHtmlEditStore.getState().sessions[FILE]
    expect(session.fileText).toBe(SRC)
    expect(session.undo).toHaveLength(0)
    expect(session.pendingReselect?.pmPath).toBe(H1)
  })

  it('restoreOriginal writes the opening text and empties the stack', async () => {
    await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    await useHtmlEditStore.getState().applyStyle(FILE, { color: 'green' })
    const ok = await useHtmlEditStore.getState().restoreOriginal(FILE)
    expect(ok).toBe(true)
    expect(written[written.length - 1].content).toBe(SRC)
    expect(useHtmlEditStore.getState().sessions[FILE].undo).toHaveLength(0)
  })

  it('handleExternalChange adopts the new text and CLEARS the undo stack (D8)', async () => {
    await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    expect(useHtmlEditStore.getState().sessions[FILE].undo).toHaveLength(1)
    const external = SRC.replace('Hello', 'Hello (edited)')
    useHtmlEditStore.getState().handleExternalChange(FILE, external)
    const session = useHtmlEditStore.getState().sessions[FILE]
    expect(session.fileText).toBe(external)
    expect(session.originalText).toBe(external)
    expect(session.undo).toHaveLength(0)
  })

  // M7 (review 2026-09-18): a stale selection on the NEW text resolves to
  // whatever element now occupies the old pmPath — the next edit would patch
  // the wrong target, so the external change must drop it.
  it('handleExternalChange also clears the selection', async () => {
    expect(useHtmlEditStore.getState().sessions[FILE].selection).not.toBeNull()
    useHtmlEditStore.getState().handleExternalChange(FILE, SRC.replace('Hello', 'Hi'))
    expect(useHtmlEditStore.getState().sessions[FILE].selection).toBeNull()
  })

  // M6 (review 2026-09-18): every element-mode write carries the session's
  // believed disk text; a mismatch refuses the write INSTEAD of clobbering
  // the external edit, adopts the fresh text, and reports through the
  // failure channel.
  it('a write refused for staleness adopts the fresh text and leaves the disk untouched', async () => {
    disk = SRC.replace('Hello', 'Hello (externally edited)')
    const ok = await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    expect(ok).toBe(false)
    expect(written).toHaveLength(0) // nothing clobbered
    const session = useHtmlEditStore.getState().sessions[FILE]
    expect(session.fileText).toBe(disk) // fresh text adopted
    expect(session.undo).toHaveLength(0)
    expect(session.selection).toBeNull()
    expect(consumeFailure()).toContain('外部修改')
  })

  it('the happy-path write still carries expectContent', async () => {
    await useHtmlEditStore.getState().applyStyle(FILE, { color: 'blue' })
    expect(written).toHaveLength(1)
    expect(written[0].expectContent).toBe(SRC)
  })

  it('the undo stack caps at MAX_UNDO_STEPS', async () => {
    for (let i = 0; i < MAX_UNDO_STEPS + 5; i++) {
      await useHtmlEditStore.getState().applyStyle(FILE, { color: `#${i.toString(16).padStart(6, '0')}` })
    }
    expect(useHtmlEditStore.getState().sessions[FILE].undo).toHaveLength(MAX_UNDO_STEPS)
  })
})

describe('in-place commit (D7)', () => {
  it('commitInPlaceText adopts the frame inner HTML for the selected path only', async () => {
    const ok = await useHtmlEditStore
      .getState()
      .commitInPlaceText(FILE, H1, 'Hi <b>bold</b>')
    expect(ok).toBe(true)
    expect(written[0].content).toContain('Hi <b>bold</b>')
  })

  it('refuses inner HTML carrying script nodes', async () => {
    const ok = await useHtmlEditStore.getState().commitInPlaceText(FILE, H1, 'x<script>alert(1)</script>')
    expect(ok).toBe(false)
    expect(written).toHaveLength(0)
  })
})
