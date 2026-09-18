import { describe, it, expect } from 'vitest'
import { buildChangeSummary } from '../src/main/services/office-snapshot'

describe('buildChangeSummary', () => {
  it('returns 无变更 for empty results', () => {
    expect(buildChangeSummary([])).toBe('无变更')
  })

  it('groups results by op type', () => {
    const results = [
      { index: 0, op: 'replace_text', ok: true, detail: 'Replaced "foo" with "bar" in paragraph 2' },
      { index: 1, op: 'replace_text', ok: true, detail: 'Replaced "baz" with "qux" in paragraph 5' },
      { index: 2, op: 'insert_paragraph', ok: true, detail: 'Inserted paragraph after index 3' },
    ]
    const summary = buildChangeSummary(results)
    expect(summary).toContain('replace_text (2):')
    expect(summary).toContain('insert_paragraph (1):')
  })

  it('excludes failed ops', () => {
    const results = [
      { index: 0, op: 'replace_text', ok: true, detail: 'Replaced "foo" with "bar"' },
      { index: 1, op: 'set_cell', ok: false, detail: 'Invalid cell address' },
    ]
    const summary = buildChangeSummary(results)
    expect(summary).toContain('replace_text (1):')
    expect(summary).not.toContain('set_cell')
  })
})
