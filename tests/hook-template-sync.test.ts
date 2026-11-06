import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as osTmpdir } from 'node:os'
import { createHash } from 'node:crypto'

/**
 * hooks/ 模板同步的 provenance 门控（2026-11-05，修订 2026-10-30 的
 * 「每次启动覆盖」裁定——那一臂把机器上手工部署的 app-start.js 首启就顶掉
 * 了：部署方在应用从未跑过的机器上放好定制登录钩子，ensureDataDir 发现字节
 * ≠ 模板 → 备份进 .bak 后用示例骨架覆盖 → 钩子永远不跑。mac/Windows 同样
 * 中招，与平台无关）。
 *
 * 新语义：模板仍随版本送达已装机器（10-30 裁定对「干净」文件保留），但只有
 * 盘上字节仍与 .seed-hashes.json 记录的「上次播种内容」完全一致（用户从未
 * 动过）才允许覆盖；与记录不符、或清单里根本没有记录（手工部署/预清单存量）
 * 的文件是用户内容——永不覆盖、永不备份、永不删除。与 skills 种子清单
 * （skill-store.ts）同一把解法的第二处应用。
 *
 * The drift this file pins (2026-11-05): every launch-unconditional replace
 * arm is gone. Tests run against a TEMP HOME (the hook-browser.test.ts
 * pattern) — the manifest lives in the real HOOKS_DIR, so the old
 * run-against-the-developer's-~/.pulsemind setup is no longer acceptable.
 */

const TEMPLATE_ROOT = join(osTmpdir(), `pulsemind-hook-sync-tpl-${process.pid}-${Date.now()}`)
const TEMPLATES_PULSEMIND = join(TEMPLATE_ROOT, 'templates', 'pulsemind')
const HOOK_TEMPLATE = join(TEMPLATES_PULSEMIND, 'hooks', 'app-start.js')

const V1 = '// template v1 — the skeleton a previous release shipped\n'
const V2 = '// template v2 — improved skeleton with watchdog guidance\n'
const V3 = '// template v3 — a same-day second update state\n'
const V4 = '// template v4 — a later bundle text\n'
const DEPLOYED = [
  '// DEPLOYED LOGIN HOOK — placed by provisioning BEFORE the app ever ran',
  'module.exports = async () => ({ env: { LOGIN: \'ok\' } })',
  '',
].join('\n')
const USER_EDIT_PREFIX = '// MY LOCAL EDIT — the user customized the seeded skeleton\n'

const shaOf = (s: string): string => createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex')
const SEED_KEY = 'hooks/app-start.js'

let home = ''
let prevHome = ''

const hooksDir = (): string => join(home, '.pulsemind', 'hooks')
const diskHook = (): string => join(hooksDir(), 'app-start.js')
const manifestPath = (): string => join(hooksDir(), '.seed-hashes.json')
const userOnlyHook = (): string => join(hooksDir(), 'llm-request.js')

/** Fresh storage modules against the temp home (storage/index computes
 *  DATA_DIR/HOOKS_DIR from HOME at module load). HOME is restored before the
 *  assertions run — the returned consts already point at the sandbox, and a
 *  safety expect inside boot() refuses a stale module that would touch the
 *  developer's real ~/.pulsemind. */
async function boot(): Promise<{ ensureDataDir: () => void; DATA_DIR: string; HOOKS_DIR: string }> {
  process.env.HOME = home
  try {
    vi.resetModules()
    const [stubMod, storageMod] = await Promise.all([
      import('./stubs/electron'),
      import('../src/main/storage/index'),
    ])
    stubMod.app.getAppPath = () => TEMPLATE_ROOT
    expect(storageMod.HOOKS_DIR).toBe(hooksDir())
    return storageMod
  } finally {
    process.env.HOME = prevHome
  }
}

const readManifest = (): Record<string, string> =>
  existsSync(manifestPath()) ? JSON.parse(readFileSync(manifestPath(), 'utf-8')) : {}

beforeAll(() => {
  prevHome = process.env.HOME ?? ''
  mkdirSync(join(TEMPLATES_PULSEMIND, 'hooks'), { recursive: true })
})

beforeEach(() => {
  home = join(osTmpdir(), `pulsemind-hook-sync-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  writeFileSync(HOOK_TEMPLATE, V1, 'utf-8')
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  process.env.HOME = prevHome
})

afterAll(() => {
  rmSync(TEMPLATE_ROOT, { recursive: true, force: true })
})

describe('hooks template sync — provenance-gated upgrades', () => {
  it('a fresh install seeds the hook and records its provenance', async () => {
    const { ensureDataDir } = await boot()
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(V1)
    expect(readManifest()).toEqual({ [SEED_KEY]: shaOf(V1) })
  })

  it('a template upgrade replaces a pristine seeded file — backed up first, record updated', async () => {
    const { ensureDataDir } = await boot()
    ensureDataDir() // seed V1

    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0)) // 2026-03-15
    try {
      writeFileSync(HOOK_TEMPLATE, V2, 'utf-8')
      ensureDataDir()

      expect(readFileSync(diskHook(), 'utf-8')).toBe(V2)
      const bak = join(hooksDir(), 'app-start.js.20260315.bak')
      expect(readFileSync(bak, 'utf-8')).toBe(V1)
      expect(readManifest()).toEqual({ [SEED_KEY]: shaOf(V2) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('the day\u2019s first backup survives a same-day second upgrade', async () => {
    const { ensureDataDir } = await boot()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 2, 15, 10, 0, 0))
    try {
      ensureDataDir() // seed V1
      writeFileSync(HOOK_TEMPLATE, V3, 'utf-8')
      ensureDataDir() // upgrade 1 — backs V1 up
      const bak = join(hooksDir(), 'app-start.js.20260315.bak')
      expect(readFileSync(bak, 'utf-8')).toBe(V1)

      // Still 2026-03-15: the second upgrade must not replace the day's
      // first backup with the V3 intermediate state.
      writeFileSync(HOOK_TEMPLATE, V4, 'utf-8')
      ensureDataDir()
      expect(readFileSync(diskHook(), 'utf-8')).toBe(V4)
      expect(readFileSync(bak, 'utf-8')).toBe(V1)
      expect(readManifest()).toEqual({ [SEED_KEY]: shaOf(V4) })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a user-edited hook is never overwritten — the template does not win', async () => {
    const { ensureDataDir } = await boot()
    ensureDataDir() // seed V1
    const edited = USER_EDIT_PREFIX + V1
    writeFileSync(diskHook(), edited, 'utf-8')

    // The template moves on — twice. The edit survives every launch.
    writeFileSync(HOOK_TEMPLATE, V2, 'utf-8')
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(edited)
    writeFileSync(HOOK_TEMPLATE, V3, 'utf-8')
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(edited)

    // No backup: nothing was replaced. The seed record keeps pointing at V1.
    expect(readdirSync(hooksDir()).some((f) => f.endsWith('.bak'))).toBe(false)
    expect(readManifest()).toEqual({ [SEED_KEY]: shaOf(V1) })
  })

  it('a hook deployed by hand BEFORE the app ever ran survives every launch (the deployed-login-hook incident)', async () => {
    // Provisioning places the real login hook on a machine the app has
    // never run on. There is no manifest, no seed record — the file must
    // still win over the template, on the first launch and forever after.
    mkdirSync(hooksDir(), { recursive: true })
    writeFileSync(diskHook(), DEPLOYED, 'utf-8')

    const { ensureDataDir } = await boot()
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(DEPLOYED)
    expect(readManifest()).toEqual({}) // foreign content is NOT adopted as ours

    // Later launches with an evolved template keep their hands off.
    writeFileSync(HOOK_TEMPLATE, V2, 'utf-8')
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(DEPLOYED)
    expect(readdirSync(hooksDir()).some((f) => f.endsWith('.bak'))).toBe(false)
  })

  it('a pre-manifest copy equal to today\u2019s template is adopted as pristine — future upgrades reach it', async () => {
    // A machine that ran an older release holds a seeded skeleton from before
    // the manifest existed. It equals today's template, so it is genuinely
    // ours: adopt it into the manifest (no overwrite, no backup), which is
    // what keeps the 2026-10-30 delivery channel alive for upgraded installs.
    mkdirSync(hooksDir(), { recursive: true })
    writeFileSync(diskHook(), V1, 'utf-8')

    const { ensureDataDir } = await boot()
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(V1)
    expect(readManifest()).toEqual({ [SEED_KEY]: shaOf(V1) })
    expect(readdirSync(hooksDir()).some((f) => f.endsWith('.bak'))).toBe(false)

    // The adoption is load-bearing: the next template bump now upgrades.
    writeFileSync(HOOK_TEMPLATE, V2, 'utf-8')
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(V2)
    expect(readManifest()).toEqual({ [SEED_KEY]: shaOf(V2) })
  })

  it('a corrupt seed manifest fails safe — user content is kept', async () => {
    mkdirSync(hooksDir(), { recursive: true })
    writeFileSync(manifestPath(), '{not json at all', 'utf-8')
    writeFileSync(diskHook(), DEPLOYED, 'utf-8')

    const { ensureDataDir } = await boot()
    ensureDataDir()
    expect(readFileSync(diskHook(), 'utf-8')).toBe(DEPLOYED)
  })

  it('identical bytes skip — an unchanged launch touches neither the file nor the manifest', async () => {
    const { ensureDataDir } = await boot()
    ensureDataDir() // seed V1
    const before = statSync(diskHook()).mtimeMs
    const manifestBefore = readFileSync(manifestPath(), 'utf-8')

    ensureDataDir()
    expect(statSync(diskHook()).mtimeMs).toBe(before)
    expect(readFileSync(manifestPath(), 'utf-8')).toBe(manifestBefore)
    expect(readFileSync(diskHook(), 'utf-8')).toBe(V1)
  })
})

describe('the contracts around the gated hooks subtree', () => {
  it('a hook file no template carries survives every resync', async () => {
    const { ensureDataDir } = await boot()
    mkdirSync(hooksDir(), { recursive: true })
    writeFileSync(userOnlyHook(), '// the user runs this on every LLM request\n', 'utf-8')
    ensureDataDir()
    expect(readFileSync(userOnlyHook(), 'utf-8')).toBe('// the user runs this on every LLM request\n')
    // It never enters the seed manifest: no template claims it.
    expect(Object.keys(readManifest())).not.toContain('hooks/llm-request.js')
  })

  it('outside hooks/ the never-overwrite contract stands', async () => {
    const { ensureDataDir, DATA_DIR } = await boot()
    writeFileSync(join(TEMPLATES_PULSEMIND, 'notes.md'), 'template v1', 'utf-8')
    ensureDataDir()
    expect(readFileSync(join(DATA_DIR, 'notes.md'), 'utf-8')).toBe('template v1')

    // The template moved on — a plain template file must NOT follow it.
    writeFileSync(join(TEMPLATES_PULSEMIND, 'notes.md'), 'template v2 — changed', 'utf-8')
    ensureDataDir()
    expect(readFileSync(join(DATA_DIR, 'notes.md'), 'utf-8')).toBe('template v1')
  })
})
