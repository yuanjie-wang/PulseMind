// Linux 打包链的钉子（2026-11-04 立，UOS 20 目标；2026-11-24 交付收成 tarball 单形态）。
//
// 这一层没有可单测的「产品逻辑」，能钉的是**契约**：产物形态只有 dir/tarball、
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

const { glibcRequirementsOf, glibcxxRequirementsOf, maxVersion, exceedsCeiling, collectNodeFiles, formatVersion } = requireCjs(
  '../scripts/check-linux-glibc.js',
)

const WORKFLOW = read('.github/workflows/build-linux.yml')
const ENSURE_CHROMIUM = read('scripts/ensure-chromium.js')
const PKG = JSON.parse(read('package.json')) as {
  author?: { name?: string; email?: string }
  build: { linux: { target: string[] } & Record<string, unknown> }
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

describe('产物形态：只有 dir（2026-11-24 用户裁定，Linux 只要 tarball 不要 deb）', () => {
  it('linux.target 恰为 dir —— 不产任何安装器', () => {
    expect(PKG.build.linux.target).toEqual(['dir'])
    // 理由都在历史里：deb 要 root（UOS 目标机普通用户没有）、AppImage 常缺 libfuse2。
    // 唯一交付物是免 root tar.gz，它直接吃 linux-unpacked。
    for (const banned of ['deb', 'rpm', 'appimage']) {
      expect(PKG.build.linux.target).not.toContain(banned)
    }
  })

  it('deb 专属元数据已退役（synopsis/description/artifactName 曾经只为安装器存在）', () => {
    const linux = PKG.build.linux
    expect(linux.synopsis).toBeUndefined()
    expect(linux.description).toBeUndefined()
    expect(linux.artifactName).toBeUndefined()
  })

  it('workflow 里没有任何可执行的 deb 路径（deb 只剩解释性注释）', () => {
    const executable = WORKFLOW.split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(executable).not.toMatch(/--linux deb/)
    expect(executable).not.toMatch(/dist\/\*\.deb/)
    expect(executable).not.toContain('pulsemind-deb-x64')
    expect(executable).not.toMatch(/\bdpkg\b/)
    // 打包步骤只剩 dir 这一条
    const runs = WORKFLOW.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('run: npx electron-builder'))
    expect(runs).toEqual(['run: npx electron-builder --linux dir --x64 --publish never'])
  })
})

describe('workflow 顺序契约：两处静默失败都靠顺序兜', () => {
  // 整行匹配，不用 indexOf —— 头部注释里也写着 `npx electron-builder --linux dir`，
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

  it('收集 .node 与随包引擎 .so（PLAN-voice-input M3），不误收其它文件', () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'a.node'), 'x')
    writeFileSync(join(dir, 'libsherpa-onnx-c-api.so'), 'x')
    writeFileSync(join(dir, 'libonnxruntime.so'), 'x')
    writeFileSync(join(dir, 'not-a-module.dll'), 'x')
    writeFileSync(join(dir, 'readme.txt'), 'x')
    expect(collectNodeFiles(dir)).toEqual([join(dir, 'a.node'), join(dir, 'libonnxruntime.so'), join(dir, 'libsherpa-onnx-c-api.so')])
  })
})

describe('门禁退出码：空扫描不放行', () => {
  const run = (dir: string, ceiling = '2.28', cxxCeiling?: string) =>
    spawnSync(
      process.execPath,
      [
        join(ROOT, 'scripts/check-linux-glibc.js'),
        dir,
        `--ceiling=${ceiling}`,
        ...(cxxCeiling ? [`--glibcxx-ceiling=${cxxCeiling}`] : []),
      ],
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

  // 2026-11-23：官方 sherpa-onnx linux 平台包（1.12.40）glibc 只有 2.16，却要
  // GLIBCXX_3.4.29 —— 只量 glibc 的门禁会放行一个「装机 dlopen 报 version not
  // found」的包。这条组钉住第二条轴，别让下一个人再把它当成同一条需求。
  it('libstdc++ 是独立的一条轴：只超 GLIBCXX 也要红', () => {
    const ok = tmpDir()
    writeFileSync(join(ok, 'ok.node'), 'GLIBC_2.16\0GLIBCXX_3.4.21\0', 'latin1')
    expect(run(ok).status).toBe(0)

    // 1.12.40 的 sherpa-onnx.node 就是这个形态：glibc 很低、libstdc++ 很高
    const bad = tmpDir()
    writeFileSync(join(bad, 'sherpa-onnx.node'), 'GLIBC_2.16\0GLIBCXX_3.4.29\0', 'latin1')
    expect(run(bad).status).toBe(1)

    // 口径可调：换一个明确支持 GCC 11 的基线时，同一条目不该再红
    expect(run(bad, '2.28', '3.4.30').status).toBe(0)
  })

  it('GLIBCXX 解析不吃 GLIBC_ 的版本串', () => {
    const parsed = glibcxxRequirementsOf(Buffer.from('GLIBC_2.28\0GLIBCXX_3.4.9\0GLIBCXX_3.4.29\0', 'latin1'))
    expect(parsed).toEqual([
      [3, 4, 9],
      [3, 4, 29],
    ])
    // GLIBCXX_DEBUG 之类不是版本需求，别当成 0.0
    expect(glibcxxRequirementsOf(Buffer.from('GLIBCXX_DEBUG\0', 'latin1'))).toEqual([])
  })

  it('Chromium 是被豁免的第三方件：超限只告警、不影响退出码', () => {
    const dir = tmpDir()
    const chrome = join(dir, 'resources', 'chromium', 'chrome-linux')
    mkdirSync(chrome, { recursive: true })
    writeFileSync(join(chrome, 'libGLESv2.so'), 'GLIBCXX_3.4.33\0', 'latin1')
    expect(run(dir).status).toBe(0)
  })

  it('workflow 把两条上限都显式交给门禁（口径可审，不靠默认值）', () => {
    expect(WORKFLOW).toContain('--ceiling=2.28')
    expect(WORKFLOW).toContain('--glibcxx-ceiling=3.4.25')
  })
})

// 2026-11-23 方案 ①：随包私有 C++ 运行库。
//
// 引擎（1.12.40）要 GLIBCXX_3.4.29，UOS 20 的系统 libstdc++ 只到 3.4.25。往包里
// 塞一份**同名**的 libstdc++.so.6 是无效的——glibc 的 _dl_lookup_map 见到 SONAME
// 相同就直接复用已加载对象（进程里几乎必然已有一份），随包副本永远不会被打开。
// 所以副本改名 libpmcxx.so.6，引擎的 DT_NEEDED 一起改过去。
//
// 门禁因此需要一层新语义：提供方在场时，**同目录**文件的上限由提供方实测能力
// 决定，而不是系统上限——否则方案 ① 落地后门禁会永远红，红得没意义。但抬上限
// 的前提是「确实在用随包副本」，所以残留旧 NEEDED 一律判红。
describe('私有 C++ 运行库 libpmcxx.so.6（方案 ①）', () => {
  const run = (dir: string) =>
    spawnSync(
      process.execPath,
      [join(ROOT, 'scripts/check-linux-glibc.js'), dir, '--ceiling=2.28', '--glibcxx-ceiling=3.4.25'],
      { encoding: 'utf-8' },
    )
  const engineDir = (root: string) => {
    const dir = join(root, 'resources', 'asr-engine', 'linux-x64')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const write = (dir: string, name: string, ascii: string) => writeFileSync(join(dir, name), ascii, 'latin1')

  it('提供方在场 → 引擎的 3.4.29 不再红（上限抬到提供方实测能力）', () => {
    const dir = tmpDir()
    const e = engineDir(dir)
    write(e, 'sherpa-onnx.node', 'GLIBC_2.16\0GLIBCXX_3.4.29\0libpmcxx.so.6\0')
    write(e, 'libpmcxx.so.6', 'GLIBC_2.17\0GLIBCXX_3.4.30\0')
    const out = run(dir)
    expect(out.status, out.stderr).toBe(0)
    // 抬高的依据要写在表里，否则「为什么这条 3.4.29 能过」无从审
    expect(out.stdout).toContain('limit 3.4.30')
    expect(out.stdout).toContain('provides')
  })

  it('残留 libstdc++.so.6 的 NEEDED → 红（私有副本会被 SONAME 去重，根本打不开）', () => {
    const dir = tmpDir()
    const e = engineDir(dir)
    write(e, 'sherpa-onnx.node', 'GLIBC_2.16\0GLIBCXX_3.4.29\0libstdc++.so.6\0')
    write(e, 'libpmcxx.so.6', 'GLIBC_2.17\0GLIBCXX_3.4.30\0')
    const out = run(dir)
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('libstdc++.so.6')
    // 这时提供的上限不该被抬高（还在用系统的），所以不能提示「只提供到 3.4.30」之外的鬼话
    expect(out.stderr).not.toContain('私有运行库只提供到 3.4.30')
  })

  it('提供方自身 glibc 超限 → 红（等于把失败从引擎搬到运行库身上）', () => {
    const dir = tmpDir()
    const e = engineDir(dir)
    write(e, 'sherpa-onnx.node', 'GLIBC_2.16\0GLIBCXX_3.4.29\0libpmcxx.so.6\0')
    // Ubuntu jammy 的 libstdc++.so.6.0.30 就是这种形态：自身要 GLIBC_2.34
    write(e, 'libpmcxx.so.6', 'GLIBC_2.34\0GLIBCXX_3.4.30\0')
    const out = run(dir)
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('libpmcxx.so.6 -> GLIBC_2.34')
  })

  it('提供方提供不足 → 红，原因指向提供方而不是系统上限', () => {
    const dir = tmpDir()
    const e = engineDir(dir)
    write(e, 'sherpa-onnx.node', 'GLIBC_2.16\0GLIBCXX_3.4.29\0libpmcxx.so.6\0')
    write(e, 'libpmcxx.so.6', 'GLIBC_2.17\0GLIBCXX_3.4.25\0')
    const out = run(dir)
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('私有运行库只提供到 3.4.25')
  })

  it('没有提供方的目录照旧按系统上限判（别把「抬高」写成无条件豁免）', () => {
    const dir = tmpDir()
    const e = engineDir(dir)
    write(e, 'sherpa-onnx.node', 'GLIBC_2.16\0GLIBCXX_3.4.29\0')
    const out = run(dir)
    expect(out.status).toBe(1)
    expect(out.stderr).toContain('GLIBCXX_3.4.29')
    expect(out.stderr).not.toContain('私有运行库')
  })

  it('提供方不被 Chromium 那种第三方豁免顺带放过', () => {
    const dir = tmpDir()
    const e = engineDir(dir)
    write(e, 'sherpa-onnx.node', 'GLIBC_2.16\0GLIBCXX_3.4.29\0libpmcxx.so.6\0')
    write(e, 'libpmcxx.so.6', 'GLIBC_2.34\0GLIBCXX_3.4.30\0')
    // 只 warn 不判红的只有 chromium；这份是我们自己决定随包的，该红就红
    expect(run(dir).status).toBe(1)
  })
})

// 2026-11-10：UOS 目标机的普通用户没有 root，`dpkg -i` 直接不可用；而且使用人
// 不一定用命令行。交付因此是 tar.gz 免安装包——解压得到一个文件夹，双击
// install.sh 装、双击 uninstall.sh 卸。2026-11-24 起它是**唯一**交付形态
// （deb 那两条腿收掉了）。这条链的失败全是静默的（tar 里少一个文件、文件撒到
// 解压目录外、安装器写到系统目录、卸载留下桌面入口），所以既钉 workflow 契约，
// 也真跑一遍安装器。
describe('免 root tar.gz：唯一交付形态（2026-11-10 立，2026-11-24 收成单形态）', () => {
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
    // 恰好两处：一处 upload（打包 job）、一处 download（发布 job）。
    // 多处一个 upload 就是 v4 的 duplicate artifact name，构建在最后一步红掉。
    expect(WORKFLOW.match(/name: pulsemind-linux-x64-tarball/g)).toHaveLength(2)
    // 固定名不能拼 ref_name：分支名带 / 会让 upload-artifact 直接红
    expect(WORKFLOW).not.toMatch(/name:.*\$\{\{\s*github\.ref_name/)
    // Release 只传 tar.gz —— 这是唯一产物，漏了就什么都没发
    const releaseLine =
      WORKFLOW.split('\n').find((line) => /^\s*gh release upload/.test(line)) || ''
    expect(releaseLine).toMatch(/dist\/\*\.tar\.gz(\s|$)/)
    expect(releaseLine).not.toContain('.deb')
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
    // 双击运行时 stderr 不是终端：失败必须弹通知，否则「一闪而过」无从诊断
    expect(INSTALLER).toContain('notify-send "PulseMind 安装未完成"')
    expect(INSTALLER).toMatch(/\[ ! -t 2 \]/)
    expect(INSTALLER).toMatch(/command -v notify-send/)
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
        env: { ...process.env, HOME: home, XDG_DATA_HOME: '', XDG_CONFIG_HOME: '', DISPLAY: '', WAYLAND_DISPLAY: '' },
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

      // 应用内「开机自启」的落点（src/main/utils/autostart.ts 同路径）。
      // 卸载不删它的话，下次登录会拉起一个已经被删掉的可执行文件。
      const autostart = join(home, '.config', 'autostart', 'pulsemind.desktop')
      mkdirSync(join(home, '.config', 'autostart'), { recursive: true })
      writeFileSync(autostart, '[Desktop Entry]\nType=Application\n')

      // 走使用者会双击的那个入口
      const uninstall = runScript(pkg, home, 'uninstall.sh')
      expect(uninstall.status, uninstall.stderr).toBe(0)
      expect(existsSync(app)).toBe(false)
      expect(existsSync(desktop)).toBe(false)
      expect(existsSync(icon)).toBe(false)
      expect(existsSync(autostart)).toBe(false)
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
