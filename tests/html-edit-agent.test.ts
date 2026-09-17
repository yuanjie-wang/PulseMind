// AI element-edit validation + the agent's output parsing (M4). The strict
// gate is the point of the milestone: an element in, a same-tag element out,
// never a document, never two elements, never re-serialized bytes.

import { describe, expect, it } from 'vitest'
import { validateAiElementMarkup, MAX_AI_ELEMENT_BYTES } from '../src/shared/html-edit/patch'
import { HtmlElementEditAgent } from '../src/renderer/src/agent/one-shot-agent/HtmlElementEditAgent'

describe('validateAiElementMarkup', () => {
  it('accepts exactly one element of the expected tag and returns its exact bytes', () => {
    const result = validateAiElementMarkup('  <h1 style="color: blue">Hi</h1>  \n', 'h1')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.html).toBe('<h1 style="color: blue">Hi</h1>')
  })

  it('rejects a whole document or fenced wrapping (D9)', () => {
    for (const bad of [
      '<!DOCTYPE html><html><body><h1>x</h1></body></html>',
      '<html><h1>x</h1></html>',
      '<body><h1>x</h1></body>',
      '```html\n<h1>x</h1>\n```\n<div>y</div>',
    ]) {
      expect(validateAiElementMarkup(bad, 'h1').ok).toBe(false)
    }
  })

  it('rejects multiple elements and bare text', () => {
    expect(validateAiElementMarkup('<h1>a</h1><h1>b</h1>', 'h1').ok).toBe(false)
    expect(validateAiElementMarkup('just text', 'h1').ok).toBe(false)
    expect(validateAiElementMarkup('', 'h1').ok).toBe(false)
  })

  it('rejects a tag change (h1 in, h2 out is refused)', () => {
    const result = validateAiElementMarkup('<h2>x</h2>', 'h1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('h2')
  })

  // M8 (review 2026-09-18): the direct-edit path refuses script/style; the
  // AI path must not be the weaker sibling — elementHtml rides the LLM
  // input verbatim, so a prompt-injected model reply must not land script
  // in a file the sandboxed preview then executes.
  it('rejects script/style nodes anywhere in the replacement', () => {
    for (const [bad, tag] of [
      ['<h1><script>alert(1)</script></h1>', 'h1'],
      ['<h1 style="x"><SCRIPT src="a.js"></SCRIPT></h1>', 'h1'],
      ['<div><style>body{}</style></div>', 'div'],
      ['<div data-x="<script>">t</div>', 'div'],
    ] as const) {
      const result = validateAiElementMarkup(bad, tag)
      expect(result.ok).toBe(false)
    }
    // properly escaped TEXT mentioning tags is fine
    expect(validateAiElementMarkup('<h1>use &lt;script&gt; wisely</h1>', 'h1').ok).toBe(true)
  })

  it('rejects oversized output', () => {
    const big = `<h1>${'x'.repeat(MAX_AI_ELEMENT_BYTES + 1)}</h1>`
    expect(validateAiElementMarkup(big, 'h1').ok).toBe(false)
  })
})

describe('HtmlElementEditAgent.parseResponse', () => {
  const agent = new HtmlElementEditAgent()

  function parse(raw: string): { html: string | null } {
    return (agent as unknown as { parseResponse: (raw: string) => { html: string | null } }).parseResponse(raw)
  }

  it('extracts {html} from a clean or fenced JSON payload', () => {
    expect(parse('{"html": "<h1>x</h1>"}').html).toBe('<h1>x</h1>')
    expect(parse('```json\n{"html": "<h1>x</h1>"}\n```').html).toBe('<h1>x</h1>')
  })

  it('returns null html for non-JSON chatter', () => {
    expect(parse('我无法修改该元素').html).toBeNull()
    expect(parse('').html).toBeNull()
  })

  it('builds a user message carrying instruction, tag, ancestors and element markup', () => {
    const messages = (
      agent as unknown as {
        buildUserMessages: (input: {
          instruction: string
          tag: string
          elementHtml: string
          ancestors: { tag: string; id: string | null; classes: string[] }[]
        }) => { role: string; content: string }[]
      }
    ).buildUserMessages({
      instruction: '改成蓝色 20px',
      tag: 'h1',
      elementHtml: '<h1>Hi</h1>',
      ancestors: [
        { tag: 'html', id: null, classes: [] },
        { tag: 'body', id: null, classes: [] },
        { tag: 'div', id: 'hero', classes: ['a', 'b'] },
      ],
    })
    expect(messages).toHaveLength(1)
    const payload = JSON.parse(messages[0].content) as Record<string, unknown>
    expect(payload['instruction']).toBe('改成蓝色 20px')
    expect(payload['tag']).toBe('h1')
    expect(payload['elementHtml']).toBe('<h1>Hi</h1>')
    expect(payload['ancestors']).toEqual(['html', 'body', 'div#hero.a.b'])
  })
})
