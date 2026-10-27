import { describe, expect, it } from 'vitest'
import zhDict from '../src/renderer/src/i18n/locales/zh'
import enDict from '../src/renderer/src/i18n/locales/en'

/** 记忆页 i18n 钉（PLAN-memory-wiki M7）：memoryPages 块必须是 locale 顶层
 *  命名空间（曾错插进 memoryDrawer 内层，运行时全部裸键）。组件消费的每条
 *  键路径在 zh/en 双语可解析；插值占位符用 {{key}} 双花括号（t() 的实现语法，
 *  index.ts 的 replace 只认双括号）。 */

const get = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, c) => (a == null ? a : (a as Record<string, unknown>)[c]), o)

const KEYS = [
  'memoryPages.browseTitle',
  'memoryPages.browseHelp',
  'memoryPages.all',
  'memoryPages.type.preference',
  'memoryPages.type.decision',
  'memoryPages.type.fact',
  'memoryPages.type.experience',
  'memoryPages.superseded',
  'memoryPages.useCount',
  'memoryPages.searchPlaceholder',
  'memoryPages.searchPlaceholderExperience',
  'memoryPages.empty',
  'memoryPages.emptyExperience',
  'memoryPages.noMatch',
  'memoryPages.aliases',
  'memoryPages.links',
  'memoryPages.scripts',
  'memoryPages.deleted',
  'memoryPages.deleteConfirm',
  'memoryPages.deleteConfirmExperience',
  'memoryPages.lineage',
  'memoryDrawer.title',
  'memoryDrawer.manualMemories',
  'memoryDrawer.manualMemoriesHelp',
  'memoryDrawer.manualMemoriesSaved',
  'memoryDrawer.save',
  'memoryDrawer.loadFailed',
  'memoryDrawer.masterSwitch',
  'memoryDrawer.masterSwitchHelp',
  'memoryDrawer.extractInterval',
  'memoryDrawer.extractIntervalHelp',
  'memoryDrawer.hoursUnit',
  'memoryDrawer.sweepNow',
  'memoryDrawer.sweepDone',
  'memoryDrawer.sweepFailed',
  'knowledgePanel.memoryBase',
]

/** 记忆面板里全部用户可见文案：扁平化 memoryDrawer + memoryPages 两个命名空间。 */
function flatten(o: unknown, prefix = ''): Array<[string, string]> {
  if (typeof o === 'string') return [[prefix, o]]
  if (o && typeof o === 'object') {
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k))
  }
  return []
}

describe('memory pages i18n（顶层命名空间 + 双语键齐 + 插值语法）', () => {
  it('memoryPages 在顶层（不是 memoryDrawer 的子对象）', () => {
    for (const [name, dict] of [['zh', zhDict], ['en', enDict]] as const) {
      expect(get(dict, 'memoryPages'), name).toBeTypeOf('object')
      expect(get(dict, 'memoryDrawer.memoryPages'), name).toBeUndefined()
    }
  })

  it('组件消费的全部键路径双语可解析', () => {
    for (const key of KEYS) {
      expect(get(zhDict, key), `zh:${key}`).toBeTruthy()
      expect(get(enDict, key), `en:${key}`).toBeTruthy()
    }
  })

  it('带插值的文案用 {{key}} 双花括号（t() 只认这个语法）', () => {
    for (const key of ['memoryDrawer.sweepDone', 'memoryPages.useCount']) {
      expect(get(zhDict, key), `zh:${key}`).toContain('{{count}}')
      expect(get(enDict, key), `en:${key}`).toContain('{{count}}')
      expect(get(zhDict, key), `zh:${key}`).not.toMatch(/(?<!\{)\{count\}(?!\})/)  // 无裸单括号残留
    }
  })

  // 2026-10-26 用户指出「定时清扫是…唯一提取时机（用户裁定 2026-10-25）」这种
  // 内部决策记录的话术直接进了设置面板。用户可见文案不得带日期、裁定、计划编号，
  // 也不得把数据模型里的「记忆页」「取代」「注入」「清扫」说给用户听。
  it('用户可见文案不含内部术语与决策记录', () => {
    const banned = /用户裁定|\d{4}-\d{2}-\d{2}|PLAN-|记忆页|取代|注入|清扫|memory page|supersed|inject|sweep/i
    for (const [name, dict] of [['zh', zhDict], ['en', enDict]] as const) {
      const entries = [
        ...flatten(get(dict, 'memoryDrawer'), 'memoryDrawer'),
        ...flatten(get(dict, 'memoryPages'), 'memoryPages'),
      ]
      expect(entries.length).toBeGreaterThan(20)
      for (const [key, text] of entries) {
        expect(text, `${name}:${key} = ${text}`).not.toMatch(banned)
      }
    }
  })
})
