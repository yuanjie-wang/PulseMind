// ── 360 浏览器兼容下限（Chromium 108）────────────────────────────────────────
// 目标是 360 浏览器（Qihoo 360，Chromium fork；用户 2026-11-05 裁定：内核下限
// = Chromium 108——其 360 机器实测 108）。Chromium ≥102 上现有构建本就满足
// 插件用到的全部 API 下限（storage.session 102+、promise 化 messaging 99+、
// crypto.randomUUID 92+），所以「支持 360」不是垫片活，而是把下限声明出来：
//   - minimum_chrome_version 让 <108 的内核（未升级的极速 X 95 档）装包即拒、
//     报版本过低——否则装上后 storage.session 缺失，每次 SW 唤醒 TypeError、
//     面板全死，且无处可查。
//   - esbuild target 与该下限一致，未来新增语法不能悄悄抬高引擎地板。
// 其余兼容面 360 自带：它是 Chromium fork，扩展 Origin 沿用 chrome-extension://，
// 桌面 ws-server 的 isAllowedOrigin 原样放行；360 安全浏览器的扩展管理页另可
// 由 se://extensions 进入，只有安装指引文案需要提它。刻意不做的：更老内核
// （安全浏览器 13 = 86、极速 12 = 78，无 MV3）的 MV2 变体包——用户裁定不做，
// 下限直接拒装。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import zhDict from '../src/renderer/src/i18n/locales/zh'
import enDict from '../src/renderer/src/i18n/locales/en'

const REPO = process.cwd()

interface ExtensionManifest {
  minimum_chrome_version?: string
  manifest_version?: number
  background?: { service_worker?: string }
  permissions?: string[]
}

const manifest = JSON.parse(readFileSync(join(REPO, 'src', 'extension', 'manifest.json'), 'utf-8')) as ExtensionManifest

describe('extension browser floor (360 = Chromium 108)', () => {
  it('manifest declares minimum_chrome_version 108 — older kernels refuse the install', () => {
    // 拼错的键会被引擎静默忽略（等于没设），所以钉住精确值。
    expect(manifest.minimum_chrome_version).toBe('108')
  })

  it('is still the MV3 service-worker manifest', () => {
    expect(manifest.manifest_version).toBe(3)
    expect(manifest.background?.service_worker).toBe('background.js')
  })

  it('permissions stay lean — 360 support adds no capability surface', () => {
    // 360 支持不新增权限：红线是不许出现 nativeMessaging 之类的扩权兜底。
    // cookies 是 PLAN-extension-handoff 的授权能力（host_permissions 已有
    // <all_urls>，Chromium 108 下 chrome.cookies 全部可用）——白名单最后一位。
    expect(manifest.permissions).toEqual(['storage', 'tabs', 'alarms', 'debugger', 'cookies'])
  })

  it('esbuild target matches the declared floor (chrome108)', () => {
    // chrome114 → chrome108：今天源码 ≤ ES2020 输出不变；钉住它，未来语法
    // 必须被转译而不是裸过（否则引擎地板悄悄涨过 108）。
    const build = readFileSync(join(REPO, 'scripts', 'build-extension.js'), 'utf-8')
    expect(build).toContain("target: ['chrome108']")
    expect(build).not.toContain('chrome114')
  })
})

describe('install guide names 360', () => {
  const zh = zhDict.extensionSettings
  const en = enDict.extensionSettings

  it('zh g2 names 360, keeps the chrome://extensions link substring, and offers se://extensions', () => {
    // withExtensionsLink 靠 chrome://extensions 子串渲染可点链接，缺了它
    // 第二步就没有可点入口（extension-settings-wiring 钉的是常量，这里钉文案）。
    expect(zh.g2).toContain('360')
    expect(zh.g2).toContain('chrome://extensions')
    expect(zh.g2).toContain('se://extensions')
  })

  it('zh guideOpenFailed offers the se://extensions manual path', () => {
    expect(zh.guideOpenFailed).toContain('se://extensions')
  })

  it('en mirrors zh', () => {
    expect(en.g2).toContain('360')
    expect(en.g2).toContain('chrome://extensions')
    expect(en.guideOpenFailed).toContain('se://extensions')
  })
})
