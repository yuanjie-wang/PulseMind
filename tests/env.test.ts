import { afterEach, describe, expect, it } from 'vitest'
import { resolveEnvVarsInString, resolveEnvVarsDeep, findUnresolvedEnvVar } from '../src/shared/env'

afterEach(() => {
  delete process.env.PULSE_TEST_VAR
  delete process.env.PULSE_TEST_OTHER
})

describe('resolveEnvVarsInString', () => {
  it('resolves a set variable', () => {
    process.env.PULSE_TEST_VAR = '1'
    expect(resolveEnvVarsInString('${PULSE_TEST_VAR}')).toBe('1')
  })

  it('resolves placeholders embedded in larger strings (Authorization headers)', () => {
    process.env.PULSE_TEST_VAR = 'sk-test'
    expect(resolveEnvVarsInString('Bearer ${PULSE_TEST_VAR}')).toBe('Bearer sk-test')
  })

  it('keeps the placeholder when keepMissing=true and the variable is unset', () => {
    expect(resolveEnvVarsInString('${PULSE_TEST_VAR}', true)).toBe('${PULSE_TEST_VAR}')
  })

  it('resolves to empty string when keepMissing=false and the variable is unset', () => {
    expect(resolveEnvVarsInString('${PULSE_TEST_VAR}', false)).toBe('')
  })

  it('resolves multiple placeholders and leaves non-placeholder text alone', () => {
    process.env.PULSE_TEST_VAR = 'a'
    process.env.PULSE_TEST_OTHER = 'b'
    expect(resolveEnvVarsInString('x-${PULSE_TEST_VAR}-${PULSE_TEST_OTHER}-y')).toBe('x-a-b-y')
    expect(resolveEnvVarsInString('no placeholders here')).toBe('no placeholders here')
  })
})

describe('findUnresolvedEnvVar', () => {
  it('returns the variable name of the first remaining placeholder', () => {
    expect(findUnresolvedEnvVar('${MISSING_ONE}')).toBe('MISSING_ONE')
    expect(findUnresolvedEnvVar('Bearer ${MISSING_KEY}')).toBe('MISSING_KEY')
  })

  it('returns null for fully resolved strings', () => {
    expect(findUnresolvedEnvVar('Bearer sk-real-key')).toBeNull()
    expect(findUnresolvedEnvVar('')).toBeNull()
  })
})

describe('resolveEnvVarsDeep', () => {
  it('walks nested objects and arrays', () => {
    process.env.PULSE_TEST_VAR = 'v'
    const input = { a: '${PULSE_TEST_VAR}', b: ['${PULSE_TEST_VAR}', 'plain'], c: { d: '${PULSE_TEST_VAR}' } }
    expect(resolveEnvVarsDeep(input)).toEqual({ a: 'v', b: ['v', 'plain'], c: { d: 'v' } })
  })

  it('skipKeys keeps values raw at any depth', () => {
    process.env.PULSE_TEST_VAR = 'v'
    const input = { headers: { auth: '${PULSE_TEST_VAR}' }, apiKey: '${PULSE_TEST_VAR}', other: '${PULSE_TEST_VAR}' }
    expect(resolveEnvVarsDeep(input, { skipKeys: new Set(['headers', 'apiKey']) })).toEqual({
      headers: { auth: '${PULSE_TEST_VAR}' },
      apiKey: '${PULSE_TEST_VAR}',
      other: 'v',
    })
  })

  it('leaves non-string primitives untouched', () => {
    expect(resolveEnvVarsDeep({ n: 5, b: true, z: null })).toEqual({ n: 5, b: true, z: null })
  })
})
