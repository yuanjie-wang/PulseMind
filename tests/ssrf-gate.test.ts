// SSRF gate (review 2026-09-25 item 6): both the API proxy's
// validateRequestUrl and the generated-tool http bridge fetch model-supplied
// URLs, so the shared classifier must refuse every private/reserved range —
// and must survive the two wire shapes a URL can arrive in: WHATWG
// normalization (decimal/hex IPv4 → dotted, v4-mapped IPv6 → HEX tail) and
// bracketed IPv6 in `.hostname`.
import { describe, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { isPrivateIP, isPrivateHost } from '../src/main/utils/ssrf'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))

const lookupMock = vi.mocked(lookup)

describe('isPrivateIP — reserved ranges', () => {
  it('refuses RFC1918 + loopback + link-local + CGNAT + benchmark + multicast', () => {
    const privateIPs = [
      '10.0.0.1', '10.255.255.255', // 10/8
      '172.16.0.1', '172.31.255.255', // 172.16/12
      '192.168.1.1', // 192.168/16
      '127.0.0.1', '127.255.255.254', // loopback
      '0.0.0.0', '0.1.2.3', // "this host"
      '100.64.0.1', '100.127.255.255', // CGNAT 100.64/10
      '169.254.169.254', '169.254.0.1', // link-local + cloud metadata
      '192.0.0.1', // IETF protocol assignments
      '198.18.0.1', '198.19.255.255', // benchmarking
      '224.0.0.1', '239.1.1.1', '255.255.255.255', // multicast/reserved/broadcast
      '::1', '::', // v6 loopback / unspecified
      'fc00::1', 'fd12:3456::1', // ULA fc00::/7
      'fe80::1', 'febf::1', // link-local fe80::/10
      'fec0::1', // deprecated site-local
      'ff02::1', // v6 multicast
      '[::1]', '[fd00::1]', // brackets as .hostname carries them
    ]
    for (const ip of privateIPs) expect(isPrivateIP(ip), ip).toBe(true)
  })

  it('allows public unicast', () => {
    const publicIPs = [
      '8.8.8.8', '1.1.1.1', '93.184.216.34',
      '172.15.255.255', '172.32.0.1', // just outside 172.16/12
      '100.63.255.255', '100.128.0.1', // just outside CGNAT
      '169.253.1.1', '169.255.0.1', // just outside link-local
      '192.0.1.1', '198.17.0.1', '198.20.0.1', '223.255.255.255',
      '2001:4860:4860::8888', '2606:4700::1111',
      '[2001:db8::1]',
    ]
    for (const ip of publicIPs) expect(isPrivateIP(ip), ip).toBe(false)
  })

  it('rejects malformed input instead of guessing public', () => {
    for (const bad of ['999.1.1.1', '1.2.3', '1.2.3.4.5', '10.0.0.256', 'not-an-ip', '', '10.0.0', '-1.0.0.1', '10.0.0.a']) {
      expect(isPrivateIP(bad), bad).toBe(false)
    }
  })

  // The bypass a dotted-quad-only guard misses: WHATWG URL renders
  // `[::ffff:127.0.0.1]` as the hex tail `[::ffff:7f00:1]`, which reads as a
  // plain public v6 address unless the embedded v4 is judged on its own.
  it('judges v4-mapped/v4-compatible/NAT64 hex tails by the embedded IPv4', () => {
    const embeddedPrivate = [
      '::ffff:127.0.0.1', '::ffff:7f00:1', '[::ffff:7f00:1]', // v4-mapped, both spellings
      '0:0:0:0:0:ffff:7f00:1', // fully expanded
      '::ffff:10.0.0.1', '::ffff:c0a8:1', '::ffff:a9fe:a9fe', // RFC1918 + metadata behind ffff
      '0:0:0:0:ffff:0:7f00:1', '::ffff:0:7f00:1', // v4-translated ::ffff:0:0:0/96
      '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', // NAT64 to loopback/metadata
      '::7f00:1', '::127.0.0.1', '::c0a8:1', // v4-compatible ::/96
    ]
    for (const ip of embeddedPrivate) expect(isPrivateIP(ip), ip).toBe(true)

    const embeddedPublic = [
      '::ffff:8.8.8.8', '::ffff:808:808', // mapped to public v4 stays public
      '64:ff9b::808:808', // NAT64 to public v4
      '2001:db8::7f00:1', // plain v6 whose LOW bits mimic v4 — NOT a carrier prefix
    ]
    for (const ip of embeddedPublic) expect(isPrivateIP(ip), ip).toBe(false)
  })
})

describe('isPrivateHost — wire shapes and DNS', () => {
  it('classifies literal IPs without touching DNS', async () => {
    lookupMock.mockClear()
    await expect(isPrivateHost('127.0.0.1')).resolves.toBe(true)
    await expect(isPrivateHost('[::1]')).resolves.toBe(true)
    await expect(isPrivateHost('8.8.8.8')).resolves.toBe(false)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  // URL integration — the exact hostname shapes validateRequestUrl sees.
  it('sees through WHATWG normalization of decimal/hex IPv4', async () => {
    lookupMock.mockClear()
    for (const url of ['http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/']) {
      const hostname = new URL(url).hostname
      await expect(isPrivateHost(hostname), url).resolves.toBe(true)
    }
    await expect(isPrivateHost(new URL('http://[::ffff:127.0.0.1]/').hostname)).resolves.toBe(true)
    expect(lookupMock).not.toHaveBeenCalled()
  })

  it('resolves hostnames through DNS and classifies the answer', async () => {
    lookupMock.mockClear()
    lookupMock.mockResolvedValueOnce({ address: '10.1.2.3', family: 4 })
    await expect(isPrivateHost('internal.service')).resolves.toBe(true)
    lookupMock.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 })
    await expect(isPrivateHost('example.com')).resolves.toBe(false)
    expect(lookupMock).toHaveBeenCalledTimes(2)
  })

  it('caches a resolved answer for the TTL window', async () => {
    lookupMock.mockClear()
    lookupMock.mockResolvedValueOnce({ address: '192.168.0.1', family: 4 })
    await expect(isPrivateHost('router.lan')).resolves.toBe(true)
    await expect(isPrivateHost('router.lan')).resolves.toBe(true)
    expect(lookupMock).toHaveBeenCalledTimes(1)
  })

  // DNS failure reads as "not private" so the fetch itself produces the
  // user-visible error — the fetch to a nonexistent name fails either way.
  it('treats DNS failure as not-private', async () => {
    lookupMock.mockClear()
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'))
    await expect(isPrivateHost('does-not-exist.invalid')).resolves.toBe(false)
  })
})
