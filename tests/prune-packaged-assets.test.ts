// 打包裁剪（2026-11-24）：afterPack 的 prune-packaged-assets —— 随包语言资源
// 与 Windows 桌面集成件。起因：Chrome 153 把 locale 包从 55 个扩成 220 个
// （含 af_FEMININE 这类性别变体），win 42MB + 42MB（Chromium + Electron），
// mac 48MB；再加 Windows 上永不加载的 setup.exe/elevation_service 等 23MB，
// 合计约 100MB 原始体积躺在每个包体里。
//
// 这里钉三件事：归一化口径（zh-CN.pak 与 zh_CN.lproj 同一语言）、三平台各自的
// 目录形态、以及「不跟符号链接出树」这条安全边界。接线（after-pack.js 的调用
// 顺序）另用源码扫描钉住。

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const require_ = createRequire(__filename)
const { default: prunePackagedAssets, scan, verify, localeKey, KEEP_LOCALES, WIN_DESKTOP_EXTRAS } = require_('../scripts/prune-packaged-assets.js')
const { readFileSync } = require_('node:fs')

const dirs: string[] = []

function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'pm-prune-'))
  dirs.push(dir)
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

function ctx(appOutDir: string, platform: 'win32' | 'darwin' | 'linux') {
  return {
    appOutDir,
    electronPlatformName: platform,
    packager: { appInfo: { productFilename: 'PulseMind' } },
  }
}

// 静音被测函数的 [prune-assets] 日志（断言看文件系统，不看输出）。
async function run(context: ReturnType<typeof ctx>) {
  const log = console.log
  console.log = () => {}
  try {
    await prunePackagedAssets(context)
  } finally {
    console.log = log
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('localeKey：pak 与 lproj 同一口径', () => {
  it('win 与 mac 的命名差异归一', () => {
    expect(localeKey('zh-CN.pak')).toBe('zh_cn')
    expect(localeKey('zh_CN.lproj')).toBe('zh_cn')
    expect(localeKey('en-US.pak')).toBe('en_us')
    expect(localeKey('en.lproj')).toBe('en')
  })

  it('性别变体剥到基础语言，因此不会被误留', () => {
    expect(localeKey('af_FEMININE.pak')).toBe('af')
    expect(localeKey('zh-CN_MASCULINE.pak')).toBe('zh_cn')
    expect(localeKey('en-GB_NEUTER.pak')).toBe('en_gb')
  })

  it('保留名单含中英两族，性别变体的基础语言命中保留', () => {
    for (const name of ['en-US.pak', 'en-GB.pak', 'zh-CN.pak', 'zh-TW.pak', 'zh-HK.pak']) {
      expect(KEEP_LOCALES.has(localeKey(name))).toBe(true)
    }
    for (const name of ['de.pak', 'ja.pak', 'ar.pak', 'ta_IN.pak']) {
      expect(KEEP_LOCALES.has(localeKey(name))).toBe(false)
    }
  })
})

describe('win32：Chromium locales + Electron locales + 桌面集成件', () => {
  const fixture = () =>
    tmp({
      'resources/chromium/chrome-win/locales/en-US.pak': 'e',
      'resources/chromium/chrome-win/locales/zh-CN.pak': 'z',
      'resources/chromium/chrome-win/locales/en-US_MASCULINE.pak': 'g',
      'resources/chromium/chrome-win/locales/de.pak': 'd',
      'resources/chromium/chrome-win/locales/ja.pak': 'j',
      'resources/chromium/chrome-win/chrome.exe': 'kept',
      'resources/chromium/chrome-win/chrome.dll': 'kept',
      'resources/chromium/chrome-win/dxcompiler.dll': 'kept',
      'resources/chromium/chrome-win/dxil.dll': 'kept',
      'resources/chromium/chrome-win/D3DCompiler_47.dll': 'kept',
      'resources/chromium/chrome-win/chrome_elf.dll': 'kept',
      'resources/chromium/chrome-win/setup.exe': 'gone',
      'resources/chromium/chrome-win/elevation_service.exe': 'gone',
      'resources/chromium/chrome-win/elevated_tracing_service.exe': 'gone',
      'resources/chromium/chrome-win/chrome_pwa_launcher.exe': 'gone',
      'resources/chromium/chrome-win/notification_helper.exe': 'gone',
      'resources/chromium/chrome-win/chrome_proxy.exe': 'gone',
      'resources/chromium/chrome-win/chrome_wer.dll': 'gone',
      'resources/chromium/chrome-win/MEIPreload/manifest.fingerprint': 'x',
      'resources/chromium/chrome-win/MEIPreload/preloaded_data.pb': 'x',
      'locales/en-US.pak': 'e',
      'locales/zh-CN.pak': 'z',
      'locales/de.pak': 'd',
      'PulseMind.exe': 'kept',
    })

  it('删掉非保留语言、保留中英与运行必需项', async () => {
    const appOutDir = fixture()
    await run(ctx(appOutDir, 'win32'))

    const chromium = join(appOutDir, 'resources', 'chromium', 'chrome-win')
    expect(existsSync(join(chromium, 'locales', 'en-US.pak'))).toBe(true)
    expect(existsSync(join(chromium, 'locales', 'zh-CN.pak'))).toBe(true)
    expect(existsSync(join(chromium, 'locales', 'de.pak'))).toBe(false)
    expect(existsSync(join(chromium, 'locales', 'ja.pak'))).toBe(false)
    // 性别变体按基础语言判定：en-US_MASCULINE 归到 en_us（保留），
    // 而 de_FEMININE 之类随基础语言一起删——不是「带后缀就删」。
    expect(existsSync(join(chromium, 'locales', 'en-US_MASCULINE.pak'))).toBe(true)

    for (const kept of ['chrome.exe', 'chrome.dll', 'dxcompiler.dll', 'dxil.dll', 'D3DCompiler_47.dll', 'chrome_elf.dll']) {
      expect(existsSync(join(chromium, kept))).toBe(true)
    }
    for (const gone of WIN_DESKTOP_EXTRAS) {
      expect(existsSync(join(chromium, gone))).toBe(false)
    }

    // Electron 根 locales
    expect(existsSync(join(appOutDir, 'locales', 'en-US.pak'))).toBe(true)
    expect(existsSync(join(appOutDir, 'locales', 'zh-CN.pak'))).toBe(true)
    expect(existsSync(join(appOutDir, 'locales', 'de.pak'))).toBe(false)
    // 可执行文件与 asar 一个都不碰
    expect(existsSync(join(appOutDir, 'PulseMind.exe'))).toBe(true)
  })

  it('桌面上永不加载的文件按名单删净，且名单里每个都真实存在于 CFT 根', () => {
    // 与 chrome-win 根目录的实际文件名对齐（写错名字等于静默不裁）。
    expect(WIN_DESKTOP_EXTRAS).toEqual(expect.arrayContaining(['setup.exe', 'elevation_service.exe', 'notification_helper.exe', 'MEIPreload']))
  })
})

describe('darwin：Chromium 的 .lproj，不碰 Electron 侧', () => {
  it('删非保留 .lproj，保留 en/zh_CN/zh_TW', async () => {
    const appOutDir = tmp({
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/153.0.8010.12/Resources/en.lproj/Localizable.strings':
        'e',
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/153.0.8010.12/Resources/zh_CN.lproj/Localizable.strings':
        'z',
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/153.0.8010.12/Resources/zh_TW.lproj/Localizable.strings':
        'z',
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/153.0.8010.12/Resources/de.lproj/Localizable.strings':
        'd',
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/153.0.8010.12/Resources/af_FEMININE.lproj/Localizable.strings':
        'g',
      // Electron Framework 那份由 strip-lproj 负责；这里造一份同形目录，证明本步只
      // 走 chromium 子树（否则两处删同一件事，边界就说不清了）。
      'PulseMind.app/Contents/Frameworks/Electron Framework.framework/Resources/fr.lproj/Localizable.strings': 'untouched',
    })
    const res =
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Google Chrome for Testing.app/Contents/Frameworks/F.framework/Versions/153.0.8010.12/Resources'

    await run(ctx(appOutDir, 'darwin'))

    for (const kept of ['en.lproj', 'zh_CN.lproj', 'zh_TW.lproj']) {
      expect(existsSync(join(appOutDir, res, kept))).toBe(true)
    }
    for (const gone of ['de.lproj', 'af_FEMININE.lproj']) {
      expect(existsSync(join(appOutDir, res, gone))).toBe(false)
    }
    expect(existsSync(join(appOutDir, 'PulseMind.app/Contents/Frameworks/Electron Framework.framework/Resources/fr.lproj'))).toBe(true)
  })

  it('Versions/Current 这类相对符号链接不被跟进去', async () => {
    const base = tmp({
      'PulseMind.app/Contents/Resources/chromium/chrome-mac/Chrome.app/Contents/Frameworks/F.framework/Versions/153/Resources/de.lproj/Localizable.strings':
        'd',
    })
    const versions = join(base, 'PulseMind.app/Contents/Resources/chromium/chrome-mac/Chrome.app/Contents/Frameworks/F.framework/Versions')
    // 树外的同名字录：如果实现顺着链接走出去，它的 de.pak 会被误删
    const outside = tmp({ 'locales/de.pak': 'outside' })
    symlinkSync(outside, join(versions, 'Current'))

    await run(ctx(base, 'darwin'))

    expect(existsSync(join(versions, '153', 'Resources', 'de.lproj'))).toBe(false)
    expect(existsSync(join(outside, 'locales', 'de.pak'))).toBe(true)
  })
})

describe('linux：chrome-linux 与 app 根 locales', () => {
  it('两处 language 目录都裁，.exe 名单在 linux 上无作用', async () => {
    const appOutDir = tmp({
      'resources/chromium/chrome-linux/locales/en-US.pak': 'e',
      'resources/chromium/chrome-linux/locales/fr.pak': 'f',
      'resources/chromium/chrome-linux/chrome': 'kept',
      'locales/en-US.pak': 'e',
      'locales/ru.pak': 'r',
      pulsemind: 'kept',
    })
    await run(ctx(appOutDir, 'linux'))

    expect(existsSync(join(appOutDir, 'resources/chromium/chrome-linux/locales/en-US.pak'))).toBe(true)
    expect(existsSync(join(appOutDir, 'resources/chromium/chrome-linux/locales/fr.pak'))).toBe(false)
    expect(existsSync(join(appOutDir, 'resources/chromium/chrome-linux/chrome'))).toBe(true)
    expect(existsSync(join(appOutDir, 'locales/ru.pak'))).toBe(false)
  })
})

describe('健壮性', () => {
  it('目录缺席（没装 Chromium 的构建机）不抛错', async () => {
    const appOutDir = tmp({ 'PulseMind.exe': 'x' })
    await expect(run(ctx(appOutDir, 'win32'))).resolves.toBeUndefined()
    expect(existsSync(join(appOutDir, 'PulseMind.exe'))).toBe(true)
  })

  it('幂等：重复跑不抛错、保留项不变', async () => {
    const appOutDir = tmp({
      'resources/chromium/chrome-win/locales/en-US.pak': 'e',
      'resources/chromium/chrome-win/locales/de.pak': 'd',
      'resources/chromium/chrome-win/setup.exe': 'gone',
    })
    await run(ctx(appOutDir, 'win32'))
    await run(ctx(appOutDir, 'win32'))
    expect(existsSync(join(appOutDir, 'resources/chromium/chrome-win/locales/en-US.pak'))).toBe(true)
    expect(existsSync(join(appOutDir, 'resources/chromium/chrome-win/locales/de.pak'))).toBe(false)
  })
})

describe('自检模式 verify（CI 用它证明这一刀落下了）', () => {
  const fixture = () =>
    tmp({
      'resources/chromium/chrome-win/locales/en-US.pak': 'e',
      'resources/chromium/chrome-win/locales/de.pak': 'd',
      'resources/chromium/chrome-win/setup.exe': 'gone',
      'locales/en-US.pak': 'e',
      'locales/de.pak': 'd',
    })

  it('裁完之后报零', async () => {
    const appOutDir = fixture()
    await run(ctx(appOutDir, 'win32'))
    expect(verify(ctx(appOutDir, 'win32'))).toEqual([])
  })

  it('没裁过（afterPack 没接上 / 抛异常被吞）就报出待裁项', async () => {
    const appOutDir = fixture()
    const errors = verify(ctx(appOutDir, 'win32'))
    expect(errors.length).toBe(1)
    expect(errors[0]).toMatch(/prunable entries left/)
    expect(errors[0]).toContain('de.pak')
  })

  it('保留名单回归把 locales 删空时判红', async () => {
    const appOutDir = tmp({
      'resources/chromium/chrome-win/locales/de.pak': 'd',
      'locales/en-US.pak': 'e',
    })
    await run(ctx(appOutDir, 'win32'))
    const errors = verify(ctx(appOutDir, 'win32'))
    expect(errors.some((e) => /no en\/zh locale survived/.test(e))).toBe(true)
  })

  it('scan 只统计不改盘', () => {
    const appOutDir = fixture()
    const acc = scan(ctx(appOutDir, 'win32'), false)
    expect(acc.count).toBeGreaterThan(0)
    expect(existsSync(join(appOutDir, 'resources/chromium/chrome-win/locales/de.pak'))).toBe(true)
  })
})

describe('接线：after-pack.js 的调用顺序', () => {
  it('strip → prune → stripOrt → 门禁，且 prune 在门禁之前', () => {
    const source = readFileSync(join(ROOT, 'scripts/after-pack.js'), 'utf-8')
    expect(source).toContain("require('./prune-packaged-assets')")
    const order = [
      'stripLproj.default(context)',
      'prunePackagedAssets.default(context)',
      'stripOrtForeignArch.default(context)',
      'verifyPackedNodeModules(context)',
    ].map((needle) => source.indexOf(needle))
    expect(order.every((idx) => idx >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
})

// CI 接线（2026-11-24）：afterPack 抛异常会让构建红，但「这一刀根本没接上」的
// 表现是**静默零收益** —— 所以每份 workflow 打包后都必须跑一次 dry-run 自检；
// 而删掉的文件是否伤到浏览器，只有真启动能证明（win/mac 各有一次冒烟，linux
// 容器里没有 libgbm/libasound，不启动浏览器）。
describe('接线：CI 的 verify 自检与浏览器启动冒烟', () => {
  const workflows = {
    win: readFileSync(join(ROOT, '.github/workflows/build-windows.yml'), 'utf-8'),
    linux: readFileSync(join(ROOT, '.github/workflows/build-linux.yml'), 'utf-8'),
    macX64: readFileSync(join(ROOT, '.github/workflows/build-mac-x64.yml'), 'utf-8'),
    macArm64: readFileSync(join(ROOT, '.github/workflows/build-mac-arm64.yml'), 'utf-8'),
  }

  it('四份 workflow 都跑 --verify，平台字面量与产物形态一致', () => {
    const verifyOf = (src: string) => {
      const m = src.match(/prune-packaged-assets\.js --verify --app-out (\S+) --platform ([a-z0-9]+)/)
      return m && { appOut: m[1], platform: m[2] }
    }
    expect(verifyOf(workflows.win)).toEqual({ appOut: 'dist/win-unpacked', platform: 'win32' })
    expect(verifyOf(workflows.linux)).toEqual({ appOut: 'dist/linux-unpacked', platform: 'linux' })
    // mac 的产物在 dist/<arch>/PulseMind.app，脚本因此吃 dirname（与 OCR/ASR 冒烟同款取法）
    for (const mac of [workflows.macX64, workflows.macArm64]) {
      expect(mac).toContain('prune-packaged-assets.js --verify --app-out "$(dirname "$app")" --platform darwin')
    }
  })

  it('win：先自检、再真启动浏览器，两步都在打包之后', () => {
    const pkg = workflows.win.indexOf('- name: Package unpacked app')
    const verify = workflows.win.indexOf('prune-packaged-assets.js --verify')
    const smoke = workflows.win.indexOf('smoke-packed-chromium.js --app-out dist/win-unpacked --platform win32')
    expect(pkg).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(pkg)
    expect(smoke).toBeGreaterThan(verify)
  })

  it('mac 两份都真启动包内 CFT（一档在 mac 删的是 .lproj，同样要验）', () => {
    for (const mac of [workflows.macX64, workflows.macArm64]) {
      expect(mac).toContain('smoke-packed-chromium.js --app-out "$(dirname "$app")" --platform darwin')
    }
  })

  it('linux 不做浏览器冒烟（容器缺运行时库，补库走不了 apt）', () => {
    expect(workflows.linux).not.toContain('smoke-packed-chromium.js')
    expect(workflows.linux).toContain('PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS')
  })
})

// 冒烟脚本自己也要有钉子：它是「包内 Chromium 能不能起来」的唯一判据，路径
// 写错就等于静默失效（找不到 → 退出码说不清 → 有人当通过）。
describe('smoke-packed-chromium.js 的判据', () => {
  const script = readFileSync(join(ROOT, 'scripts/smoke-packed-chromium.js'), 'utf-8')
  const managed = readFileSync(join(ROOT, 'src/main/browser/backends/ManagedBackend.ts'), 'utf-8')
  const { spawnSync } = require_('node:child_process') as typeof import('node:child_process')

  const runScript = (...args: string[]) => spawnSync(process.execPath, [join(ROOT, 'scripts/smoke-packed-chromium.js'), ...args], { encoding: 'utf-8' })

  it('包内候选路径与 ManagedBackend.bundledChromiumPath 同源', () => {
    // 产品侧的三条相对路径都必须在冒烟里出现，否则「冒烟跑的是另一个文件」。
    for (const rel of ['chrome-win', 'chrome-mac', 'chrome-linux', 'Google Chrome for Testing.app', 'chrome.exe']) {
      expect(managed).toContain(rel)
      expect(script).toContain(rel)
    }
  })

  it('缺参数退出 2、没有随包 Chromium 退出 1', () => {
    expect(runScript('--app-out', '/nonexistent-app-out-dir').status).toBe(2)

    const empty = tmp({ 'resources/app.asar': 'x' })
    const res = runScript('--app-out', empty, '--platform', 'win32')
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('no bundled Chromium')
  })

  it('断言的是「真启动 + 真渲染 + 真截图」，不是文件存在', () => {
    expect(script).toContain('chromium.launch({ executablePath, headless: true })')
    expect(script).toContain('page.setContent')
    expect(script).toContain('page.screenshot')
    // headless 必须与产品缺省一致（ManagedBackend 的 settings.browser.headless ?? true）
    expect(script).not.toContain('headless: false')
  })
})
