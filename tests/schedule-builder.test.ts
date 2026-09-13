import { describe, it, expect } from 'vitest'
import { parseCronToConfig, configToCron } from '../src/renderer/src/utils/schedule-builder'

describe('parseCronToConfig', () => {
  it('parses daily schedules', () => {
    expect(parseCronToConfig('30 9 * * *')).toEqual({ kind: 'daily', time: '09:30' })
    expect(parseCronToConfig('0 0 * * *')).toEqual({ kind: 'daily', time: '00:00' })
  })
  it('parses weekday lists and ranges', () => {
    expect(parseCronToConfig('0 9 * * 1-5')).toEqual({ kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '09:00' })
    expect(parseCronToConfig('0 18 * * 0,6')).toEqual({ kind: 'weekly', weekdays: [0, 6], time: '18:00' })
  })
  it('parses monthly and interval patterns', () => {
    expect(parseCronToConfig('0 0 1 * *')).toEqual({ kind: 'monthly', day: 1, time: '00:00' })
    expect(parseCronToConfig('*/30 * * * *')).toEqual({ kind: 'interval', unit: 'minute', every: 30 })
    expect(parseCronToConfig('* * * * *')).toEqual({ kind: 'interval', unit: 'minute', every: 1 })
    expect(parseCronToConfig('0 */3 * * *')).toEqual({ kind: 'interval', unit: 'hour', every: 3 })
    expect(parseCronToConfig('0 * * * *')).toEqual({ kind: 'interval', unit: 'hour', every: 1 })
  })
  it('falls back to custom for expressions the patterns do not cover', () => {
    expect(parseCronToConfig('0 9-17 * * *')).toEqual({ kind: 'custom', cron: '0 9-17 * * *' })
    expect(parseCronToConfig('5 4 * jan *')).toEqual({ kind: 'custom', cron: '5 4 * jan *' })
    expect(parseCronToConfig('99 99 * * *')).toEqual({ kind: 'custom', cron: '99 99 * * *' })
    expect(parseCronToConfig('0 9 * *')).toEqual({ kind: 'custom', cron: '0 9 * *' })
  })
})

describe('configToCron', () => {
  it('emits canonical cron for each structured kind', () => {
    expect(configToCron({ kind: 'daily', time: '09:00' })).toBe('0 9 * * *')
    expect(configToCron({ kind: 'weekly', weekdays: [5, 1, 3], time: '08:30' })).toBe('30 8 * * 1,3,5')
    expect(configToCron({ kind: 'monthly', day: 15, time: '07:05' })).toBe('5 7 15 * *')
    expect(configToCron({ kind: 'interval', unit: 'minute', every: 1 })).toBe('* * * * *')
    expect(configToCron({ kind: 'interval', unit: 'minute', every: 30 })).toBe('*/30 * * * *')
    expect(configToCron({ kind: 'interval', unit: 'hour', every: 1 })).toBe('0 * * * *')
    expect(configToCron({ kind: 'interval', unit: 'hour', every: 6 })).toBe('0 */6 * * *')
    expect(configToCron({ kind: 'custom', cron: '0 12 1 1 *' })).toBe('0 12 1 1 *')
  })

  it('structured configs round-trip through parse', () => {
    const configs = [
      { kind: 'daily', time: '09:30' },
      { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], time: '18:00' },
      { kind: 'weekly', weekdays: [0], time: '10:15' },
      { kind: 'monthly', day: 28, time: '23:59' },
      { kind: 'interval', unit: 'minute', every: 45 },
      { kind: 'interval', unit: 'hour', every: 2 },
    ] as const
    for (const config of configs) {
      expect(parseCronToConfig(configToCron(config))).toEqual(config)
    }
  })
})
