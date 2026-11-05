// ── 一次性模板包导入（2026-11-05）──
// 无密钥 welcome 引导卡的「导入模板包」：zip = 整份 settings.json（团队从配
// 置好的机器拷出）+ 可选 skills/。语义是整份替换（用户裁定），不是字段级合
// 并。这里钉两层：validate/sanitize 纯函数的真行为 + 全链路接线形状（源码
// 扫描，见 AGENTS「单测纪律」——zip 解压/落盘/broadcast 属 IO，进不了纯
// Node 单测，由 handler 的 wiring 断言钉住）。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateTemplateSettings, sanitizeTemplateSettings } from '../src/main/services/template-import'
import type { AppSettings } from '../src/shared/types/settings'

const REPO = process.cwd()
const read = (...p: string[]): string => readFileSync(join(REPO, ...p), 'utf-8')

const baseSettings = (): AppSettings => ({
  activeProfileId: '',
  providers: [
    {
      id: 'prov_x',
      name: '团队网关',
      apiFormat: 'openai',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-real',
      models: [{ id: 'model_x', model: 'glm-5.3', maxTokens: 32768 }]
    }
  ],
  profiles: [],
  theme: 'dark',
  myName: '',
  soul: '',
  yourName: ''
})

describe('validateTemplateSettings', () => {
  it('accepts a well-formed template', () => {
    const r = validateTemplateSettings(baseSettings())
    expect(r.error).toBeUndefined()
    expect(r.settings?.providers).toHaveLength(1)
  })

  it('rejects non-object payloads', () => {
    expect(validateTemplateSettings(null).error).toBeTruthy()
    expect(validateTemplateSettings([1]).error).toBeTruthy()
    expect(validateTemplateSettings('settings').error).toBeTruthy()
  })

  it('rejects a missing/non-array providers', () => {
    expect(validateTemplateSettings({}).error).toContain('providers')
    expect(validateTemplateSettings({ providers: 'x' }).error).toContain('providers')
  })

  it('rejects a provider without name / apiFormat / baseURL', () => {
    const noName = { providers: [{ apiFormat: 'openai', baseURL: 'https://x', models: [] }] }
    expect(validateTemplateSettings(noName).error).toContain('name')
    const badFormat = { providers: [{ name: 'p', apiFormat: 'grpc', baseURL: 'https://x', models: [] }] }
    expect(validateTemplateSettings(badFormat).error).toContain('apiFormat')
    const noUrl = { providers: [{ name: 'p', apiFormat: 'openai', models: [] }] }
    expect(validateTemplateSettings(noUrl).error).toContain('baseURL')
  })

  it('rejects a provider without a models array, and a model without model name', () => {
    const noModels = { providers: [{ name: 'p', apiFormat: 'openai', baseURL: 'https://x' }] }
    expect(validateTemplateSettings(noModels).error).toContain('models')
    const noModelName = { providers: [{ name: 'p', apiFormat: 'openai', baseURL: 'https://x', models: [{ id: 'm' }] }] }
    expect(validateTemplateSettings(noModelName).error).toContain('model')
  })
})

describe('sanitizeTemplateSettings', () => {
  it('keeps ids that are present and mints ids for hand-authored entries missing them', () => {
    const input = baseSettings()
    input.providers[0].models.push({ id: '', model: 'glm-4', maxTokens: 8192 } as never)
    delete (input.providers[0] as { id?: string }).id

    const { settings, warnings } = sanitizeTemplateSettings(input)
    const provider = settings.providers[0]
    expect(provider.id).toMatch(/^prov_\d+_/)
    expect(provider.models[0].id).toBe('model_x')
    expect(provider.models[1].id).toMatch(/^model_\d+_/)
    expect(warnings.some((w) => w.includes('缺 id'))).toBe(true)
  })

  it('warns on enc:v1: ciphertext keys/headers but keeps placeholders silent', () => {
    const input = baseSettings()
    input.providers[0].apiKey = 'enc:v1:AAAA'
    input.providers[0].headers = { 'X-Team': 'enc:v1:BBBB', 'X-Plain': 'raw' }

    const { warnings } = sanitizeTemplateSettings(input)
    expect(warnings.some((w) => w.includes('enc:v1:') && w.includes('密钥'))).toBe(true)
    expect(warnings.some((w) => w.includes('X-Team'))).toBe(true)

    const placeholder = baseSettings()
    placeholder.providers[0].apiKey = '${TEAM_API_KEY}'
    expect(sanitizeTemplateSettings(placeholder).warnings).toEqual([])
  })

  it('passes everything else through verbatim (whole-file replacement semantics)', () => {
    const input = baseSettings()
    input.theme = 'system'
    input.locale = 'en'
    input.soul = '团队灵魂'

    const { settings, warnings } = sanitizeTemplateSettings(input)
    expect(warnings).toEqual([])
    expect(settings.theme).toBe('system')
    expect(settings.locale).toBe('en')
    expect(settings.soul).toBe('团队灵魂')
    expect(settings.providers[0].apiKey).toBe('sk-real')
  })
})

describe('template import wiring', () => {
  it('the IPC channel is declared and registered', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("TEMPLATE_IMPORT: 'template:import'")
    expect(read('src/main/ipc/index.ts')).toContain("registerTemplateHandlers()")
  })

  it('the handler drives dialog + whole-file set + live registration + broadcasts', () => {
    const src = read('src/main/ipc/template.handler.ts')
    expect(src).toContain('dialog.showOpenDialog')
    expect(src).toContain('extensions: [\'zip\']')
    expect(src).toContain('withZipExtraction')
    expect(src).toContain('validateTemplateSettings')
    expect(src).toContain('sanitizeTemplateSettings')
    expect(src).toContain('settingsStore.set(')
    expect(src).toContain('importSkillsFromDirectory')
    expect(src).toContain('registerLiveSkills(')
    expect(src).toContain('IPC_CHANNELS.SETTINGS_CHANGED')
    expect(src).toContain('IPC_CHANNELS.SKILLS_CHANGED')
    // 重名跳过分流进 skipped（幂等重复导入是预期行为，UI 不提示）
    expect(src).toContain('already exists — skipped')
    expect(src).toContain('skipped: dups')
  })

  it('preload and the bridge contract expose importTemplate', () => {
    expect(read('src/shared/types/electron-bridge.ts')).toContain('importTemplate:')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('interface TemplateImportResult')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('skipped: string[]')
    expect(read('src/preload/index.ts')).toContain('importTemplate:')
    expect(read('src/preload/index.ts')).toContain('IPC_CHANNELS.TEMPLATE_IMPORT')
  })

  it('the guide card carries the secondary import button calling the bridge', () => {
    const src = read('src/renderer/src/components/welcome/ApiKeyGuide.tsx')
    expect(src).toContain('data-pm-template-import')
    expect(src).toContain('importTemplate()')
    expect(src).toContain('welcome.importTemplate')
    // 成功后的翻转靠既有广播链，不手动 reload
    expect(src).not.toContain('reloadSettings')
  })

  it('duplicate skips stay silent: skipped feeds no toast, empty-pack warning is the only fallthrough', () => {
    const src = read('src/renderer/src/components/welcome/ApiKeyGuide.tsx')
    // issues 只收 warnings + errors，不含 skipped
    expect(src).toContain('[...warnings, ...skills.errors]')
    expect(src).not.toContain('skills.skipped.join')
    // 全重复（零导入、零 settings、只有 skipped）静默返回；「包空」提示
    // 只在 skipped 也是零时才走
    expect(src).toContain('skills.skipped.length === 0')
    expect(src).toContain('templateImportEmpty')
  })

  it('the renderer skill list refreshes on the skills:changed broadcast', () => {
    const src = read('src/renderer/src/hooks/useChatManagers.ts')
    expect(src).toContain('onSkillsChanged')
    expect(src).toContain('refreshSkillsFromDisk()')
  })

  it('skill-store exposes the directory import route the handler calls', () => {
    const src = read('src/main/storage/skill-store.ts')
    expect(src).toContain('importSkillsFromDirectory')
    expect(src).toContain('importSkillsFromRoot')
  })

  it('the i18n keys exist in both locales', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    for (const key of ['importTemplate', 'templateImportSuccess', 'templateImportSkills', 'templateImportEmpty', 'templateImportFailed']) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
  })
})
