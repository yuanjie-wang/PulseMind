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
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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

  it('容器基线 node:20-bullseye，但编译器必须是 zig（经包装脚本）且钉符号下限 2.28', () => {
    // 四轮 CI 实测（2026-11-04/05）：容器自身编译要么符号超 2.28（bullseye 官方
    // prebuild 要 2.29），要么 g++ 8.3 认不得 better-sqlite3 12.9 的 -std=c++20
    //（buster）。zig 的 -target glibc 后缀精确钉符号下限，clang 又吃得下 C++20。
    expect(WORKFLOW).toMatch(/image:\s*node:20-bullseye/)
    expect(WORKFLOW).toMatch(/CC:\s*\/opt\/zig\/bin\/zig-cc cc -target x86_64-linux-gnu\.2\.28/)
    expect(WORKFLOW).toMatch(/CXX:\s*\/opt\/zig\/bin\/zig-cc c\+\+ -target x86_64-linux-gnu\.2\.28/)
  })

  it('zig（含包装脚本）装在 checkout 之后、npm ci 之前', () => {
    const lines = WORKFLOW.split('\n')
    const zigAt = lines.findIndex((line) => line.includes('zig-linux-x86_64'))
    const checkoutAt = lines.findIndex((line) => line.includes('actions/checkout@v4'))
    const npmCiAt = lines.findIndex((line) => line.trim() === 'npm ci')
    expect(zigAt).toBeGreaterThan(-1)
    expect(npmCiAt).toBeGreaterThan(-1)
    // 包装脚本从仓库装（zig-linux-x86_64 那一行在 run 块里，必然晚于 checkout）
    expect(checkoutAt).toBeLessThan(zigAt)
    expect(zigAt).toBeLessThan(npmCiAt)
    expect(WORKFLOW).toContain('GITHUB_PATH')
  })

  it('zig 包装脚本滤掉 zig 不支持的 --exclude-libs，其余参数原样透传', () => {
    // zig 的 lld 封装把不认识的链接参数变成硬错误（ziglang/zig#15113 仍 open），
    // 而 better-sqlite3 的 binding.gyp 带 -Wl,--exclude-libs,ALL。-Bsymbolic 在
    // zig 0.13.0 的白名单里，必须原样保留。
    const out = spawnSync(
      'sh',
      [
        join(ROOT, 'scripts/zig-cc-wrapper.sh'),
        'cc',
        '-Wl,-Bsymbolic',
        '-Wl,--exclude-libs,ALL',
        '--exclude-libs,ALL',
        '-o',
        'a.out',
      ],
      { env: { ...process.env, ZIG_BIN: 'echo' }, encoding: 'utf-8' },
    )
    expect(out.status).toBe(0)
    expect(out.stdout.trim()).toBe('cc -Wl,-Bsymbolic -o a.out')
  })

  it('官方 prebuild 一律不装（它们是 GLIBC_2.29 的新 glibc 构建，electron 路径还不校验）', () => {
    // better-sqlite3 发有 electron-v130 linux-x64 prebuild，@electron/rebuild 的
    // prebuild 路径不做加载校验 —— 不挡住它，编译机 glibc 根本没机会决定产物。
    // npm_config_build_from_source=true 让 prebuild-install 在下载之前就退出
    //（bin.js 的 buildFromSource 短路），两条调用路径都落到 node-gyp。
    expect(WORKFLOW).toMatch(/npm_config_build_from_source:\s*'true'/)
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

// 2026-11-10：UOS 目标机的普通用户没有 root，`dpkg -i` 直接不可用；而且使用人
// 不一定用命令行。交付因此变成两条腿：deb 给有 root 的机器，tar.gz 免安装包给
// 普通用户——解压得到一个文件夹，双击 install.sh 装、双击 uninstall.sh 卸。
// 这条链的失败全是静默的（tar 里少一个文件、文件撒到解压目录外、安装器写到系统
// 目录、卸载留下桌面入口），所以既钉 workflow 契约，也真跑一遍安装器。
describe('免 root tar.gz：普通用户的落地方式（2026-11-10）', () => {
  const INSTALLER_PATH = join(ROOT, 'scripts/install-linux-noroot.sh')
  const UNINSTALLER_PATH = join(ROOT, 'scripts/install-linux-uninstall.sh')
  const README_PATH = join(ROOT, 'scripts/install-linux-readme.txt')
  const INSTALLER = read('scripts/install-linux-noroot.sh')
  const UNINSTALLER = read('scripts/install-linux-uninstall.sh')
  const README = read('scripts/install-linux-readme.txt')
  const executableOf = (text: string) =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')

  it('workflow 在门禁之后产 tarball：单顶层文件夹 + 双击三件套', () => {
    const lines = WORKFLOW.split('\n')
    const at = (pattern: RegExp) => lines.findIndex((line) => pattern.test(line.trim()))
    const packAt = at(/^- name: Package no-root tarball$/)
    const smokeAt = at(/^- name: Smoke no-root installer$/)
    expect(packAt).toBeGreaterThan(-1)
    expect(smokeAt).toBeGreaterThan(packAt)
    // 只打已过 glibc 门禁的那棵树，不另编一份
    expect(at(/^run: node scripts\/check-linux-glibc\.js/)).toBeLessThan(packAt)

    // 包内五件：应用目录 + 两个双击入口 + 中文说明 + 图标
    expect(WORKFLOW).toContain('cp -a dist/linux-unpacked "$stage/PulseMind"')
    expect(WORKFLOW).toContain('cp scripts/install-linux-noroot.sh "$stage/install.sh"')
    expect(WORKFLOW).toContain('cp scripts/install-linux-uninstall.sh "$stage/uninstall.sh"')
    expect(WORKFLOW).toContain('cp scripts/install-linux-readme.txt "$stage/安装说明.txt"')
    expect(WORKFLOW).toContain('cp resources/icons-linux/256x256.png "$stage/icon.png"')
    expect(WORKFLOW).toContain('chmod 755 "$stage/install.sh" "$stage/uninstall.sh"')

    // 一个顶层文件夹再压：解压只得到一个目录，四个文件不会撒进「下载」
    expect(WORKFLOW).toMatch(
      /tar -czf "\$\{stage\}\.tar\.gz" -C dist "PulseMind-\$\{version\}-linux-x64"/,
    )
  })

  it('冒烟用临时 HOME 真装真卸（tar 缺文件 / 装错地方只有这一步能抓）', () => {
    // 解压必须只有一个顶层条目 —— 双击安装的前提
    expect(WORKFLOW).toContain('test "$(find "$work" -maxdepth 1 -mindepth 1 | wc -l)" -eq 1')
    expect(WORKFLOW).toContain('test -f "$pkg/uninstall.sh"')
    expect(WORKFLOW).toContain('test -f "$pkg/安装说明.txt"')
    expect(WORKFLOW).toContain('sh "$pkg/install.sh" --no-launch')
    // 卸载走使用者会点的那条路，而不是 install.sh 本身
    expect(WORKFLOW).toContain('sh "$pkg/uninstall.sh"')
    // 三件事各一条：装到哪、桌面入口指向哪、卸完剩什么
    expect(WORKFLOW).toContain('test -x "$appdir/pulsemind"')
    expect(WORKFLOW).toContain('grep -Fq "Exec=\\"$appdir/pulsemind\\"" "$desktop"')
    expect(WORKFLOW).toContain('test ! -e "$appdir"')
  })

  it('artifact 用固定名单独上传，release job 同步带上 tar.gz', () => {
    expect(WORKFLOW).toContain('name: pulsemind-linux-x64-tarball')
    expect(WORKFLOW).toContain('path: dist/*.tar.gz')
    // 只传 deb 会让手动发 Release 这条路径悄悄少一份产物
    expect(WORKFLOW).toMatch(/gh release upload "\$TAG" dist\/\*\.deb dist\/\*\.tar\.gz/)
  })

  it('安装器不碰系统目录、不调 sudo（普通用户才跑得动）', () => {
    for (const text of [executableOf(INSTALLER), executableOf(UNINSTALLER)]) {
      expect(text).not.toMatch(/\bsudo\b/)
      expect(text).not.toMatch(/\/opt\//)
      expect(text).not.toMatch(/\bapt(-get)?\b/)
    }
    // 应用与桌面集成都落在用户可写的两处根下
    expect(INSTALLER).toContain('${PULSEMIND_HOME:-$HOME/Applications}')
    expect(INSTALLER).toContain('${XDG_DATA_HOME:-$HOME/.local/share}')
  })

  it('双击形态：装完自动启动，但只限图形会话，且 --no-launch 能关', () => {
    // 使用人不会自己去菜单里找应用：装完拉起来才叫「装好了」
    expect(INSTALLER).toContain('DISPLAY:-}${WAYLAND_DISPLAY')
    expect(INSTALLER).toMatch(/setsid "\$INSTALL_DIR\/pulsemind"/)
    expect(INSTALLER).toMatch(/--no-launch\) LAUNCH=0/)
    // 卸载走不到启动分支（exit 0 在它前面）
    const uninstallExit = INSTALLER.indexOf('用户数据（~/.pulsemind）未改动')
    const launchBlock = INSTALLER.indexOf('if [ "$LAUNCH" = 1 ]')
    expect(uninstallExit).toBeGreaterThan(-1)
    expect(uninstallExit).toBeLessThan(launchBlock)
    // 卸载入口只是转调，且经 sh 调用（执行位在 U 盘上可能丢）
    expect(UNINSTALLER).toContain('exec sh "$INSTALLER" --uninstall')
  })

  it('说明文件是给非命令行用户看的：双击、允许执行、数据位置都在', () => {
    expect(README).toContain('双击 install.sh')
    expect(README).toContain('允许作为程序执行')
    expect(README).toContain('~/.pulsemind')
    expect(README).toContain('uninstall.sh')
    expect(README).toContain('Applications/PulseMind')
  })

  it('关掉 userns 的机器回落 --no-sandbox（UOS 加固策略下的唯一启动姿势）', () => {
    expect(INSTALLER).toContain('kernel.unprivileged_userns_clone')
    expect(INSTALLER).toContain('kernel.apparmor_restrict_unprivileged_userns')
    expect(INSTALLER).toMatch(/unshare -U true/)
    expect(INSTALLER).toContain('--no-sandbox')
  })

  it('sh 语法合法（UOS 上就是 dash，不是 bash 子集之外的方言）', () => {
    for (const path of [INSTALLER_PATH, UNINSTALLER_PATH]) {
      const out = spawnSync('sh', ['-n', path], { encoding: 'utf-8' })
      expect(out.status, out.stderr).toBe(0)
    }
  })

  describe.skipIf(process.platform === 'win32')('真跑一遍安装器', () => {
    const makePkg = () => {
      const base = tmpDir()
      const pkg = join(base, 'PulseMind-9.9.9-linux-x64')
      mkdirSync(join(pkg, 'PulseMind', 'resources'), { recursive: true })
      writeFileSync(join(pkg, 'PulseMind', 'pulsemind'), '#!/bin/sh\nexit 0\n')
      chmodSync(join(pkg, 'PulseMind', 'pulsemind'), 0o755)
      writeFileSync(join(pkg, 'icon.png'), 'png')
      copyFileSync(INSTALLER_PATH, join(pkg, 'install.sh'))
      copyFileSync(UNINSTALLER_PATH, join(pkg, 'uninstall.sh'))
      copyFileSync(README_PATH, join(pkg, '安装说明.txt'))
      const home = join(base, 'home')
      mkdirSync(home, { recursive: true })
      return { base, pkg, home }
    }
    const runScript = (pkg: string, home: string, script: string, args: string[] = []) =>
      spawnSync('sh', [join(pkg, script), ...args], {
        cwd: pkg,
        env: { ...process.env, HOME: home, XDG_DATA_HOME: '', DISPLAY: '', WAYLAND_DISPLAY: '' },
        encoding: 'utf-8',
      })
    const runInstall = (pkg: string, home: string, args: string[] = []) =>
      runScript(pkg, home, 'install.sh', ['--no-launch', ...args])

    it('默认装到 ~/Applications/PulseMind，桌面入口与图标进 ~/.local，卸载清干净', () => {
      const { pkg, home } = makePkg()
      const app = join(home, 'Applications', 'PulseMind')
      const desktop = join(home, '.local', 'share', 'applications', 'pulsemind.desktop')
      const icon = join(home, '.local', 'share', 'icons', 'hicolor', '256x256', 'apps', 'pulsemind.png')

      const install = runInstall(pkg, home)
      expect(install.status, install.stderr).toBe(0)
      expect(existsSync(join(app, 'resources'))).toBe(true)
      expect(statSync(join(app, 'pulsemind')).mode & 0o111).not.toBe(0)
      const entry = readFileSync(desktop, 'utf-8')
      expect(entry).toContain(`Exec="${join(app, 'pulsemind')}"`)
      expect(entry).toContain('StartupWMClass=PulseMind')
      expect(existsSync(icon)).toBe(true)

      // 卸载不得动用户数据 —— 与安装位置无关的那一份
      const dataFile = join(home, '.pulsemind', 'settings.json')
      mkdirSync(join(home, '.pulsemind'), { recursive: true })
      writeFileSync(dataFile, '{}')

      // 走使用者会双击的那个入口
      const uninstall = runScript(pkg, home, 'uninstall.sh')
      expect(uninstall.status, uninstall.stderr).toBe(0)
      expect(existsSync(app)).toBe(false)
      expect(existsSync(desktop)).toBe(false)
      expect(existsSync(icon)).toBe(false)
      expect(existsSync(dataFile)).toBe(true)
      // 卸载不删解压目录本身（用户可能还要重装）
      expect(existsSync(join(pkg, 'install.sh'))).toBe(true)
    })

    it('--dir 装到指定目录；--no-desktop 不写桌面入口', () => {
      const { base, pkg, home } = makePkg()
      const app = join(base, 'custom', 'pm')
      const out = runInstall(pkg, home, ['--dir', app, '--no-desktop'])
      expect(out.status, out.stderr).toBe(0)
      expect(existsSync(join(app, 'pulsemind'))).toBe(true)
      expect(existsSync(join(home, '.local', 'share', 'applications', 'pulsemind.desktop'))).toBe(false)
    })

    it('没有图形会话时不尝试启动，只提示（CI / ssh 里不留后台进程）', () => {
      const { pkg, home } = makePkg()
      // 不传 --no-launch，靠 DISPLAY/WAYLAND_DISPLAY 空来自证守卫生效
      const out = runScript(pkg, home, 'install.sh')
      expect(out.status, out.stderr).toBe(0)
      expect(out.stdout).toContain('未自动启动')
      expect(existsSync(join(home, 'Applications', 'PulseMind', 'pulsemind'))).toBe(true)
    })

    it('拒绝把 / 或家目录本身当安装/卸载目标，反解到别处的 desktop 也不删', () => {
      const { base, pkg, home } = makePkg()
      expect(runInstall(pkg, home, ['--dir', '/']).status).not.toBe(0)
      expect(runInstall(pkg, home, ['--uninstall', '--dir', '/']).status).not.toBe(0)
      expect(runInstall(pkg, home, ['--dir', home]).status).not.toBe(0)

      // 手写的 desktop 指向家目录之外：反解出来的路径不得被当作删除目标
      const outside = join(base, 'outside', 'app')
      mkdirSync(outside, { recursive: true })
      writeFileSync(join(outside, 'pulsemind'), 'x')
      mkdirSync(join(home, '.local', 'share', 'applications'), { recursive: true })
      writeFileSync(
        join(home, '.local', 'share', 'applications', 'pulsemind.desktop'),
        `[Desktop Entry]\nExec="${join(outside, 'pulsemind')}" %U\n`,
      )
      expect(runInstall(pkg, home, ['--uninstall']).status).not.toBe(0)
      expect(existsSync(outside)).toBe(true)
    })
  })
})
