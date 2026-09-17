// ── Member guard: an unknown API member answers with the menu ──
// A typo on the facade used to produce a bare `TypeError: tab.goto is not a
// function` — no menu, no pointer, and the model's next move was to guess again
// (measured: `tab.goto` and `tab.playwright.getByRole` in the same turn, then
// three repeated `browsers.open` calls, conv_20260917151236). The facade's
// objects are the one place in this scheme where the model's own words become
// code, so a wrong member is the cheapest failure to make and the most
// expensive to recover from: it costs a whole turn, and a turn costs a
// conversation's worth of context.
//
// So every façade object is wrapped in a Proxy whose `get` throws a message
// naming what IS there — the menu is derived from the object's own keys at
// throw time, never a hand-written list, so it cannot drift from the object it
// describes (the same reason manifest↔facade consistency is asserted in test).
//
// Two shapes are load-bearing:
// (1) `then` MUST pass through as undefined. `await browsers.open(url)` reads
//     `.then` on the resolved value; a guard that throws there turns every
//     awaited call into "未知成员 tab.then", i.e. it breaks the whole facade
//     while looking like a stricter check. Symbols pass through for the same
//     class of reason (util.inspect, JSON, iterator protocols).
// (2) Unknown only. `constructor`, `toString` and friends resolve through the
//     prototype chain and stay reachable — a guard that hides Object.prototype
//     breaks serialization, logging and equality checks in ways that have
//     nothing to do with the model's typo.

// Two shapes are load-bearing:
// (1) The protocol probes pass through. `await browsers.open(url)` reads `.then`
//     on the resolved value, and `JSON.stringify` — the kernel's own console
//     formatter included — reads `.toJSON`: a guard that throws there turns
//     every awaited call into "未知成员 tab.then" and every logged object into
//     "[object Object]", i.e. it breaks the whole facade while looking like a
//     stricter check. Symbols pass through for the same class of reason
//     (util.inspect, iterator protocols).
// (2) Unknown only. `constructor`, `toString` and friends resolve through the
//     prototype chain and stay reachable — a guard that hides Object.prototype
//     breaks serialization, logging and equality checks in ways that have
//     nothing to do with the model's typo.

/** `.then`/`.toJSON` are protocol probes, not API members — see (1) above. */
const PROTOCOL_PROBES = new Set(['then', 'toJSON'])

/** What a member is, for the menu line: `navigate（方法）`, `tabs（子对象）`. */
function classify(value: unknown): 'method' | 'object' | 'field' {
  if (typeof value === 'function') return 'method'
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return 'object'
  return 'field'
}

/** `navigate / domSnapshot / url（方法），tabs（子对象），id（字段）` — read off
 *  the object itself, so it is the truth even if the object is edited. */
export function memberMenu(target: object): string {
  const groups: Record<'method' | 'object' | 'field', string[]> = { method: [], object: [], field: [] }
  for (const [name, value] of Object.entries(target)) groups[classify(value)].push(name)
  const labels = { method: '方法', object: '子对象', field: '字段' } as const
  return (['method', 'object', 'field'] as const)
    .filter((kind) => groups[kind].length > 0)
    .map((kind) => `${groups[kind].join(' / ')}（${labels[kind]}）`)
    .join('，')
}

const DOCS_POINTER = '完整清单：await agent.documentation()（含各后端差异）'

/** The one message an unknown member produces. */
export function unknownMemberMessage(label: string, member: string, target: object, hint?: string): string {
  const menu = memberMenu(target)
  return `未知成员 ${label}.${member}${menu ? `。${label} 可用：${menu}` : ''}。${hint ? `${hint} ` : ''}${DOCS_POINTER}`
}

function guard<T extends object>(target: T, label: string, hint?: string): T {
  const traps: ProxyHandler<T> = {
    get(t, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(t, prop, receiver)
      if (PROTOCOL_PROBES.has(prop)) return undefined
      if (prop in t) return Reflect.get(t, prop, receiver)
      throw new Error(unknownMemberMessage(label, prop, t, hint))
    },
  }
  if (typeof target === 'function') {
    traps.apply = (t, thisArg, args) => Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args)
  }
  return new Proxy(target, traps)
}

/** Wrap an object graph node: unknown members answer with the menu. `hint` is
 *  for a README-level clarification this object's name tends to attract. */
export function guardMembers<T extends object>(target: T, label: string, hint?: string): T {
  return guard(target, label, hint)
}

/** Same guard for a callable whose members are the confusing part (e.g.
 *  `tab.playwright` — a method, not a locator factory). Calling still works. */
export function guardCallable<F extends (...args: never[]) => unknown>(fn: F, label: string, hint: string): F {
  return guard(fn, label, hint)
}

/** The two same-named surfaces the model conflates: `tab.playwright(N, op)` is
 *  the by-number executor; `agent.playwright.*` builds locators. Spelled out
 *  together because a wrong guess here costs a turn. */
export const PLAYWRIGHT_SURFACE_HINT =
  `（两套同名表面：tab.playwright(3, 'click') 按快照编号执行、tab.playwright(selector, 'fill', '文本') 按选择器执行——都是「执行一个操作」；agent.playwright.getByRole('button', { name }) 是构造定位器，构造出来还是要交给 tab.playwright(locator, op) 执行。）`

export const AGENT_PLAYWRIGHT_HINT = `（这里只构造定位器；要执行操作：await tab.playwright(agent.playwright.getByRole('button', { name: '登录' }), 'click')。按快照编号更直接：await tab.playwright(3, 'click')。）`
