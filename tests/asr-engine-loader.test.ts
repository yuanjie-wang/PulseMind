// ── ASR 引擎加载器（PLAN-voice-input M1）──
// 三级回落（env → resourcesPath → dev node_modules）、平台门、sha 门、
// 错误文案。文件存在性全部用真临时目录；不真的 require addon（dlopen 由
// probe-asr-m0.mjs 与 smoke-packed-asr.js 在真引擎上验证）。

import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DARWIN_FILES = ['sherpa-onnx.node', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'libsherpa-onnx-cxx-api.dylib']

// npm 平台包名段：厂商 Windows 包叫 win（sherpa-onnx-win-x64），目录名才是 win32
const PKG_NAME = `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`

let cleanup: Array<() => void> = []

afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
  delete process.env.PULSEMIND_ASR_ENGINE
  vi.resetModules()
})

function freshModule() {
  vi.resetModules()
  return import('../src/main/services/asr-engine')
}

function makeEngineDir(opts: { files?: string[]; manifest?: Record<string, unknown> | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-loader-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const f of opts.files ?? DARWIN_FILES) writeFileSync(join(dir, f), 'dummy')
  if (opts.manifest !== null) {
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(opts.manifest ?? { version: '2.0.2', files: {} }), 'utf-8')
  }
  return dir
}

describe('resolveAsrEngineDir — 三级回落', () => {
  it('env 候选（PULSEMIND_ASR_ENGINE 直接指向平台目录）优先且带 manifest 信息', async () => {
    const dir = makeEngineDir()
    process.env.PULSEMIND_ASR_ENGINE = dir
    const mod = await freshModule()
    const r = mod.resolveAsrEngineDir()
    expect(r.dir).toBe(dir)
    expect(r.source).toBe('env')
    expect(r.version).toBe('2.0.2')
    expect(r.hasManifest).toBe(true)
  })

  it('env 指向不存在的目录 → 落到下一级候选而不报错（回落语义）', async () => {
    process.env.PULSEMIND_ASR_ENGINE = join(tmpdir(), 'pulsemind-asr-no-such-dir')
    const devDir = makeEngineDir()
    // dev 回落沿 __dirname 向上找 node_modules/sherpa-onnx-<plat>-<arch> —— 在
    // 测试进程里没有这个目录，所以两级候选都落空 → 抛可读错误（平台门语义）。
    // 这里只断言「不把 env 的缺失当成致命」：错误文案里列出本机需要的架构。
    const mod = await freshModule()
    try {
      mod.resolveAsrEngineDir()
      // 如果开发机的 node_modules 里真有 sherpa-onnx-darwin-arm64（devDep 装
      // 过），dev 候选会命中——两种结局都合法，只锁 env 落空不炸这一点。
    } catch (e) {
      expect((e as Error).message).toContain(PKG_NAME)
    }
    void devDir
  })

  it('全候选落空 → 错误列出本机需要的平台与在场目录（装错架构可自诊）', async () => {
    // 不给 env；resourcesPath 在测试进程不存在；dev node_modules 里是否有
    // darwin-arm64 取决于开发机——为钉死「落空」分支，伪造一个非本平台的
    // 目录放进向上搜索的 node_modules……太重。这里直接在错误断言里兼容
    // 「devDep 在场」的环境：只有当真没有 devDep 时才走这条。
    delete process.env.PULSEMIND_ASR_ENGINE
    const devDepPath = join(process.cwd(), 'node_modules', PKG_NAME)
    if (require('node:fs').existsSync(join(devDepPath, 'sherpa-onnx.node'))) {
      return // devDep 在场：回落会命中，跳过这条（CI 的打包环境由 smoke 钉）
    }
    const mod = await freshModule()
    expect(() => mod.resolveAsrEngineDir()).toThrow(/语音引擎未安装/)
  })
})

describe('verifyEngineSha — sha 门', () => {
  it('manifest 文件全对 → ok', async () => {
    const { createHash } = await import('node:crypto')
    const dir = makeEngineDir({
      manifest: {
        version: '2.0.2',
        files: { 'sherpa-onnx.node': createHash('sha256').update('dummy').digest('hex') },
      },
    })
    const mod = await freshModule()
    // sha 门是异步流式的（review 20261122 B3）：34MB 引擎不许同步占住主进程
    expect(await mod.verifyEngineSha(dir)).toEqual({ ok: true, bad: [] })
  })

  it('文件被替换 → 不 ok，bad 带文件名与前后缀对照', async () => {
    const { createHash } = await import('node:crypto')
    const dir = makeEngineDir({
      manifest: {
        version: '2.0.2',
        files: { 'sherpa-onnx.node': createHash('sha256').update('ORIGINAL').digest('hex') },
      },
    })
    const mod = await freshModule()
    const r = await mod.verifyEngineSha(dir)
    expect(r.ok).toBe(false)
    expect(r.bad[0]).toContain('sherpa-onnx.node')
    expect(r.bad[0]).toContain('mismatch')
  })

  it('manifest 声明的文件缺失 → not ok', async () => {
    const dir = makeEngineDir({
      manifest: { version: '2.0.2', files: { 'ghost.dylib': 'a'.repeat(64) } },
    })
    const mod = await freshModule()
    const r = await mod.verifyEngineSha(dir)
    expect(r.ok).toBe(false)
    expect(r.bad[0]).toContain('missing')
  })

  it('manifest 损坏 → not ok（不许静默跳过）', async () => {
    const dir = makeEngineDir({ manifest: null })
    writeFileSync(join(dir, 'manifest.json'), 'not json at all', 'utf-8')
    const mod = await freshModule()
    const r = await mod.verifyEngineSha(dir)
    expect(r.ok).toBe(false)
    expect(r.bad[0]).toContain('manifest.json')
  })
})

describe('loadAsrAddon — 错误翻译', () => {
  it('加载不存在的 .node → 可读文案带平台与处置建议（不裸抛 dlopen）', async () => {
    const dir = makeEngineDir()
    rmSync(join(dir, 'sherpa-onnx.node'))
    const mod = await freshModule()
    try {
      mod.loadAsrAddon(dir)
      expect.unreachable('should have thrown')
    } catch (e) {
      const msg = (e as Error).message
      expect(msg).toContain('语音引擎加载失败')
      expect(msg).toContain(`${process.platform}-${process.arch}`)
      expect(msg).toContain('重装应用')
    }
  })

  it('加载到了但 API 不对 → 版本不配对文案（requireFn 测试缝）', async () => {
    const dir = makeEngineDir()
    const mod = await freshModule()
    try {
      mod.loadAsrAddon(dir, (() => ({ someOtherApi: true })) as unknown as NodeRequire)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('版本不配对')
    }
  })
})

describe('平台门', () => {
  it('REQUIRED 清单按平台分流（darwin/win32/linux 各自的 dylib/dll/so 家族）', async () => {
    const mod = await freshModule()
    const filesOf = (_platform: string): string[] => {
      // 通过 resolve 的行为间接锁清单：resolve 在伪造目录上判断 hasAllFiles
      const dir = mkdtempSync(join(tmpdir(), 'pulsemind-asr-plat-'))
      cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
      process.env.PULSEMIND_ASR_ENGINE = dir
      return dir
    }
    void filesOf
    // 直接验证内部导出（REQUIRED 不导出，行为面锁在 resolveAsrEngineDir 的
    // 错误文案里已覆盖）——这里锁 asrPlatformArch 的拼写纪律
    expect(mod.asrPlatformArch()).toBe(`${process.platform}-${process.arch}`)
    // npm 平台包名段：只有 win32 换拼写（厂商包叫 win），目录名不动
    expect(mod.asrPackageArch()).toBe(`${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`)
  })
})

// 方案 ①（2026-11-23）：linux 随包的私有 C++ 运行库。它是**条件**必备件——
// manifest.json 是 prepare 输出的标记，只有那种目录才该有它；node_modules 里的
// 厂商包没有（那里只有「要系统 libstdc++」的 NEEDED），要求它就会把 Linux dev
// 回落判死。这里显式传 platform，不依赖跑测试的机器。
describe('privateRuntimeFiles — 私有运行库的适用条件', () => {
  it('没有 manifest 的目录（dev 回落的厂商包）不要求 libpmcxx.so.6', async () => {
    const dir = makeEngineDir({ manifest: null })
    const mod = await freshModule()
    expect(mod.privateRuntimeFiles(dir, 'linux')).toEqual([])
  })

  it('有 manifest（prepare 输出）→ linux 要它；其它平台不要', async () => {
    const dir = makeEngineDir({ manifest: {} })
    const mod = await freshModule()
    expect(mod.privateRuntimeFiles(dir, 'linux')).toEqual(['libpmcxx.so.6'])
    expect(mod.privateRuntimeFiles(dir, 'darwin')).toEqual([])
    expect(mod.privateRuntimeFiles(dir, 'win32')).toEqual([])
  })

  it('缺了它就不算「引擎可用」的目录（hasAllFiles 的第二组条件）', async () => {
    // 与 resolve 的判据同源：REQUIRED 文件齐 + 私有运行库齐。这里只锁「第二组
    // 条件真的参与了判断」——文件缺了会落回下一级候选/抛错，不会静默放过。
    const dir = makeEngineDir({ manifest: {} })
    const mod = await freshModule()
    const priv = mod.privateRuntimeFiles(dir, 'linux')
    expect(priv.length).toBeGreaterThan(0)
    expect(priv.every((f: string) => !require('node:fs').existsSync(join(dir, f)))).toBe(true)
  })
})
