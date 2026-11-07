// PLAN-extension-handoff M2——cookie 映射纯函数（handoff-cookies.ts）：
// wire 元组清洗、host-only 语义（空 domain 不落 domain 字段）、__Host- 前缀
// 原样透传、CHIPS/partitionKey 如实降级（地板 Chromium 108）、sameSite 枚举
// 映射与未知值丢弃、超帽拒绝。

import { describe, expect, it } from 'vitest'
import { handoffCookieDetails, sanitizeHandoffCookies } from '../src/main/agent/handoff-cookies'

type Tuple = ConstructorParameters<typeof Object>[0] extends never ? never : [string, string, string, string, boolean, boolean, number?, string?]

const tuple = (parts: Tuple): unknown => parts

describe('sanitizeHandoffCookies', () => {
  it('正常元组全字段清洗；path 空串回落 /', () => {
    const out = sanitizeHandoffCookies([
      tuple(['sid', 'abc', '.example.com', '/', true, true, 1_800_000_000, 'lax']),
      tuple(['tok', 'v', '', '', false, false]),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      name: 'sid',
      value: 'abc',
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      expirationDate: 1_800_000_000,
      sameSite: 'lax',
    })
    // 空 domain = host-only；空 path 回落 /
    expect(out[1]).toEqual({ name: 'tok', value: 'v', domain: '', path: '/', secure: false, httpOnly: false })
  })

  it('畸形输入：非数组 → []；短元组/空 name/畸形数字丢弃', () => {
    expect(sanitizeHandoffCookies(undefined)).toEqual([])
    expect(sanitizeHandoffCookies('junk')).toEqual([])
    expect(sanitizeHandoffCookies([[], tuple(['', 'v', '', '/', false, false]), tuple(['ok', 'v', '', '/', false, false]), [1, 2, 3]])).toHaveLength(1)
  })

  it('帽 100 条', () => {
    const many = Array.from({ length: 150 }, (_, i) => tuple([`c${i}`, 'v', '', '/', false, false]))
    expect(sanitizeHandoffCookies(many)).toHaveLength(100)
  })

  it('sameSite：可映射的过，unbounded/未知丢弃；负数/零 expirationDate 丢弃（session cookie 语义）', () => {
    const out = sanitizeHandoffCookies([
      tuple(['a', 'v', '', '/', false, false, undefined, 'unbounded']),
      tuple(['b', 'v', '', '/', false, false, undefined, 'strict']),
      tuple(['c', 'v', '', '/', false, false, -5, 'lax']),
      tuple(['d', 'v', '', '/', false, false, 0, undefined]),
    ])
    expect(out[0].sameSite).toBeUndefined()
    expect(out[1].sameSite).toBe('strict')
    expect(out[2].expirationDate).toBeUndefined()
    expect(out[2].sameSite).toBe('lax')
    expect(out[3].expirationDate).toBeUndefined()
  })
})

describe('handoffCookieDetails', () => {
  it('domain 级 cookie 带 domain；host-only 绝不带（带了就把主机 cookie 改写成域 cookie）', () => {
    const details = handoffCookieDetails('https://example.com/x', sanitizeHandoffCookies([tuple(['sid', 'v', '.example.com', '/', true, false])])[0])
    expect(details.domain).toBe('.example.com')
    const hostOnly = handoffCookieDetails('https://example.com/x', sanitizeHandoffCookies([tuple(['sid', 'v', '', '/', true, false])])[0])
    expect('domain' in hostOnly).toBe(false)
    expect(hostOnly.url).toBe('https://example.com/x')
  })

  it('__Host- 前缀约束原样透传（secure、path=/、无 domain 两端一致）', () => {
    const details = handoffCookieDetails('https://example.com/', sanitizeHandoffCookies([tuple(['__Host-csrf', 'v', '', '/', true, true])])[0])
    expect(details).toMatchObject({ name: '__Host-csrf', secure: true, path: '/', httpOnly: true })
    expect('domain' in details).toBe(false)
  })

  it('session cookie 不落 expirationDate；CHIPS 不携带（partitionKey 无对应元组位——如实降级）', () => {
    const details = handoffCookieDetails('https://example.com/', sanitizeHandoffCookies([tuple(['c', 'v', '', '/', false, false])])[0])
    expect('expirationDate' in details).toBe(false)
    expect('partitionKey' in details).toBe(false)
  })
})
