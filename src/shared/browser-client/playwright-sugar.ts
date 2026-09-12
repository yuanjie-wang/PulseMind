// ── Playwright locator sugar (A-M1) ──
// The client-side sugar is pure syntax: getBy* chains serialize into
// Playwright `internal:*` selector strings; execution happens on the host via
// a single `playwright` command {selector, op} (客户端薄、宿主厚, ZCode §2.3).
// Pure string building — no Playwright import, fully unit-testable.

/** Serializable locator handle: a selector string with sugar chain methods. */
export interface LocatorSugar {
  /** The serialized Playwright internal selector. */
  selector: string
  getByRole: (role: string, options?: { name?: string | RegExp; exact?: boolean; checked?: boolean; disabled?: boolean; level?: number }) => LocatorSugar
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
  // internal:text supports /regex/flags syntax: internal:text="/pattern/i"
  return `/${re.source}/${re.flags}`
}

function toStringLike(text: string | RegExp, exact?: boolean): string {
  if (typeof text === 'string') return exact ? quote(text) : quote(text) // substring is default; exact flag carried on role only
  return regexToText(text)
}

function makeLocator(selector: string): LocatorSugar {
  const chain = (next: string): LocatorSugar => makeLocator(`${selector} >> ${next}`)
  return {
    selector,
    getByRole: (role, options) => {
      const parts: string[] = []
      if (options?.name !== undefined) parts.push(`name=${typeof options.name === 'string' ? quote(options.name) : regexToText(options.name)}`)
      if (options?.exact) parts.push('exact=true')
      if (options?.checked !== undefined) parts.push(`checked=${options.checked}`)
      if (options?.disabled !== undefined) parts.push(`disabled=${options.disabled}`)
      if (options?.level !== undefined) parts.push(`level=${options.level}`)
      return chain(`internal:role=${role}${parts.length ? `[${parts.join('][')}]` : ''}`)
    },
    getByText: (text, options) => {
      // internal:text defaults to case-insensitive substring; the `s` flag = exact.
      const body = typeof text === 'string' ? `"${text}"${options?.exact ? 's' : ''}` : regexToText(text)
      return chain(`internal:text=${body}`)
    },
    getByLabel: (text, options) => chain(`internal:label=${toStringLike(text, options?.exact)}`),
    getByPlaceholder: (text, options) => chain(`internal:placeholder=${toStringLike(text, options?.exact)}`),
    getByTestId: (id) => chain(`internal:testid=${quote(id)}`),
    first: () => chain('nth=0'),
    last: () => chain('nth=-1'),
    nth: (index) => chain(`nth=${index}`),
  }
}

/** Root sugar factories, exposed to the kernel as `agent.playwright`. */
export const playwrightSugar = {
  getByRole: (role: string, options?: Parameters<LocatorSugar['getByRole']>[1]): LocatorSugar =>
    makeLocator(buildRole(role, options)),
  getByText: (text: string | RegExp, options?: { exact?: boolean }): LocatorSugar => {
    // internal:text defaults to case-insensitive substring; the `s` flag = exact.
    const body = typeof text === 'string' ? `"${text}"${options?.exact ? 's' : ''}` : regexToText(text)
    return makeLocator(`internal:text=${body}`)
  },
  getByLabel: (text: string | RegExp, options?: { exact?: boolean }): LocatorSugar =>
    makeLocator(`internal:label=${toStringLike(text, options?.exact)}`),
  getByPlaceholder: (text: string | RegExp, options?: { exact?: boolean }): LocatorSugar =>
    makeLocator(`internal:placeholder=${toStringLike(text, options?.exact)}`),
  getByTestId: (id: string): LocatorSugar => makeLocator(`internal:testid=${quote(id)}`),
  /** Accept a raw CSS/XPath selector as an escape hatch. */
  selector: (raw: string): LocatorSugar => makeLocator(raw),
}

function buildRole(role: string, options?: Parameters<LocatorSugar['getByRole']>[1]): string {
  const parts: string[] = []
  if (options?.name !== undefined) parts.push(`name=${typeof options.name === 'string' ? quote(options.name) : regexToText(options.name)}`)
  if (options?.exact) parts.push('exact=true')
  if (options?.checked !== undefined) parts.push(`checked=${options.checked}`)
  if (options?.disabled !== undefined) parts.push(`disabled=${options.disabled}`)
  if (options?.level !== undefined) parts.push(`level=${options.level}`)
  return `internal:role=${role}${parts.length ? `[${parts.join('][')}]` : ''}`
}

/** Accept either a sugar locator or a raw selector string. */
export function selectorOf(input: LocatorSugar | string): string {
  return typeof input === 'string' ? input : input.selector
}
