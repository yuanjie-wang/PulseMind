// resolveElementSmart (user report 2026-09-18: 「源码中找不到该路径对应的元素」)
// — the picker builds pmPath in the SERVED page's live DOM; the resolver walks
// the DISK text. Content a page script creates or inserts shifts every later
// sibling index, so static elements became unresolvable and uneditable. The
// smart resolver falls back to a unique tag+text match and reports the TRUE
// source path; the in-place editing request (D7 double-click) arbitrates on
// it. Plus wiring scans: the picker may not flip contenteditable on its own.

import { describe, expect, it, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  resolveElementSmart,
  GENERATED_ELEMENT_REASON,
} from '../src/shared/html-edit/resolve'
import { setInlineStyle } from '../src/shared/html-edit/patch'
import { verifyPatch } from '../src/shared/html-edit/patch'
import {
  useHtmlEditStore,
  consumeFailure,
} from '../src/renderer/src/stores/htmlEditStore'

const SHIFT_SRC =
  '<html>\n<body>\n<div id="hero">\n<h1 id="st">Static Title</h1>\n<p>shift page body</p>\n</div>\n<script>inject()</script>\n</body>\n</html>'
// The live tree after the page script ran: the injected div sits BEFORE
// #hero, so the h1's live path carries div:nth-child(2) while the source
// lays it out at div:nth-child(1).
const SHIFT_LIVE_H1 = 'html>body:nth-child(2)>div:nth-child(2)>h1:nth-child(1)'

describe('resolveElementSmart', () => {
  it('resolves a healthy path directly (matchedBy: path)', () => {
    const r = resolveElementSmart(SHIFT_SRC, {
      pmPath: 'html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)',
      tag: 'h1',
      text: 'Static Title',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.matchedBy).toBe('path')
    expect(r.sourcePmPath).toBe('html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)')
  })

  it('rescues a sibling-shifted element by unique tag+text and reports its true source path', () => {
    const r = resolveElementSmart(SHIFT_SRC, { pmPath: SHIFT_LIVE_H1, tag: 'h1', text: 'Static Title' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.matchedBy).toBe('content')
    expect(r.sourcePmPath).toBe('html>body:nth-child(2)>div:nth-child(1)>h1:nth-child(1)')
    expect(r.location.attributes['id']).toBe('st')
  })

  it('the content-matched patch verifies at the SOURCE path, not the live one', () => {
    const r = resolveElementSmart(SHIFT_SRC, { pmPath: SHIFT_LIVE_H1, tag: 'h1', text: 'Static Title' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const patched = setInlineStyle(SHIFT_SRC, r.location, { 'font-size': '28px' })
    expect(patched).toContain('<h1 id="st" style="font-size: 28px">')
    // The live path does not resolve in the disk text — verification must
    // aim at the true source path or every content-matched write would refuse.
    expect(verifyPatch(patched, { pmPath: SHIFT_LIVE_H1, tag: 'h1', styleProps: ['font-size'] }).ok).toBe(false)
    expect(verifyPatch(patched, { pmPath: r.sourcePmPath, tag: 'h1', styleProps: ['font-size'] }).ok).toBe(true)
  })

  it('matches across entity and whitespace differences', () => {
    const src = '<html><body><h1>Hello&nbsp;&amp;&#39;x&#39;</h1></body></html>'
    // textContent of the fixture decodes to `Hello &'x'` (nbsp collapses to a
    // space; no whitespace exists between &amp; and &#39;).
    const r = resolveElementSmart(src, {
      pmPath: 'html>body:nth-child(2)>h1:nth-child(3)',
      tag: 'h1',
      text: 'Hello &\'x\'',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.matchedBy).toBe('content')
    expect(r.location.startTag.start).toBeGreaterThan(0)
  })

  it('refuses with the generated-content reason when the text is not in the source', () => {
    const r = resolveElementSmart(SHIFT_SRC, { pmPath: SHIFT_LIVE_H1, tag: 'h1', text: 'Runtime Title' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe(GENERATED_ELEMENT_REASON)
  })

  it('refuses when the match is ambiguous instead of guessing (D6)', () => {
    const src = '<html><body><ul><li>same</li><li>same</li></ul></body></html>'
    const r = resolveElementSmart(src, {
      pmPath: 'html>body:nth-child(2)>ul:nth-child(1)>li:nth-child(7)',
      tag: 'li',
      text: 'same',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('匹配到 2 处')
  })

  it('rescues a shifted text-less VOID element via the structural fallback (2026-10-10)', () => {
    // Was pinned as a refusal: a void <img> has no endTag and no text, so the
    // content match could never fire and the shifted path read as 「不在文件
    // 源码中」 for an element that IS in the source. The structural fallback
    // locates it — the only same-tag element whose ancestor TAG chain agrees.
    const src = '<html><body><img src="a.png"></body></html>'
    const r = resolveElementSmart(src, { pmPath: 'html>body:nth-child(2)>img:nth-child(4)', tag: 'img', text: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.location.attributes['src']).toBe('a.png')
    expect(r.sourcePmPath).toBe('html>body:nth-child(2)>img:nth-child(1)')
  })

  it('still refuses a text-less selection of a NON-void tag (nothing to match by)', () => {
    const r = resolveElementSmart(SHIFT_SRC, { pmPath: SHIFT_LIVE_H1, tag: 'span', text: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe(GENERATED_ELEMENT_REASON)
  })

  it('a capped (400-char) hint matches its source text by prefix', () => {
    const long = '长'.repeat(600)
    const src = `<html><body><p>${long}</p></body></html>`
    const r = resolveElementSmart(src, {
      pmPath: 'html>body:nth-child(2)>p:nth-child(7)',
      tag: 'p',
      text: long.slice(0, 400),
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.matchedBy).toBe('content')
  })
})

// ── requestInPlaceEdit: the parent arbitrates the double-click (D7) ──

const FILE = '/tmp/w/smart.html'
let disk = SHIFT_SRC

beforeEach(() => {
  disk = SHIFT_SRC
  ;(globalThis as { window?: unknown }).window = {
    electronAPI: {
      writeFile: async (args: { filePath: string; content: string; expectContent?: string }) => {
        if (args.expectContent !== undefined && args.expectContent !== disk) {
          return { success: false, error: 'file changed on disk since it was read' }
        }
        disk = args.content
        return { success: true }
      },
      readFile: async () => disk,
    },
  }
  useHtmlEditStore.getState().forgetFile(FILE)
  useHtmlEditStore.getState().initSession(FILE, SHIFT_SRC)
})

describe('requestInPlaceEdit (the double-click lands here)', () => {
  it('enables editing for a content-matched (shifted) element', async () => {
    useHtmlEditStore.getState().select(FILE, {
      pmPath: SHIFT_LIVE_H1,
      tag: 'h1',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      text: 'Static Title',
      ancestors: [],
      computed: {},
    })
    const ok = await useHtmlEditStore.getState().requestInPlaceEdit(FILE, SHIFT_LIVE_H1)
    expect(ok).toBe(true)
  })

  it('refuses a generated element with the explanatory reason — before the user types', async () => {
    useHtmlEditStore.getState().select(FILE, {
      pmPath: 'html>body:nth-child(2)>p:nth-child(5)',
      tag: 'p',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      text: 'runtime paragraph',
      ancestors: [],
      computed: {},
    })
    const ok = await useHtmlEditStore.getState().requestInPlaceEdit(FILE, 'html>body:nth-child(2)>p:nth-child(5)')
    expect(ok).toBe(false)
    expect(consumeFailure()).toBe(GENERATED_ELEMENT_REASON)
  })

  it('ignores a stale double-click whose pmPath is not the current selection', async () => {
    useHtmlEditStore.getState().select(FILE, {
      pmPath: SHIFT_LIVE_H1,
      tag: 'h1',
      rect: { x: 0, y: 0, w: 10, h: 10 },
      text: 'Static Title',
      ancestors: [],
      computed: {},
    })
    const ok = await useHtmlEditStore.getState().requestInPlaceEdit(FILE, 'html>body:nth-child(2)>p:nth-child(3)')
    expect(ok).toBe(false)
  })
})

// ── Wiring scans (vitest here is node-env: the picker runs in a real frame,
// covered by scripts/probe-html-element-edit.mjs; here we pin the wiring). ──

describe('wiring (source scans)', () => {
  const pickerSrc = readFileSync('src/preview-picker/index.ts', 'utf-8')
  const messagesSrc = readFileSync('src/shared/html-edit/messages.ts', 'utf-8')
  const previewSrc = readFileSync('src/renderer/src/components/preview/HtmlPreview.tsx', 'utf-8')
  const panelSrc = readFileSync('src/renderer/src/components/preview/ElementEditPanel.tsx', 'utf-8')

  it('the picker asks the parent on dblclick instead of editing on its own', () => {
    expect(pickerSrc).toContain("type: 'pm:request-edit'")
    expect(pickerSrc).toContain('isInPlaceEditableCategory')
    // The old self-serve path is gone: nothing in the picker may flip
    // contenteditable outside the parent-approved pm:enable-edit handler.
    expect(pickerSrc.match(/contentEditable = 'true'/g)?.length).toBe(1)
  })

  it('the protocol guard admits pm:request-edit and the preview handles it', () => {
    expect(messagesSrc).toContain("'pm:request-edit'")
    expect(messagesSrc.match(/=== 'pm:request-edit'/g)?.length).toBe(1)
    expect(previewSrc).toContain("case 'pm:request-edit'")
  })

  it('the panel routes 就地编辑 through the store arbitration, not a raw frame message', () => {
    expect(panelSrc).toContain('requestInPlaceEdit')
    expect(panelSrc).not.toContain("type: 'pm:enable-edit'")
  })

  it('the click handler leaves in-place editing alone (mid-edit click is a caret move)', () => {
    // 2026-09-18 「无法直接编辑文字」: without this guard the mid-edit click
    // ran select() → editing = false → the pending commit died in
    // exitEditing's early-return and the typed text never reached the file.
    // The other handlers guard with the combined form; only the click
    // handler carries the standalone one.
    expect(pickerSrc.match(/if \(editing\) return/g)?.length).toBe(1)
  })

  it('the panel keeps both text entries reachable (rich p and pure-text div)', () => {
    // The 文本 field (replace semantics) extends to pure-text containers…
    expect(panelSrc).toMatch(/canReplaceText =[\s\S]*?category === 'container'[\s\S]*?!hasAnyMarkup/)
    // …while 就地编辑 mirrors isInPlaceEditableCategory on disk: the text
    // family always (inline children ride the live-DOM commit), list and
    // container only without element children.
    expect(panelSrc).toContain("(category === 'text' || ((category === 'list' || category === 'container') && !hasElementChildren))")
  })
})

// void 元素结构兜底（2026-10-10）：<img>/<br>/<hr>/<input> 没有 endTag 也没有
// inner text——内容匹配要求 sl.startTag && sl.endTag 且 hint 非空，对 void 元素
// 永远不可能命中；直连路径一旦被脚本位移打断，旧代码就报「该元素不在文件源码
// 中」——对一个明明在源码里的静态 img 是彻头彻尾的谎话。兜底：同标签 +
// pmPath 祖先标签骨架一致 → 唯一候选即定位；多候选给诚实的歧义报错。
describe('void-element structural fallback', () => {
  const SRC =
    '<html>\n<body>\n<div id="gallery">\n<img id="shot" src="a.png">\n</div>\n<script>inject()</script>\n</body>\n</html>'
  // The live tree: the injected div sits BEFORE #gallery, so the img's live
  // path says div:nth-child(2) while the source lays it out at nth-child(1).
  const LIVE_IMG = 'html>body:nth-child(2)>div:nth-child(2)>img:nth-child(1)'

  it('resolves a script-shifted void element by ancestor-tag skeleton', () => {
    const r = resolveElementSmart(SRC, { pmPath: LIVE_IMG, tag: 'img', text: '' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.matchedBy).toBe('content')
    expect(r.location.attributes['id']).toBe('shot')
    expect(r.location.endTag).toBeNull()
    expect(r.sourcePmPath).toBe('html>body:nth-child(2)>div:nth-child(1)>img:nth-child(1)')
  })

  it('refuses honestly when several same-tag candidates share the skeleton', () => {
    const two = SRC.replace('<img id="shot" src="a.png">', '<img id="a" src="a.png"><img id="b" src="b.png">')
    const r = resolveElementSmart(two, { pmPath: LIVE_IMG, tag: 'img', text: '' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain('2 个 <img>')
    expect(r.reason).not.toBe(GENERATED_ELEMENT_REASON)
  })
})
