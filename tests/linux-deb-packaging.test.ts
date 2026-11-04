// Linux .deb 打包链的钉子（2026-11-04，UOS 20 目标）。
//
// 这一层没有可单测的「产品逻辑」，能钉的是**契约**：包元数据必须够 deb 用、
// CI 的步骤顺序不能漂（Chromium 与原生模块两处静默失败都靠顺序兜）、以及
// glibc 门禁的退出码语义（空扫描不放行 / 超上限即红）。
//
// 背景：UOS 20 是 Debian 10 基线（glibc 2.28），而 better-sqlite3 是打包机上
// 现场编译的原生模块 —— 构建机 glibc ≥ 2.34 时产物会要求 GLIBC_2.34，装到
// 目标机是启动即 undefined symbol、构建期毫无提示。scripts/check-linux-glibc.js
// 是那道门，这里钉它，也钉 workflow 真的调它。

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
const requireCjs = createRequire(__filename)

const { glibcRequirementsOf, maxVersion, exceedsCeiling, collectNodeFiles, formatVersion } = requireCjs(
  '../scripts/check-linux-glibc.js',
)

const WORKFLOW = read('.github/workflows/build-linux.yml')
const ENSURE_CHROMIUM = read('scripts/ensure-chromium.js')
const PKG = JSON.parse(read('package.json')) as {
  author?: { name?: string; email?: string }
  build: { linux: { target: string[]; maintainer?: string } }
}

const tmpDirs: string[] = []
const tmpDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'pm-glibc-'))
  tmpDirs.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
})

describe('deb 包元数据：electron-builder 的二道门槛', () => {
  it('linux.target 至少含 deb（AppImage 在 UOS 上常缺 libfuse2，不是可替代品）', () => {
    expect(PKG.build.linux.target).toContain('deb')
  })

  it('maintainer 可从 author.email 推出（缺失时 electron-builder 直接报错退出）', () => {
    const email = PKG.build.linux.maintainer || PKG.author?.email
    expect(email, 'package.json 的 author.email 或 build.linux.maintainer 必须给一个').toBeTruthy()
    expect(String(email)).toMatch(/@/)
  })
})

describe('workflow 顺序契约：两处静默失败都靠顺序兜', () => {
  // 整行匹配，不用 indexOf —— 头部注释里也写着 `npx electron-builder --linux deb`，
  // 子串查找会命中注释、把「注释在步骤之前」当成「步骤在步骤之前」。
  const stepLine = (pattern: RegExp) => {
    const lines = WORKFLOW.split('\n')
    const index = lines.findIndex((line) => pattern.test(line.trim()))
    expect(index, `workflow 必须包含步骤：${pattern}`).toBeGreaterThan(-1)
    return index
  }

  it('Chromium 必须在 build 之前装（ensure-chromium 缺了只 warn，等于发一个没有内置浏览器的包）', () => {
    expect(stepLine(/^run: npm run browsers:install$/)).toBeLessThan(
      stepLine(/^run: npm run build$/),
    )
  })

  it('build 在打包之前，glibc 门禁在打包之后（要扫 linux-unpacked 才有对象）', () => {
    expect(stepLine(/^run: npm run build$/)).toBeLessThan(stepLine(/^run: npx electron-builder /))
    expect(stepLine(/^run: npx electron-builder /)).toBeLessThan(
      stepLine(/^run: node scripts\/check-linux-glibc\.js/),
    )
  })

  it('原生模块必须来自干净 npm ci —— 不得缓存 node_modules', () => {
    expect(WORKFLOW).toContain('npm ci')
    // actions/cache 的 path 里出现 node_modules 就违反了 afterPack 门禁的前提
    const cachePaths = WORKFLOW.split('\n').filter((line) => /^\s+path:/.test(line))
    for (const line of cachePaths) expect(line).not.toContain('node_modules')
  })

  it('构建容器必须是 glibc ≤ 2.31 的基线（2.34+ 编出来的 .node 要 GLIBC_2.34）', () => {
    expect(WORKFLOW).toMatch(/image:\s*node:20-(bullseye|buster)/)
  })

  it('不得在容器里跑 apt-get（bullseye 已 EOL：升级 ca-certificates 直接 404）', () => {
    // 2026-11-04 首次 CI 实测：apt-get install -y … ca-certificates 会升到一个
    // Debian 已经从 deb.debian.org 摘掉的路径，job 在 checkout 之前就红了。
    // 注释里当然可以讲这件事，所以只在可执行行上断言。
    const executable = WORKFLOW.split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(executable).not.toMatch(/apt-get\s+(update|install)/)
    // 工具链改为只做存在性断言：镜像瘦身要在这里明确报错，而不是在 node-gyp 深处
    expect(WORKFLOW).toContain('Verify build toolchain')
  })

  it('产物缺失要红（if-no-files-found: error），且门禁上限与目标机对齐 2.28', () => {
    expect(WORKFLOW).toContain('if-no-files-found: error')
    expect(WORKFLOW).toContain('--ceiling=2.28')
  })
})

describe('Chromium 取件：debian11 支持矩阵已被摘掉（2026-11-04 第二次实测）', () => {
  // playwright-core 1.63 的 registry 里 debian11-* 是 void 0，容器里直接
  // 「Playwright does not support chromium on debian11-x64」。而 debian12/13 与
  // ubuntu22/24 那几格指向同一个 linux64/chrome-linux64.zip —— override 只绕开
  // 一张支持性表格。
  it('必须把 host platform 覆写成 debian12-x64', () => {
    expect(WORKFLOW).toMatch(/PLAYWRIGHT_HOST_PLATFORM_OVERRIDE:\s*'debian12-x64'/)
  })

  it('覆写必须是 job 级 env —— ensure-chromium 在 build 步骤里还要用一次', () => {
    // 只设在 `Fetch bundled Chromium` 步骤上是个静默陷阱：npm run build 里的
    // ensure-chromium.js 用 executablePath() 走同一张表解析缓存路径，读不到
    // override 就拷不到浏览器，而它永不非零退出。
    const envAt = WORKFLOW.indexOf('PLAYWRIGHT_HOST_PLATFORM_OVERRIDE')
    const stepsAt = WORKFLOW.indexOf('\n    steps:')
    expect(envAt).toBeGreaterThan(-1)
    expect(stepsAt).toBeGreaterThan(-1)
    expect(envAt).toBeLessThan(stepsAt)
  })

  it('跳过宿主依赖校验（容器从不启动浏览器；补库走 apt，bullseye 已 EOL）', () => {
    expect(WORKFLOW).toMatch(/PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS:\s*'1'/)
  })

  it('浏览器没落下要红（ensure-chromium 永不非零退出，只有这一步能拦）', () => {
    expect(WORKFLOW).toContain('Verify bundled Chromium landed')
    // 这一步必须在 build 之后、打包之前：pre-build 时 resources/chromium 还不存在
    const lines = WORKFLOW.split('\n')
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line.trim()))
    expect(at(/^- name: Build bundles$/)).toBeLessThan(at(/^- name: Verify bundled Chromium landed$/))
    expect(at(/^- name: Verify bundled Chromium landed$/)).toBeLessThan(
      at(/^run: npx electron-builder /),
    )
  })

  // 这条与 Playwright 无关，是 ensure-chromium 自己的缝：它按解包目录名找 flavor，
  // 而 CFT 的 Linux 包解出来叫 chrome-linux64，ManagedBackend 只认 chrome-linux。
  it('ensure-chromium 认得 chrome-linux64 并归一化成 chrome-linux', () => {
    expect(ENSURE_CHROMIUM).toMatch(/'chrome-linux64'/)
    expect(ENSURE_CHROMIUM).toMatch(/'chrome-linux64':\s*'chrome-linux'/)
  })
})

describe('glibc 需求扫描：版本串比对与上限判定', () => {
  it('从原始字节里取出去重升序的版本清单（含三段 2.2.5）', () => {
    const buf = Buffer.from('junkGLIBC_2.34\0GLIBC_2.28\0GLIBC_2.2.5\0GLIBC_2.28\0', 'latin1')
    const versions = glibcRequirementsOf(buf)
    expect(versions.map(formatVersion)).toEqual(['2.2.5', '2.28', '2.34'])
  })

  it('2.2.5 小于 2.28（不能按字符串比）', () => {
    const versions = glibcRequirementsOf(Buffer.from('GLIBC_2.2.5\0GLIBC_2.28\0', 'latin1'))
    expect(formatVersion(maxVersion(versions))).toBe('2.28')
  })

  it('恰好等于上限不算超（UOS 20 自己就带 2.28）', () => {
    const versions = glibcRequirementsOf(Buffer.from('GLIBC_2.28\0', 'latin1'))
    expect(exceedsCeiling(versions, '2.28')).toBe(false)
    const newer = glibcRequirementsOf(Buffer.from('GLIBC_2.34\0', 'latin1'))
    expect(exceedsCeiling(newer, '2.28')).toBe(true)
  })

  it('没有 glibc 引用（静态链接）不算违规', () => {
    expect(exceedsCeiling(glibcRequirementsOf(Buffer.from('no symbols here', 'latin1')), '2.28')).toBe(
      false,
    )
  })

  it('递归收集 .node，不误收其它文件', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'a.node'), 'x')
    writeFileSync(join(dir, 'not-a-module.so'), 'x')
    expect(collectNodeFiles(dir)).toEqual([join(dir, 'a.node')])
  })
})

describe('门禁退出码：空扫描不放行', () => {
  const run = (dir: string, ceiling = '2.28') =>
    spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/check-linux-glibc.js'), dir, `--ceiling=${ceiling}`],
      { encoding: 'utf-8' },
    )

  it('目录里没有 .node → 2（否则没打包也会绿）', () => {
    expect(run(tmpDir()).status).toBe(2)
  })

  it('全部达标 → 0；任一超上限 → 1', () => {
    const ok = tmpDir()
    writeFileSync(join(ok, 'ok.node'), 'GLIBC_2.28\0', 'latin1')
    expect(run(ok).status).toBe(0)

    const bad = tmpDir()
    writeFileSync(join(bad, 'bad.node'), 'GLIBC_2.34\0', 'latin1')
    expect(run(bad).status).toBe(1)
  })
})
