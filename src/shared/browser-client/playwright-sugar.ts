// ── Playwright locator sugar (A-M1) ──
// The client-side sugar is pure syntax: getBy* chains serialize into
// Playwright `internal:*` selector strings; execution happens on the host via
// a single `playwright` command {selector, op} (客户端薄、宿主厚, ZCode §2.3).
// Pure string building — no Playwright import, fully unit-testable. The exact
// engine syntax lives in Playwright's internals, not a public contract, so
// every form here is pinned by tests/browser-selector-smoke.test.ts against a
// live engine: role names take the `s` suffix when exact (bare = substring),
// and placeholder/testid must use the attr/testid engines' bracketed forms.

import { pmRefSelector } from './pm-refs'
import { guardMembers } from './member-guard'

type RoleOptions = { name?: string | RegExp; exact?: boolean; checked?: boolean; disabled?: boolean; level?: number }

/** Serializable locator handle: a selector string with sugar chain methods. */
export interface LocatorSugar {
  /** The serialized Playwright internal selector. */
  selector: string
  getByRole: (role: string, options?: RoleOptions) => LocatorSugar
  getByText: (text: string | RegExp, options?: { exact?: boolean }) => LocatorSugar
  getByLabel: (text: string | RegExp, options?: { exact?: boolean }) => LocatorSugar
  getByPlaceholder: (text: string | RegExp, options?: { exact?: boolean }) => LocatorSugar
  getByTestId: (id: string) => LocatorSugar
  first: () => LocatorSugar
  last: () => LocatorSugar
  nth: (index: number) => LocatorSugar
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function regexToText(re: RegExp): string {
  // internal:text and internal:attr accept /regex/flags values
  return `/${re.source}/${re.flags}`
}

/** One matcher value in engine syntax: a quoted string always carries the
 *  suffix — `s` = whole-string case-sensitive (exact), `i` = case-insensitive
 *  substring (default; a BARE quoted string is whole-string, not substring) —
 *  or a /regex/flags literal (exact does not apply to regexes). */
function textMatcher(text: string | RegExp, exact?: boolean): string {
  if (typeof text === 'string') return `${quote(text)}${exact ? 's' : 'i'}`
  return regexToText(text)
}

function roleSelector(role: string, options?: RoleOptions): string {
  const parts: string[] = []
  if (options?.name !== undefined) parts.push(`name=${textMatcher(options.name, options.exact)}`)
  if (options?.checked !== undefined) parts.push(`checked=${options.checked}`)
  if (options?.disabled !== undefined) parts.push(`disabled=${options.disabled}`)
  if (options?.level !== undefined) parts.push(`level=${options.level}`)
  return `internal:role=${role}${parts.length ? `[${parts.join('][')}]` : ''}`
}

function makeLocator(selector: string): LocatorSugar {
  const chain = (next: string): LocatorSugar => makeLocator(`${selector} >> ${next}`)
  // Guarded: a typo'd chain method (getByNmae) answers with this object's own
  // menu instead of a bare TypeError. A locator DESCRIBES; it never acts.
  return guardMembers(
    {
      selector,
      getByRole: (role, options) => chain(roleSelector(role, options)),
      getByText: (text, options) => chain(`internal:text=${textMatcher(text, options?.exact)}`),
      getByLabel: (text, options) => chain(`internal:label=${textMatcher(text, options?.exact)}`),
      // no dedicated placeholder engine — only the attr engine's bracketed form parses
      getByPlaceholder: (text, options) => chain(`internal:attr=[placeholder=${textMatcher(text, options?.exact)}]`),
      // the testid engine parses an attribute selector, not a bare literal
      getByTestId: (id) => chain(`internal:testid=[data-testid=${quote(id)}]`),
      first: () => chain('nth=0'),
      last: () => chain('nth=-1'),
      nth: (index) => chain(`nth=${index}`),
    },
    'locator',
    `（定位器只是“描述元素”，不执行操作——交给 await tab.playwright(locator, 'click') 执行；按快照编号更直接：await tab.playwright(3, 'click')，编号带帧前缀时原样传入 tab.playwright('f7e74', 'click')。）`,
  )
}

/** Root sugar factories, exposed to the kernel as `agent.playwright`. */
export const playwrightSugar = {
  getByRole: (role: string, options?: RoleOptions): LocatorSugar => makeLocator(roleSelector(role, options)),
  getByText: (text: string | RegExp, options?: { exact?: boolean }): LocatorSugar => makeLocator(`internal:text=${textMatcher(text, options?.exact)}`),
  getByLabel: (text: string | RegExp, options?: { exact?: boolean }): LocatorSugar => makeLocator(`internal:label=${textMatcher(text, options?.exact)}`),
  getByPlaceholder: (text: string | RegExp, options?: { exact?: boolean }): LocatorSugar =>
    makeLocator(`internal:attr=[placeholder=${textMatcher(text, options?.exact)}]`),
  getByTestId: (id: string): LocatorSugar => makeLocator(`internal:testid=[data-testid=${quote(id)}]`),
  /** Snapshot ref: the token printed by THIS tab's latest domSnapshot() — pass
   *  it verbatim, frame prefix and all (`ref('f7e74')`), or the bare number for
   *  an un-prefixed `eN`. The deterministic address — no name transcription
   *  between seeing and acting. */
  ref: (n: number | string): LocatorSugar => makeLocator(pmRefSelector(n)),
  /** Accept a raw CSS/XPath selector as an escape hatch. */
  selector: (raw: string): LocatorSugar => makeLocator(raw),
}

/** Accept either a sugar locator or a raw selector string. */
export function selectorOf(input: LocatorSugar | string): string {
  return typeof input === 'string' ? input : input.selector
}
