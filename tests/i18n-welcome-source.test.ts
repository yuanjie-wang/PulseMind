// ── welcome 知识卡片的来源标签必须覆盖 sourceType 全联合 ──
// WelcomeSuggestions 用 t(`welcome.source.${newest.sourceType}`) 动态拼 key，
// 而 t() 缺 key 时原样返回 key 路径（i18n/index.ts 的调试回退）——2026-10-08
// 星标录入修好后用户库里出现了第一条 favorite 条目，它成了最新知识文件，
// 卡片就把 `welcome.source.favorite` 原文画在了 welcome 页（zh/en 都漏了这枚）。
// 这份钉子从 shared 类型的联合定义里解析枚举值（加新 sourceType 而不补
// label 时这里会红），并要求两个 locale 的键集合完全一致。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { t, type TranslationDict } from '../src/renderer/src/i18n'
import zhDict from '../src/renderer/src/i18n/locales/zh'
import enDict from '../src/renderer/src/i18n/locales/en'

const ROOT = join(__dirname, '..')

/** KnowledgeFile['sourceType'] 的联合成员，从类型定义源码解析（运行时没有类型）。 */
function knowledgeSourceTypes(): string[] {
  const src = readFileSync(join(ROOT, 'src/shared/types/knowledge.ts'), 'utf8')
  const decl = src.match(/sourceType\??:\s*([^;\n]+)/)
  expect(decl, 'KnowledgeFile.sourceType declaration moved — update this test').toBeTruthy()
  return [...(decl![1].matchAll(/'([a-z_]+)'/g))].map(m => m[1])
}

describe('welcome.source labels cover every KnowledgeFile sourceType', () => {
  const types = knowledgeSourceTypes()

  it('the type union is non-trivial (the scan really scanned)', () => {
    expect(types).toEqual(expect.arrayContaining(['file', 'url', 'experience', 'favorite']))
  })

  for (const locale of [['zh', zhDict], ['en', enDict]] as const) {
    const [name, dict] = locale
    it(`resolves in ${name} instead of echoing the key`, () => {
      for (const st of types) {
        const rendered = t(dict as TranslationDict, `welcome.source.${st}`)
        expect(rendered, `${name} missed welcome.source.${st} — the welcome card would show the raw key`).not.toBe(`welcome.source.${st}`)
        expect(rendered.trim()).not.toBe('')
      }
    })
  }

  it('zh and en carry the same key set', () => {
    expect(Object.keys(enDict.welcome.source).sort())
      .toEqual(Object.keys(zhDict.welcome.source).sort())
  })
})
