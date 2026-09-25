import { describe, it, expect } from 'vitest'
import { planPresetSeeds } from '../src/shared/preset-seeding'

describe('planPresetSeeds', () => {
  it('seeds every bundle preset on a fresh install', () => {
    expect(planPresetSeeds(['calculator', 'pomodoro'], [], [])).toEqual(['calculator', 'pomodoro'])
  })

  it('skips presets already on disk (idempotent seeding)', () => {
    expect(planPresetSeeds(['calculator', 'pomodoro'], ['calculator'], [])).toEqual(['pomodoro'])
  })

  it('never resurrects a deleted preset (D-R2)', () => {
    expect(planPresetSeeds(['calculator', 'pomodoro'], [], ['calculator'])).toEqual(['pomodoro'])
  })

  it('a deleted preset that reappears on disk stays skipped by the deletion record', () => {
    // 目录被手工拷回来了也算已存在；删除记录优先级只在两者都缺席时体现 ——
    // 这里验证记录与存在性独立生效。
    expect(planPresetSeeds(['calculator'], ['calculator'], ['calculator'])).toEqual([])
  })

  it('handles multiple new presets after an app upgrade ships more presets', () => {
    const bundle = ['calculator', 'pomodoro', 'http-client']
    expect(planPresetSeeds(bundle, ['calculator', 'pomodoro'], ['http-client'])).toEqual([])
  })
})
