import { describe, it, expect } from 'vitest'
import { isBridgeRequest, BRIDGE_METHODS } from '../src/shared/tool-bridge/protocol'

describe('tool bridge protocol', () => {
  it('recognizes valid requests', () => {
    expect(isBridgeRequest({ source: 'pulsemind-tool', id: '1', method: BRIDGE_METHODS.storageGet })).toBe(true)
  })
  it('rejects wrong source / missing fields', () => {
    expect(isBridgeRequest({ source: 'other', id: '1', method: 'storage.get' })).toBe(false)
    expect(isBridgeRequest({ source: 'pulsemind-tool', method: 'storage.get' })).toBe(false)
    expect(isBridgeRequest(null)).toBe(false)
    expect(isBridgeRequest('x')).toBe(false)
  })
})
