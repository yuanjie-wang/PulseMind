import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { getHookEnv, purgeHookModuleCache, rerunAppStartHook } from '../src/main/hooks-runner'
import { resolveEnvVarsInString } from '../src/shared/env'

// 模板包导入后的就地重跑（2026-11-11）。这里驱动真实的 CJS require 缓存：
// 旧实现只调 runLaunchHooks() 会拿到缓存里的旧模块，且 hookEnv 是合并语义，
// 换掉的脚本永远不生效——所以这几条都围绕「盘上换了文件，跑的是新代码」。
const dirs: string[] = []

function makeHooksDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-app-start-'))
  dirs.push(dir)
  return dir
}

const req = createRequire(import.meta.url)

/** Loader that records how many times the hook file was loaded. */
function countingLoader(): { loader: (filePath: string) => unknown; loads: () => number } {
  let loads = 0
  return {
    loader: (filePath: string) => {
      loads += 1
      return req(filePath)
    },
    loads: () => loads,
  }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true })
  // Returned env now lands in process.env (that is where ${ENV} resolves
  // from); keep the keys this file invents from leaking into other tests.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('RERUN_')) delete process.env[key]
  }
})

describe('purgeHookModuleCache', () => {
  it('drops the hook file and helper modules under the dir, but never a sibling with the same prefix', () => {
    const cache: Record<string, unknown> = {
      '/tmp/pm-hooks/app-start.js': {},
      '/tmp/pm-hooks/lib/helper.js': {},
      '/tmp/pm-hooks2/app-start.js': {},
      '/tmp/elsewhere.js': {},
    }
    expect(purgeHookModuleCache('/tmp/pm-hooks', cache).sort()).toEqual(['/tmp/pm-hooks/app-start.js', '/tmp/pm-hooks/lib/helper.js'])
    expect(Object.keys(cache).sort()).toEqual(['/tmp/elsewhere.js', '/tmp/pm-hooks2/app-start.js'])
  })

  it('accepts a trailing separator and a missing cache', () => {
    const cache: Record<string, unknown> = { '/tmp/pm-hooks/a.js': {} }
    expect(purgeHookModuleCache('/tmp/pm-hooks/', cache)).toEqual(['/tmp/pm-hooks/a.js'])
    expect(purgeHookModuleCache('/tmp/pm-hooks', undefined)).toEqual([])
  })
})

describe('rerunAppStartHook', () => {
  it('runs a replaced app-start.js and its replaced helper, not the cached copies', async () => {
    const dir = makeHooksDir()
    const hookPath = join(dir, 'app-start.js')
    writeFileSync(join(dir, 'helper.js'), "exports.token = 'v1'\n")
    writeFileSync(hookPath, "const helper = require('./helper')\nmodule.exports = () => ({ env: { RERUN_HELPER: helper.token } })\n")

    const first = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(first).toMatchObject({ ran: true, timedOut: false, envKeys: 1 })
    expect(getHookEnv().RERUN_HELPER).toBe('v1')
    expect(process.env.RERUN_HELPER).toBe('v1')

    // 同一路径内容改写：没有 cache purge 的话 require 仍回旧导出。
    writeFileSync(join(dir, 'helper.js'), "exports.token = 'v2'\n")
    writeFileSync(hookPath, "const helper = require('./helper')\nmodule.exports = () => ({ env: { RERUN_HELPER: helper.token } })\n")
    const second = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(second.ran).toBe(true)
    expect(getHookEnv().RERUN_HELPER).toBe('v2')
    expect(process.env.RERUN_HELPER).toBe('v2')
  })

  it("replaces hookEnv on success instead of merging the old script's exports", async () => {
    const dir = makeHooksDir()
    const hookPath = join(dir, 'app-start.js')
    writeFileSync(hookPath, "module.exports = () => ({ env: { RERUN_KEEP: 'old', RERUN_DROP: 'stale' } })\n")
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(getHookEnv().RERUN_KEEP).toBe('old')
    expect(getHookEnv().RERUN_DROP).toBe('stale')

    writeFileSync(hookPath, "module.exports = () => ({ env: { RERUN_KEEP: 'new' } })\n")
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(getHookEnv().RERUN_KEEP).toBe('new')
    // 新进程里旧脚本没跑过 —— 它导出的变量不能残留。
    expect(getHookEnv().RERUN_DROP).toBeUndefined()
    // ${ENV} 占位符只读 process.env，返回值必须同时镜像过去。
    expect(process.env.RERUN_DROP).toBeUndefined()
  })

  it('clears previous hook env when the new script returns none', async () => {
    const dir = makeHooksDir()
    const hookPath = join(dir, 'app-start.js')
    writeFileSync(hookPath, "module.exports = () => ({ env: { RERUN_GONE: 'yes' } })\n")
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(getHookEnv().RERUN_GONE).toBe('yes')

    writeFileSync(hookPath, 'module.exports = () => undefined\n')
    const result = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(result).toMatchObject({ ran: true, envKeys: 0, timedOut: false })
    expect(getHookEnv().RERUN_GONE).toBeUndefined()
    expect(process.env.RERUN_GONE).toBeUndefined()
  })

  it('feeds ${ENV} placeholders from returned env and restores the pre-hook value when dropped', async () => {
    const dir = makeHooksDir()
    const hookPath = join(dir, 'app-start.js')
    // 系统里本来就有这个变量：重跑抹掉钩子导出后必须回落到它，而不是留旧值。
    process.env.RERUN_API_KEY = 'system-value'

    writeFileSync(hookPath, "module.exports = () => ({ env: { RERUN_API_KEY: 'hook-value' } })\n")
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    // settings 里的 apiKey: "${RERUN_API_KEY}" 走的就是这条解析。
    expect(resolveEnvVarsInString('${RERUN_API_KEY}')).toBe('hook-value')

    writeFileSync(hookPath, 'module.exports = () => ({ env: {} })\n')
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(resolveEnvVarsInString('${RERUN_API_KEY}')).toBe('system-value')
    expect(getHookEnv().RERUN_API_KEY).toBeUndefined()
  })

  it('keeps the previous env when the new script throws', async () => {
    const dir = makeHooksDir()
    const hookPath = join(dir, 'app-start.js')
    writeFileSync(hookPath, "module.exports = () => ({ env: { RERUN_ERR_KEEP: 'kept' } })\n")
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeFileSync(hookPath, "module.exports = () => { throw new Error('boom') }\n")
    const result = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    errorSpy.mockRestore()

    expect(result.ran).toBe(true)
    expect(result.error).toContain('boom')
    expect(getHookEnv().RERUN_ERR_KEEP).toBe('kept')
    expect(process.env.RERUN_ERR_KEEP).toBe('kept')
  })

  it('keeps the previous env when the new script hits the watchdog', async () => {
    const dir = makeHooksDir()
    const hookPath = join(dir, 'app-start.js')
    writeFileSync(hookPath, "module.exports = () => ({ env: { RERUN_TIMEOUT_KEEP: 'kept' } })\n")
    await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    writeFileSync(hookPath, 'module.exports = () => new Promise(() => {})\nmodule.exports.timeout = 20\n')
    const result = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    warnSpy.mockRestore()

    expect(result).toMatchObject({ ran: true, timedOut: true })
    expect(getHookEnv().RERUN_TIMEOUT_KEEP).toBe('kept')
  })

  it('reports a missing app-start.js without touching env', async () => {
    const dir = makeHooksDir()
    writeFileSync(join(dir, 'llm-request.js'), 'module.exports = () => undefined\n')
    const result = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    expect(result).toMatchObject({ ran: false, timedOut: false })
    expect(result.error).toBeUndefined()
  })

  it('does not treat a non-function export as a run', async () => {
    const dir = makeHooksDir()
    writeFileSync(join(dir, 'app-start.js'), 'module.exports = 42\n')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await rerunAppStartHook({ hooksDir: dir, loader: req, cache: req.cache })
    warnSpy.mockRestore()
    expect(result).toMatchObject({ ran: false, timedOut: false })
    expect(result.error).toBeUndefined()
  })

  it('coalesces concurrent triggers into one execution', async () => {
    const dir = makeHooksDir()
    writeFileSync(join(dir, 'app-start.js'), 'module.exports = () => new Promise((resolve) => setTimeout(() => resolve(undefined), 30))\n')
    const { loader, loads } = countingLoader()

    const first = rerunAppStartHook({ hooksDir: dir, loader, cache: req.cache })
    const second = rerunAppStartHook({ hooksDir: dir, loader, cache: req.cache })
    expect(second).toBe(first)

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(loads()).toBe(1)
  })
})

describe('wiring invariants', () => {
  it('keeps the launch gate behind an active re-run and serializes every run', async () => {
    const { readFile } = await import('node:fs/promises')
    const src = await readFile('src/main/hooks-runner.ts', 'utf-8')
    // 重跑期间发起的请求必须等新钩子，而不是拿旧 env 放行
    expect(src).toContain('if (rerunPromise) return rerunPromise.then(() => undefined)')
    // 登录钩子可能开窗，两实例绝不重叠
    expect(src).toContain('hookQueue = next.catch(() => undefined)')
    // 重跑必须清模块缓存，否则替换后的文件永远不生效
    expect(src).toContain('purgeHookModuleCache(hooksDir, cache)')
    expect(src).toContain("runHook('app-start', { ...options, fresh: true })")
    // 启动那一跑返回的 env 也要镜像进 process.env（${ENV} 只读它）
    expect(src).toContain('applyHookReturnedEnv(outcome.env)')
  })
})
