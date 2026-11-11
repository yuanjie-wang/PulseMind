// ── 一次性模板包导入（2026-11-05）──
// 无密钥 welcome 引导卡的「导入模板包」：zip = 整份 settings.json（团队从配
// 置好的机器拷出）+ 可选 skills/ + 可选 hooks/。语义是整份替换（用户裁定），
// 不是字段级合并。这里钉三层：validate/sanitize 纯函数的真行为、内容定位
// （locateTemplatePack 在真临时目录上跑）、hooks 落盘（importHookFiles 在真
// 临时目录上跑），以及全链路接线形状（源码扫描，见 AGENTS「单测纪律」——
// zip 解压/落盘/broadcast 属 IO，进不了纯 Node 单测，由 handler 的 wiring
// 断言钉住）。
//
// 2026-11-10：五个实测缺陷的回归面
// ① 包装目录（Finder/资源管理器「压缩文件夹」、整份 ~/.pulsemind）里的载荷
//    原来定位不到 → 报「没有找到」，与事实相反；
// ② 旧扁平 profiles[] 模板被整份拒收，而天真地补一个 providers: [] 会在写盘
//    时静默清空配置（providersForDisk 的旧格式判据就是「providers 缺位」）；
// ③ 导入后不跑保存副作用（主题/开机自启/休眠守卫/菜单/保留期清扫）——配置
//    导进来了但要等重启才像样；
// ④ 解压/解析/校验/写盘失败与「没找到」混在 warnings 里，损坏 zip 还逃成
//    裸 IPC rejection（渲染端只剩泛化提示，主日志无痕）；
// ⑤ 包里的 hooks/ 被完全忽略（旧实现只有 settings/skills 两条臂）——团队
//    模板里的 app-start.js / llm-request.js 一个都不落盘；
// ⑥ 包里的 tools/ 同样被完全忽略（工具目录是 ~/.pulsemind/tools/<id>/ 的
//    自包含单元：tool.json + app.html + 资源，模板带上后新机器上工具中心
//    是空的）。运行数据 storage.json 不跟着模板走。

import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { validateTemplateSettings, sanitizeTemplateSettings } from '../src/main/services/template-import'
import { locateTemplatePack } from '../src/main/services/template-pack'
import { importHookFiles } from '../src/main/services/template-hooks'
import { importToolDirs } from '../src/main/services/template-tools'
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
      models: [{ id: 'model_x', model: 'glm-5.3', maxTokens: 32768 }],
    },
  ],
  profiles: [],
  theme: 'dark',
  myName: '',
  soul: '',
  yourName: '',
})

/** 2026-09-25 之前的落盘形态：没有 providers，只有扁平 profiles。 */
const legacySettings = (): Record<string, unknown> => ({
  activeProfileId: 'model_1',
  profiles: [
    {
      id: 'model_1',
      name: '团队模型',
      provider: 'openai',
      baseURL: 'https://gw.example.com/v1',
      apiKey: 'sk-legacy',
      model: 'glm-5.3',
      maxTokens: 8192,
    },
  ],
  theme: 'dark',
  locale: 'zh',
})

// ── 真临时目录：locateTemplatePack 是纯 IO 定位，直接跑真文件系统 ──
const tmpRoots: string[] = []
function packDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-template-pack-'))
  tmpRoots.push(dir)
  return dir
}
function touchFile(dir: string, rel: string, body = '{}'): void {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}
afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true })
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

  it('rejects a payload with neither providers nor profiles', () => {
    expect(validateTemplateSettings({}).error).toContain('providers')
    expect(validateTemplateSettings({ providers: 'x' }).error).toContain('providers')
    // profiles 也不是数组时，同样是「两种形态都不认」
    expect(validateTemplateSettings({ profiles: 'x' }).error).toContain('profiles')
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

  it('accepts the legacy flat profiles format whole-object (theme/locale ride along)', () => {
    // 旧机器的整份配置也是模板：只认 providers 会让它整包导不进来，而跨机器
    // 搬运配置正是这个入口存在的理由。
    const r = validateTemplateSettings(legacySettings())
    expect(r.error).toBeUndefined()
    expect((r.settings as unknown as { profiles: unknown[] }).profiles).toHaveLength(1)
    expect(r.settings?.theme).toBe('dark')
    expect(r.settings?.locale).toBe('zh')
  })

  it('legacy gate: provider (apiFormat) is optional, but an explicit bad value is rejected', () => {
    const noProvider = legacySettings()
    delete (noProvider.profiles as Record<string, unknown>[])[0].provider
    expect(validateTemplateSettings(noProvider).error).toBeUndefined()

    const badProvider = legacySettings()
    ;(badProvider.profiles as Record<string, unknown>[])[0].provider = 'grpc'
    expect(validateTemplateSettings(badProvider).error).toContain('provider')
  })

  it('legacy gate: baseURL and model are required, non-object entries rejected', () => {
    const noUrl = legacySettings()
    delete (noUrl.profiles as Record<string, unknown>[])[0].baseURL
    expect(validateTemplateSettings(noUrl).error).toContain('baseURL')

    const noModel = legacySettings()
    delete (noModel.profiles as Record<string, unknown>[])[0].model
    expect(validateTemplateSettings(noModel).error).toContain('model')

    expect(validateTemplateSettings({ profiles: [1] }).error).toContain('profiles[0]')
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

  it('legacy: mints missing profile ids without inventing a providers array', () => {
    // 承重断言是 hasOwnProperty：一旦这里补出 providers（哪怕是 []），
    // providersForDisk 就会走新格式分支 normalizeProviders([])，整份旧配置
    // 在写盘时被静默清空。缺 id 只是顺带修的。
    const input = legacySettings()
    delete (input.profiles as Record<string, unknown>[])[0].id

    const { settings, warnings } = sanitizeTemplateSettings(input as unknown as AppSettings)
    const profiles = (settings as unknown as { profiles: { id: string; model: string }[] }).profiles
    expect(profiles[0].id).toMatch(/^model_\d+_/)
    expect(warnings.some((w) => w.includes('缺 id') && w.includes('glm-5.3'))).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(settings, 'providers')).toBe(false)
    expect((settings as { providers?: unknown }).providers).toBeUndefined()
    // 其它字段原样
    expect(settings.theme).toBe('dark')
    expect((settings as unknown as { profiles: unknown[] }).profiles).toHaveLength(1)
  })

  it('legacy: keeps present ids and warns about local ciphertext with the model label', () => {
    const input = legacySettings()
    ;(input.profiles as Record<string, unknown>[])[0].apiKey = 'enc:v1:CCCC'

    const { settings, warnings } = sanitizeTemplateSettings(input as unknown as AppSettings)
    const profiles = (settings as unknown as { profiles: { id: string }[] }).profiles
    expect(profiles[0].id).toBe('model_1')
    expect(warnings.some((w) => w.includes('模型 "团队模型"') && w.includes('enc:v1:'))).toBe(true)
    expect(warnings.some((w) => w.includes('缺 id'))).toBe(false)
  })
})

describe('locateTemplatePack', () => {
  it('finds settings.json and skills/ at the zip root', async () => {
    const root = packDir()
    touchFile(root, 'settings.json')
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
    touchFile(root, 'skills/demo/SKILL.md', '# demo')

    const found = await locateTemplatePack(root)
    expect(found.settingsPath).toBe(join(root, 'settings.json'))
    expect(found.skillsDir).toBe(join(root, 'skills'))
  })

  it('finds them inside a wrapper folder (Finder/Explorer "compress folder")', async () => {
    const root = packDir()
    touchFile(root, '团队配置/settings.json')
    mkdirSync(join(root, '团队配置', 'skills'), { recursive: true })

    const found = await locateTemplatePack(root)
    expect(found.settingsPath).toBe(join(root, '团队配置', 'settings.json'))
    expect(found.skillsDir).toBe(join(root, '团队配置', 'skills'))
  })

  it('accepts a hidden wrapper such as .pulsemind/', async () => {
    const root = packDir()
    touchFile(root, '.pulsemind/settings.json')

    expect((await locateTemplatePack(root)).settingsPath).toBe(join(root, '.pulsemind', 'settings.json'))
  })

  it('locates the two payloads independently (settings at root, skills nested)', async () => {
    const root = packDir()
    touchFile(root, 'settings.json')
    mkdirSync(join(root, 'pack', 'skills'), { recursive: true })

    const found = await locateTemplatePack(root)
    expect(found.settingsPath).toBe(join(root, 'settings.json'))
    expect(found.skillsDir).toBe(join(root, 'pack', 'skills'))
  })

  it('prefers the shallower settings.json when both exist', async () => {
    const root = packDir()
    touchFile(root, 'settings.json', '{"root":true}')
    touchFile(root, 'pack/settings.json', '{"nested":true}')

    expect((await locateTemplatePack(root)).settingsPath).toBe(join(root, 'settings.json'))
  })

  it('skips __MACOSX and node_modules', async () => {
    const root = packDir()
    touchFile(root, '__MACOSX/settings.json')
    mkdirSync(join(root, '__MACOSX', 'skills'), { recursive: true })
    touchFile(root, 'node_modules/settings.json')

    const found = await locateTemplatePack(root)
    expect(found.settingsPath).toBeUndefined()
    expect(found.skillsDir).toBeUndefined()
  })

  it('stops at the depth limit (3 wrappers deep is the last level scanned)', async () => {
    const shallow = packDir()
    touchFile(shallow, 'a/b/c/settings.json')
    expect((await locateTemplatePack(shallow)).settingsPath).toBe(join(shallow, 'a', 'b', 'c', 'settings.json'))

    const deep = packDir()
    touchFile(deep, 'a/b/c/d/settings.json')
    expect((await locateTemplatePack(deep)).settingsPath).toBeUndefined()
  })

  it('does not descend into the located skills dir (a stray settings.json there is noise)', async () => {
    const root = packDir()
    mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
    touchFile(root, 'skills/settings.json')

    const found = await locateTemplatePack(root)
    expect(found.skillsDir).toBe(join(root, 'skills'))
    expect(found.settingsPath).toBeUndefined()
  })

  it('finds hooks/ at the root and inside a wrapper folder', async () => {
    const root = packDir()
    mkdirSync(join(root, 'hooks'), { recursive: true })
    touchFile(root, 'hooks/app-start.js', 'module.exports = async () => ({ env: {} })')

    expect((await locateTemplatePack(root)).hooksDir).toBe(join(root, 'hooks'))

    const wrapped = packDir()
    mkdirSync(join(wrapped, '团队配置', 'hooks'), { recursive: true })
    expect((await locateTemplatePack(wrapped)).hooksDir).toBe(join(wrapped, '团队配置', 'hooks'))
  })

  it('locates hooks/ independently of the other two payloads', async () => {
    const root = packDir()
    touchFile(root, 'settings.json')
    mkdirSync(join(root, 'pack', 'skills'), { recursive: true })
    mkdirSync(join(root, 'pack', 'hooks'), { recursive: true })

    const found = await locateTemplatePack(root)
    expect(found.settingsPath).toBe(join(root, 'settings.json'))
    expect(found.skillsDir).toBe(join(root, 'pack', 'skills'))
    expect(found.hooksDir).toBe(join(root, 'pack', 'hooks'))
  })

  it('does not descend into the located hooks dir', async () => {
    const root = packDir()
    mkdirSync(join(root, 'hooks', 'lib'), { recursive: true })
    touchFile(root, 'hooks/settings.json')

    const found = await locateTemplatePack(root)
    expect(found.hooksDir).toBe(join(root, 'hooks'))
    expect(found.settingsPath).toBeUndefined()
  })

  it('finds tools/ at the root and inside a wrapper folder', async () => {
    const root = packDir()
    mkdirSync(join(root, 'tools', 'tool_a'), { recursive: true })

    expect((await locateTemplatePack(root)).toolsDir).toBe(join(root, 'tools'))

    const wrapped = packDir()
    mkdirSync(join(wrapped, '.pulsemind', 'tools', 'tool_a'), { recursive: true })
    expect((await locateTemplatePack(wrapped)).toolsDir).toBe(join(wrapped, '.pulsemind', 'tools'))
  })

  it('does not descend into the located tools dir (a tool.json inside is not settings.json)', async () => {
    const root = packDir()
    mkdirSync(join(root, 'tools', 'tool_a'), { recursive: true })
    touchFile(root, 'tools/settings.json')

    const found = await locateTemplatePack(root)
    expect(found.toolsDir).toBe(join(root, 'tools'))
    expect(found.settingsPath).toBeUndefined()
  })

  it('does not treat a directory named settings.json as the file', async () => {
    const root = packDir()
    mkdirSync(join(root, 'settings.json'), { recursive: true })

    expect((await locateTemplatePack(root)).settingsPath).toBeUndefined()
  })

  it('returns an empty result for a pack with neither payload', async () => {
    const root = packDir()
    touchFile(root, 'readme.txt', 'nothing here')

    expect(await locateTemplatePack(root)).toEqual({})
  })
})

describe('importHookFiles', () => {
  const STAMP = new Date(2026, 10, 10) // 20261110

  it('copies every regular file (nested helpers included) into an empty target', async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, 'app-start.js', 'module.exports = async () => ({ env: { A: "1" } })')
    touchFile(src, 'llm-request.js', 'module.exports = async (ctx) => ctx')
    touchFile(src, 'lib/util.js', 'module.exports = 1')

    const result = await importHookFiles(src, dest, STAMP)
    expect(result.imported.sort()).toEqual(['app-start.js', 'lib/util.js', 'llm-request.js'])
    expect(result.replaced).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.errors).toEqual([])
    expect(readFileSync(join(dest, 'app-start.js'), 'utf-8')).toContain('env')
    expect(readFileSync(join(dest, 'lib/util.js'), 'utf-8')).toBe('module.exports = 1')
  })

  it('skips byte-identical files silently (idempotent re-import, no backup)', async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, 'app-start.js', 'same bytes')
    touchFile(dest, 'app-start.js', 'same bytes')

    const result = await importHookFiles(src, dest, STAMP)
    expect(result.unchanged).toEqual(['app-start.js'])
    expect(result.imported).toEqual([])
    expect(result.replaced).toEqual([])
    expect(readdirSync(dest)).toEqual(['app-start.js'])
  })

  it('backs up a differing file before replacing it, and never deletes target-only files', async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, 'app-start.js', 'new login flow')
    touchFile(dest, 'app-start.js', 'hand-deployed login flow')
    touchFile(dest, 'custom.js', 'target only')

    const result = await importHookFiles(src, dest, STAMP)
    expect(result.replaced).toEqual(['app-start.js'])
    expect(readFileSync(join(dest, 'app-start.js'), 'utf-8')).toBe('new login flow')
    expect(readFileSync(join(dest, 'app-start.js.20261110.bak'), 'utf-8')).toBe('hand-deployed login flow')
    expect(readFileSync(join(dest, 'custom.js'), 'utf-8')).toBe('target only')
  })

  it("keeps the day's first backup when the same file is imported twice", async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, 'app-start.js', 'v2')
    touchFile(dest, 'app-start.js', 'v1')
    // 当日首份备份（更早一次导入留下的可恢复状态）
    touchFile(dest, 'app-start.js.20261110.bak', 'original')

    const result = await importHookFiles(src, dest, STAMP)
    expect(result.replaced).toEqual(['app-start.js'])
    expect(readFileSync(join(dest, 'app-start.js.20261110.bak'), 'utf-8')).toBe('original')
  })

  it('never imports the provenance manifest or existing .bak files', async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, '.seed-hashes.json', '{"app-start.js":"deadbeef"}')
    touchFile(src, 'app-start.js.20260101.bak', 'old backup')
    touchFile(src, 'app-start.js', 'live')

    const result = await importHookFiles(src, dest, STAMP)
    expect(result.imported).toEqual(['app-start.js'])
    expect(existsSync(join(dest, '.seed-hashes.json'))).toBe(false)
    expect(existsSync(join(dest, 'app-start.js.20260101.bak'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not follow symlinks out of the pack', async () => {
    const src = packDir()
    const dest = packDir()
    const outside = packDir()
    touchFile(outside, 'secret.js', 'outside')
    symlinkSync(join(outside, 'secret.js'), join(src, 'linked.js'))

    const result = await importHookFiles(src, dest, STAMP)
    expect(result.imported).toEqual([])
    expect(existsSync(join(dest, 'linked.js'))).toBe(false)
  })
})

describe('importToolDirs', () => {
  const STAMP = new Date(2026, 10, 10) // 20261110

  /** Write a well-formed tool dir (manifest + entry page) plus extra files. */
  function seedTool(base: string, id: string, extra: Record<string, string> = {}): void {
    const manifest = {
      id,
      name: id,
      description: '',
      htmlPath: 'app.html',
      capabilities: [],
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }
    touchFile(base, `${id}/tool.json`, JSON.stringify(manifest, null, 2))
    touchFile(base, `${id}/app.html`, `<html>${id}</html>`)
    for (const [rel, body] of Object.entries(extra)) touchFile(base, `${id}/${rel}`, body)
  }

  it('imports a whole tool directory (manifest + entry page + nested assets)', async () => {
    const src = packDir()
    const dest = packDir()
    seedTool(src, 'tool_a', { 'lib/util.js': 'module.exports = 1' })

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.imported).toEqual(['tool_a'])
    expect(result.replaced).toEqual([])
    expect(result.unchanged).toEqual([])
    expect(result.errors).toEqual([])
    expect(readFileSync(join(dest, 'tool_a', 'app.html'), 'utf-8')).toContain('tool_a')
    expect(readFileSync(join(dest, 'tool_a', 'lib/util.js'), 'utf-8')).toBe('module.exports = 1')
    // 清单原样落盘（id 与目录名一致，list() 才认得出这个工具）
    expect(JSON.parse(readFileSync(join(dest, 'tool_a', 'tool.json'), 'utf-8')).id).toBe('tool_a')
  })

  it('skips byte-identical tools silently (idempotent re-import, no backup)', async () => {
    const src = packDir()
    const dest = packDir()
    seedTool(src, 'tool_a')
    seedTool(dest, 'tool_a')

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.unchanged).toEqual(['tool_a'])
    expect(result.imported).toEqual([])
    expect(result.replaced).toEqual([])
    expect(readdirSync(dest)).toEqual(['tool_a'])
  })

  it('backs up the whole tool dir before replacing, keeps target-only files and run data', async () => {
    const src = packDir()
    const dest = packDir()
    seedTool(src, 'tool_a')
    seedTool(dest, 'tool_a')
    // 盘上被用户改过 + 只属于本机的文件
    touchFile(dest, 'tool_a/app.html', '<html>hand edited</html>')
    touchFile(dest, 'tool_a/notes.txt', 'target only')
    touchFile(dest, 'tool_a/storage.json', '{"k":"v"}')

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.replaced).toEqual(['tool_a'])
    // 备份是整目录：旧页面与旧清单都在一起（恢复点）
    expect(readFileSync(join(dest, 'tool_a.20261110.bak', 'app.html'), 'utf-8')).toBe('<html>hand edited</html>')
    expect(existsSync(join(dest, 'tool_a.20261110.bak', 'tool.json'))).toBe(true)
    // 覆盖后：包里的页面生效，包外文件与运行数据都不动
    expect(readFileSync(join(dest, 'tool_a', 'app.html'), 'utf-8')).toBe('<html>tool_a</html>')
    expect(readFileSync(join(dest, 'tool_a', 'notes.txt'), 'utf-8')).toBe('target only')
    expect(readFileSync(join(dest, 'tool_a', 'storage.json'), 'utf-8')).toBe('{"k":"v"}')
  })

  it("keeps the day's first backup when the same tool is imported twice", async () => {
    const src = packDir()
    const dest = packDir()
    seedTool(src, 'tool_a')
    seedTool(dest, 'tool_a')
    touchFile(dest, 'tool_a/app.html', '<html>v2</html>')
    touchFile(dest, 'tool_a.20261110.bak/app.html', '<html>original</html>')

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.replaced).toEqual(['tool_a'])
    expect(readFileSync(join(dest, 'tool_a.20261110.bak', 'app.html'), 'utf-8')).toBe('<html>original</html>')
  })

  it('never imports run data, presets, the legacy templates dir, hidden entries or .bak dirs', async () => {
    const src = packDir()
    const dest = packDir()
    seedTool(src, 'tool_a', { 'storage.json': '{"run":"data"}' })
    seedTool(src, 'preset_demo')
    seedTool(src, 'presets/calculator')
    seedTool(src, 'templates/legacy')
    seedTool(src, '.hidden')
    seedTool(src, 'tool_b.20260101.bak')

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.imported).toEqual(['tool_a'])
    expect(result.errors).toEqual([])
    expect(readdirSync(dest).sort()).toEqual(['tool_a'])
    // 运行数据不跟着模板走（与 duplicate() 同一条规矩）
    expect(existsSync(join(dest, 'tool_a', 'storage.json'))).toBe(false)
  })

  it('rejects a manifest whose id does not match its directory (and leaves no partial dir)', async () => {
    const src = packDir()
    const dest = packDir()
    seedTool(src, 'tool_a')
    touchFile(src, 'tool_a/tool.json', JSON.stringify({ id: 'tool_b', htmlPath: 'app.html' }))

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.imported).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('tool_a')
    expect(result.errors[0]).toContain('不一致')
    expect(existsSync(join(dest, 'tool_a'))).toBe(false)
  })

  it('rejects a missing tool.json and a missing entry page', async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, 'no_manifest/app.html', '<html></html>')
    touchFile(src, 'no_html/tool.json', JSON.stringify({ id: 'no_html', htmlPath: 'app.html' }))

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.imported).toEqual([])
    expect(result.errors.join('\n')).toContain('no_manifest')
    expect(result.errors.join('\n')).toContain('no_html')
    expect(readdirSync(dest)).toEqual([])
  })

  it('rejects an htmlPath that escapes the tool directory', async () => {
    const src = packDir()
    const dest = packDir()
    touchFile(src, 'tool_a/tool.json', JSON.stringify({ id: 'tool_a', htmlPath: '../outside.html' }))
    touchFile(src, 'outside.html', '<html></html>')

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.imported).toEqual([])
    expect(result.errors[0]).toContain('越出工具目录')
    expect(existsSync(join(dest, 'tool_a'))).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('does not follow symlinks out of the pack', async () => {
    const src = packDir()
    const dest = packDir()
    const outside = packDir()
    seedTool(src, 'tool_a')
    touchFile(outside, 'secret.txt', 'outside')
    symlinkSync(join(outside, 'secret.txt'), join(src, 'tool_a', 'linked.txt'))

    const result = await importToolDirs(src, dest, STAMP)
    expect(result.imported).toEqual(['tool_a'])
    expect(existsSync(join(dest, 'tool_a', 'linked.txt'))).toBe(false)
  })
})

describe('template import wiring', () => {
  it('the IPC channel is declared and registered', () => {
    expect(read('src/shared/ipc-channels.ts')).toContain("TEMPLATE_IMPORT: 'template:import'")
    expect(read('src/main/ipc/index.ts')).toContain('registerTemplateHandlers()')
  })

  it('the handler drives dialog + locate + whole-file set + live registration', () => {
    const src = read('src/main/ipc/template.handler.ts')
    expect(src).toContain('dialog.showOpenDialog')
    expect(src).toContain("extensions: ['zip']")
    expect(src).toContain('withZipExtraction')
    // 载荷定位是独立一层（包装目录/隐藏目录/深浅不同的两目标）
    expect(src).toContain('locateTemplatePack(extractDir)')
    expect(src).toContain('located.settingsPath')
    expect(src).toContain('located.skillsDir')
    expect(src).toContain('located.hooksDir')
    expect(src).toContain('importHookFiles(located.hooksDir, HOOKS_DIR)')
    // tools 臂：目录级落盘（tools/<id>/ 整份），与 hooks 同一个「定位了才做」形状
    expect(src).toContain('located.toolsDir')
    expect(src).toContain('importToolDirs(located.toolsDir, TOOLS_DIR)')
    expect(src).toContain('result.tools = toolsResult')
    expect(src).toContain('result.tools.errors.push(')
    expect(src).toContain('validateTemplateSettings')
    expect(src).toContain('sanitizeTemplateSettings')
    expect(src).toContain('settingsStore.set(')
    expect(src).toContain('importSkillsFromDirectory')
    expect(src).toContain('registerLiveSkills(')
    expect(src).toContain('IPC_CHANNELS.SKILLS_CHANGED')
    // 重名跳过分流进 skipped（幂等重复导入是预期行为，UI 不提示）
    expect(src).toContain('already exists — skipped')
    expect(src).toContain('skipped: dups')
    // 技能导入只有「没有 skills/」是静默的：定位结果判定，真实故障进 errors
    expect(src).not.toContain('let hasSkills = false')
    expect(src).toContain('result.skills.errors.push(')
    // hooks 臂：落盘 + 逐文件故障进 errors + 有实际变化时当前进程就地重跑
    // app-start（不再提示「下次启动生效」——导入即触发，不重启应用）
    expect(src).toContain('result.hooks = hooksResult')
    expect(src).toContain('result.hooks.errors.push(')
    expect(src).toContain('hooksChanged = true')
    expect(src).toContain("existsSync(join(HOOKS_DIR, 'app-start.js'))")
    expect(src).toContain('void rerunAppStartHook()')
    expect(src).not.toContain('将在下次启动应用时生效')
  })

  it('settings save effects are shared with the settings page and run on import', () => {
    // 2026-11-10 ③：导入必须跑与 SETTINGS_SET 同一份生效动作，否则主题/开机
    // 自启/休眠守卫/菜单语言都要等重启。Non-vacuous: 删调用或把顺序挪到写盘
    // 之前都会红。
    const src = read('src/main/ipc/template.handler.ts')
    expect(src).toContain("import { applySettingsSideEffects } from '../services/settings-side-effects'")
    expect(src).toContain('applySettingsSideEffects(')
    expect(src.indexOf('settingsStore.set(sanitized.settings)')).toBeLessThan(src.indexOf('applySettingsSideEffects('))
    // 广播搬进共享模块（两个入口同一份），handler 不再自己发 SETTINGS_CHANGED
    const effects = read('src/main/services/settings-side-effects.ts')
    expect(effects).toContain('IPC_CHANNELS.SETTINGS_CHANGED')
    expect(src).not.toContain('IPC_CHANNELS.SETTINGS_CHANGED')
    // 发起窗口可能已经关了：取窗口单独兜底，不能因此跳过整串生效动作
    expect(src).toContain('BrowserWindow.fromWebContents(event.sender)')
  })

  it('every hard failure lands in result.error (structured), not in warnings', () => {
    // 2026-11-10 ④：解压/解析/校验/写盘各有自己的 catch 与文案；旧实现把
    // 「没找到」也当警告，条件还覆盖了「找到了但坏了」。
    const src = read('src/main/ipc/template.handler.ts')
    expect(src).toContain('result.error = ')
    expect(src).toContain('settings.json 解析失败：')
    expect(src).toContain('settings.json 写入失败：')
    expect(src).toContain('压缩包读取失败：')
    expect(src).toContain('打开文件选择框失败：')
    // 解压 catch 是结构化错误而不是裸 throw / 混进 warnings
    expect(src).toContain('return { ...emptyResult(), error: `压缩包读取失败：')
    expect(src).not.toContain('没有找到 settings.json')
    // 失败都有主日志（打包态 GUI 无终端，logMain 是唯一落盘诊断面）
    expect(src.match(/logMain\('ERROR', 'template'/g)?.length).toBeGreaterThanOrEqual(5)
  })

  it('preload and the bridge contract expose importTemplate with the error field', () => {
    const bridge = read('src/shared/types/electron-bridge.ts')
    expect(bridge).toContain('importTemplate:')
    expect(bridge).toContain('interface TemplateImportResult')
    expect(bridge).toContain('skipped: string[]')
    expect(bridge).toContain('hooks: { imported: string[]; replaced: string[]; unchanged: string[]; errors: string[] }')
    expect(bridge).toContain('tools: { imported: string[]; replaced: string[]; unchanged: string[]; errors: string[] }')
    expect(bridge).toContain('error?: string')
    // 2026-11-11：hooks 有落盘变化时主进程就地重跑 app-start（不重启应用）
    expect(bridge).toContain('appStartTriggered?: boolean')
    expect(bridge).not.toContain('restartRequired')
    expect(bridge).not.toContain('relaunchApp')
    expect(read('src/preload/index.ts')).toContain('importTemplate:')
    expect(read('src/preload/index.ts')).toContain('IPC_CHANNELS.TEMPLATE_IMPORT')
    // 重启链路已整条撤除：没有通道、桥面与主进程 handler
    expect(read('src/preload/index.ts')).not.toContain('APP_RELAUNCH')
    expect(read('src/shared/ipc-channels.ts')).not.toContain('APP_RELAUNCH')
    expect(read('src/main/ipc/app.handler.ts')).not.toContain('relaunchApplication')
  })

  it('the guide card carries the secondary import button calling the bridge', () => {
    const src = read('src/renderer/src/components/welcome/ApiKeyGuide.tsx')
    expect(src).toContain('data-pm-template-import')
    expect(src).toContain('importTemplate()')
    expect(src).toContain('welcome.importTemplate')
    // 成功后的翻转靠既有广播链，不手动 reload
    expect(src).not.toContain('reloadSettings')
  })

  it('renderer reports the structured error, and only a truly empty pack gets the "empty" toast', () => {
    const src = read('src/renderer/src/components/welcome/ApiKeyGuide.tsx')
    // 真实失败走红色提示；与「其它载荷也导进来了」并存，所以不 return
    expect(src).toContain('const { settingsApplied, warnings, skills, hooks, tools, error, appStartTriggered } = result')
    expect(src).toContain('if (error) antdMessage.error(error, 8)')
    // issues 只收 warnings + errors，不含 skipped
    expect(src).toContain('[...warnings, ...skills.errors, ...hooks.errors, ...tools.errors]')
    expect(src).not.toContain('skills.skipped.join')
    // 「包空」只在「无 error、零跳过、零 hooks 痕迹、零 tools 痕迹、零警告」时成立——旧条件
    // 把「找到了但坏了」也算成没找到，提示与事实相反
    expect(src).toContain('skills.skipped.length === 0 &&')
    expect(src).toContain('hooks.unchanged.length === 0 &&')
    expect(src).toContain('tools.unchanged.length === 0 &&')
    expect(src).toContain('templateImportEmpty')
    // hooks/tools 落盘也算成功面（纯 hooks、纯 tools 包不再被当成空包），并给出数量提示
    expect(src).toContain('hooks.imported.length + hooks.replaced.length')
    expect(src).toContain('tools.imported.length + tools.replaced.length')
    expect(src).toContain('welcome.templateImportHooks')
    expect(src).toContain('welcome.templateImportTools')
    // 2026-11-11：成功面附「启动钩子已在后台重新执行」，不重启、不设定时器
    expect(src).toContain('welcome.templateImportAppStart')
    expect(src).toContain('appStartTriggered ?')
    expect(src).not.toContain('relaunchApp')
    expect(src).not.toContain('TEMPLATE_IMPORT_RESTART_DELAY_MS')
  })

  it('appStartTriggered fires only for a real hooks change with app-start.js on disk and no hard error', () => {
    // 2026-11-11：用户要的是「触发 app-start」，不是重启整个应用。重跑是
    // 就地、异步的；重复导入（全部 unchanged）与硬错误都不触发。
    const src = read('src/main/ipc/template.handler.ts')
    expect(src).toContain('result.appStartTriggered =')
    expect(src).toContain("!result.error && hooksChanged && existsSync(join(HOOKS_DIR, 'app-start.js'))")
    expect(src).toContain('hooksChanged = true')
    expect(src).toContain('void rerunAppStartHook()')
    // 旧的重启判定与「下次启动生效」警告都已撤除
    expect(src).not.toContain('restartRequired')
    expect(src).not.toContain('将在下次启动应用时生效')
    // emptyResult 给出确定性 false（早退路径 / 对话框取消外的错误面）
    expect(src).toContain('appStartTriggered: false,')
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

  it('skills-arm failures surface: only a missing skills/ is silent, real errors reach issues + main.log', () => {
    // review_20261106 中2：旧写法一个 catch 包住 access 之后的全部 throw
    //（walk/readFile/cp/活体登记），权限/EBUSY/半截解压被吞成「选错文件」
    // 且零日志。修法 = 定位结果单独定「纯配置包」，其余进 errors 面 + logMain。
    const src = read('src/main/ipc/template.handler.ts')
    expect(src).toContain('if (located.skillsDir)')
    expect(src).toContain("logMain('ERROR', 'template'")
    expect(src).toContain("from '../main-log'")
    // 活体登记单独兜：落盘已成功时如实告知重启生效，不与落盘故障混淆
    expect(src).toContain('重启后生效')
  })

  it('the i18n keys exist in both locales', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    for (const key of [
      'importTemplate',
      'templateImportSuccess',
      'templateImportSkills',
      'templateImportHooks',
      'templateImportTools',
      'templateImportEmpty',
      'templateImportFailed',
      'templateImportAppStart',
    ]) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
  })
})
