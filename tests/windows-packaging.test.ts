// Windows 打包链的钉子（2026-11-24 立：交付收成 unpacked 单形态）。
//
// 这一层没有可单测的「产品逻辑」，能钉的是**契约**：产物形态只有 dir + 一个 zip、
// workflow 的可执行行里不许再出现 portable/NSIS 路径、zip 的顶层文件夹名与
// 「解压即得一个目录、里面直接是 PulseMind.exe」这个形态、以及 artifact/Release
// 只传那一个 zip。
//
// 背景（user 2026-11-24「windows要unpacked，不要portable」）：portable 是单文件
// 自解压 exe（target=portable 走 NSIS），它的体积与内容和 win-unpacked 是两棵树；
// 交付收成 unpacked 之后只有一个来源（dist/win-unpacked → zip），asar 与随包资源
// 的门禁（afterPack 的 node-dep-tree、prune 自检、三条冒烟）也就都对着最终交付
// 的那棵树跑 —— 此前它们验的是 unpacked，用户拿到的却是 exe，两者靠「压缩环节
// 不改变内容」这句假设连着。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const WORKFLOW = read('.github/workflows/build-windows.yml')
const PKG = JSON.parse(read('package.json')) as {
  build: { win: { target: string[] } & Record<string, unknown> } & Record<string, unknown>
}

/** 可执行行（去掉注释、去掉空行）——解释性注释里出现 deb/portable 字样是允许的。 */
const executable = WORKFLOW.split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')

const trimmedLines = WORKFLOW.split('\n').map((line) => line.trim())

describe('产物形态：只有 dir + 一个 zip（2026-11-24 用户裁定）', () => {
  it('win.target 恰为 dir —— 不产 portable/nsis 安装器', () => {
    expect(PKG.build.win.target).toEqual(['dir'])
    for (const banned of ['portable', 'nsis', 'msi', 'zip']) {
      expect(PKG.build.win.target).not.toContain(banned)
    }
  })

  it('nsis 段已退役（它只为 portable/安装器存在）', () => {
    expect(PKG.build.nsis).toBeUndefined()
  })

  it('打包命令唯一且是 --win dir', () => {
    const runs = trimmedLines.filter((line) => line.startsWith('run: npx electron-builder'))
    expect(runs).toEqual(['run: npx electron-builder --win dir --x64 --publish never'])
  })

  it('可执行行里没有 portable 路径，也没有 dist/*.exe 的交付引用', () => {
    expect(executable).not.toMatch(/--win portable/)
    expect(executable).not.toContain('PulseMind-win-x64-portable')
    expect(executable).not.toMatch(/dist[\\/]\*\.exe/)
    // upload-unpacked 开关随「总是交付整包」退役——留着它就是一条永远为 true 的死输入
    expect(executable).not.toContain('upload-unpacked')
  })
})

describe('zip 形态：解压得到一个目录，里面直接是 PulseMind.exe', () => {
  const step = (name: string) => {
    const start = trimmedLines.indexOf(`- name: ${name}`)
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = trimmedLines.slice(start + 1)
    const end = rest.findIndex((line) => line.startsWith('- name: ') || line.startsWith('- uses: '))
    return (end === -1 ? rest : rest.slice(0, end)).join('\n')
  }

  it('staging 顶层文件夹名带版本号，且断言顶层存在 PulseMind.exe', () => {
    const body = step('Package unpacked zip')
    // 顶层目录名 = PulseMind-<version>-win-x64（与 linux 的 tarball 同名规矩）
    expect(body).toContain('$name = "PulseMind-$version-win-x64"')
    expect(body).toContain('Move-Item dist\\win-unpacked $stage')
    expect(body).toContain('PulseMind.exe')
    expect(body).toMatch(/if \(-not \(Test-Path .*PulseMind\.exe.*\)\)/)
  })

  it('7z 的存档路径不带 dist/ 前缀（Push-Location 进 dist 再压）', () => {
    const body = step('Package unpacked zip')
    expect(body).toContain('Push-Location dist')
    expect(body).toMatch(/7z a -tzip -mx=5 "\$name\.zip" \$name/)
    // 旧写法会把「dist」也存进 zip，解压得到 dist/win-unpacked 两层
    expect(body).not.toMatch(/7z a [^\n]*dist\\win-unpacked/)
  })

  it('sha256 落在日志与 step summary 上（大文件不靠人肉对账）', () => {
    const body = step('Package unpacked zip')
    expect(body).toContain('Get-FileHash -Algorithm SHA256')
    expect(body).toContain('$env:GITHUB_STEP_SUMMARY')
  })
})

describe('artifact 与 Release 只传那一个 zip', () => {
  it('upload-artifact 只有一处，固定名、吃 dist/*.zip', () => {
    const uploads = trimmedLines.map((line, idx) => ({ line, idx })).filter(({ line }) => line === 'uses: actions/upload-artifact@v4')
    expect(uploads).toHaveLength(1)
    const body = trimmedLines.slice(uploads[0].idx, uploads[0].idx + 8).join('\n')
    expect(body).toContain('name: PulseMind-win-x64-zip')
    expect(body).toContain('path: dist/*.zip')
    // 拼 ref_name 时分支名带 `/` 会让 upload 红
    expect(WORKFLOW).not.toMatch(/name:.*\$\{\{\s*github\.ref_name/)
  })

  it('Release 上传的是 dist/*.zip，且不再有 .exe', () => {
    const releaseLine = trimmedLines.find((line) => line.startsWith('gh release upload')) || ''
    expect(releaseLine).toMatch(/dist\/\*\.zip(\s|$)/)
    expect(releaseLine).not.toContain('.exe')
  })
})

describe('步骤顺序：打包 → 自检/冒烟 → 断言 → 压包 → 上传', () => {
  it('zip 在断言之后、上传之前（断言看的是 win-unpacked 那棵树）', () => {
    const at = (needle: string) => WORKFLOW.indexOf(needle)
    const pkg = at('- name: Package unpacked app')
    const verify = at('prune-packaged-assets.js --verify')
    const smoke = at('smoke-packed-chromium.js --app-out dist/win-unpacked --platform win32')
    const assert = at('- name: Assert packaged tree is usable')
    const zip = at('- name: Package unpacked zip')
    const upload = at('- name: Upload unpacked zip')
    for (const idx of [pkg, verify, smoke, assert, zip, upload]) expect(idx).toBeGreaterThanOrEqual(0)
    expect(verify).toBeGreaterThan(pkg)
    expect(smoke).toBeGreaterThan(verify)
    expect(assert).toBeGreaterThan(smoke)
    expect(zip).toBeGreaterThan(assert)
    expect(upload).toBeGreaterThan(zip)
  })
})
