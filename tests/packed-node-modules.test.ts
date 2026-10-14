// 打包 node_modules 完整性门禁 + 依赖树形态不变量（2026-10-14）。0.4.2 win
// portable 装机即崩：exceljs→archiver 要 archiver-utils@^2.1.0，archiver→
// zip-stream@4.1.1 要 ^3.0.4，而 electron-builder 25.1.8 的 node-dep-tree
// （Go 二进制）按物理解析路径 + semver 校验收集依赖 —— 构建树处于
// 「zip-stream 名下没有任何满足 ^3.0.4 的副本」的形态时，archiver-utils 被
// 静默整包丢弃，asar 内 require('exceljs') 直接 Cannot find module。三条腿
// 修复：lockfile 钉死「顶层 2.1.0 + zip-stream 下嵌套 3.0.4」形态（npm ci 可
// 复现）；mac/win 段 files 补正向模式防止 **/* 全捕获遍历（另一处把整仓源码
// 树打进 asar 的 packing bug，见 wiring 用例）；afterPack 的
// verify-packed-node-modules 门禁在 asar 内虚拟解析每个包的 dependencies，
// 解析不到就构建失败。exceljs 的 unzipper（0.10.14 vs markitdown-js 链的
// 0.12.5）跨大版本拉不平，属于残余冲突，交给门禁兜底。红线：不要用 npm
// overrides 拉平 zip 依赖族 —— Go 树读的是磁盘物理 package.json，声明范围
// 一旦无解就静默丢包（overrides→2.1.0 丢 zip-stream 的、→3.0.4 丢 archiver 的，
// 均实测）。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')
const { collectMissing, resolveVirtual, listPackageDirs } = createRequire(__filename)(
  '../scripts/verify-packed-node-modules.js'
)

// 造一个最小但真实的 asar 清单 + 包描述：entries 是 '/' 起头的清单路径，
// pkgs 是 虚拟路径 → package.json 片段。
function fixture (pkgs: Record<string, object>, extraEntries: string[] = []) {
  const entries = new Set<string>(extraEntries)
  const files = new Map<string, string>()
  for (const [dir, json] of Object.entries(pkgs)) {
    const pkgJsonPath = `${dir}/package.json`
    entries.add(pkgJsonPath)
    entries.add(dir)
    files.set(pkgJsonPath, JSON.stringify(json))
  }
  const readFile = (p: string) => files.get(p) ?? null
  return { entries: [...entries], readFile }
}

const EXCELJS_TREE_BROKEN = fixture({
  // 用户手里的 win asar 形状：archiver 自己的嵌套副本在、zip-stream 的缺席
  '/node_modules/sharp': {},
  '/node_modules/exceljs': {
    dependencies: { archiver: '^5.3.2', unzipper: '^0.10.11', saxes: '^6.0.0' },
  },
  '/node_modules/exceljs/node_modules/unzipper': {},
  '/node_modules/exceljs/node_modules/saxes': {},
  '/node_modules/archiver': {
    dependencies: { 'archiver-utils': '^2.1.0', 'zip-stream': '^4.1.1' },
  },
  '/node_modules/archiver/node_modules/archiver-utils': {},
  '/node_modules/zip-stream': {
    dependencies: { 'archiver-utils': '^3.0.4', 'compress-commons': '^4.1.0' },
  },
  '/node_modules/compress-commons': { dependencies: { 'crc-32': '^1.2.0' } },
  '/node_modules/crc-32': {},
})

const EXCELJS_TREE_NESTED_OK = fixture({
  // 修复前 mac asar 的形状：每份嵌套副本都在各自依赖者目录下（自洽）
  '/node_modules/sharp': {},
  '/node_modules/exceljs': {
    dependencies: { archiver: '^5.3.2', unzipper: '^0.10.11' },
  },
  '/node_modules/exceljs/node_modules/unzipper': { dependencies: { 'readable-stream': '^3.6.0' } },
  '/node_modules/archiver': {
    dependencies: { 'archiver-utils': '^2.1.0', 'zip-stream': '^4.1.1' },
  },
  '/node_modules/archiver/node_modules/archiver-utils': { dependencies: { 'readable-stream': '^2.0.0' } },
  '/node_modules/readable-stream': {},
  '/node_modules/zip-stream': {
    dependencies: { 'archiver-utils': '^3.0.4', 'compress-commons': '^4.1.0' },
  },
  '/node_modules/zip-stream/node_modules/archiver-utils': {},
  '/node_modules/compress-commons': {},
})

const EXCELJS_TREE_FLAT_OK = fixture({
  // overrides 之后的形状：archiver-utils 全树单一 2.1.0，zip-stream 沿祖先链
  // 解析到顶层；unzipper 的残余冲突保持嵌套形态（门禁可解析即放行）
  '/node_modules/sharp': {},
  '/node_modules/exceljs': {
    dependencies: { archiver: '^5.3.2', unzipper: '^0.10.11' },
  },
  '/node_modules/exceljs/node_modules/unzipper': {},
  '/node_modules/archiver': {
    dependencies: { 'archiver-utils': '^2.1.0', 'zip-stream': '^4.1.1' },
  },
  '/node_modules/zip-stream': {
    dependencies: { 'archiver-utils': '^2.1.0', 'compress-commons': '^4.1.0' },
  },
  '/node_modules/archiver-utils': {},
  '/node_modules/compress-commons': {},
})

describe('resolveVirtual — node 的逐级向上 node_modules 查找，虚拟版', () => {
  const has = (s: Set<string>) => (p: string) => s.has(p)

  it('prefers the nearest copy nested inside the requiring package', () => {
    const entries = new Set(['/node_modules/a/package.json', '/node_modules/a/node_modules/b/package.json'])
    expect(resolveVirtual('/node_modules/a', 'b', has(entries))).toBe('/node_modules/a/node_modules/b')
  })

  it('walks up to an ancestor node_modules when no local copy exists', () => {
    const entries = new Set(['/node_modules/a/package.json', '/node_modules/a/node_modules/c/package.json', '/node_modules/b/package.json'])
    expect(resolveVirtual('/node_modules/a/node_modules/c', 'b', has(entries))).toBe('/node_modules/b')
  })

  it('resolves from a top-level package straight to the top-level copy', () => {
    const entries = new Set(['/node_modules/zip-stream/package.json', '/node_modules/archiver-utils/package.json'])
    expect(resolveVirtual('/node_modules/zip-stream', 'archiver-utils', has(entries))).toBe('/node_modules/archiver-utils')
  })

  it('accepts single-file modules and bare directory entries', () => {
    const entries = new Set(['/node_modules/indexof.js', '/node_modules/dir-only'])
    expect(resolveVirtual('/node_modules/x', 'indexof', has(entries))).toBe('/node_modules/indexof.js')
    expect(resolveVirtual('/node_modules/x', 'dir-only', has(entries))).toBe('/node_modules/dir-only')
  })

  it('returns null when nothing resolves', () => {
    expect(resolveVirtual('/node_modules/zip-stream', 'archiver-utils', has(new Set(['/node_modules/zip-stream/package.json'])))).toBeNull()
  })
})

describe('listPackageDirs — 只有 node_modules 之下的 package.json 算包', () => {
  it('enumerates nested and scoped packages, skips the app root manifest', () => {
    const dirs = listPackageDirs([
      '/package.json',
      '/node_modules/exceljs/package.json',
      '/node_modules/exceljs/node_modules/unzipper/package.json',
      '/node_modules/@mozilla/readability/package.json',
      '/out/main/index.js',
    ])
    expect(dirs).toEqual([
      '/node_modules/@mozilla/readability',
      '/node_modules/exceljs',
      '/node_modules/exceljs/node_modules/unzipper',
    ])
  })
})

describe('collectMissing — 0.4.2 win 的丢件形状被抓，自洽形状放行', () => {
  const ROOT_DEPS = ['exceljs', 'sharp']

  it('non-vacuity: fixtures exercise real dependency edges', () => {
    // edges=0 意味着检查静默空转（比如包目录枚举坏了却谁也不报）——这里钉住它不为零
    const broken = collectMissing(EXCELJS_TREE_BROKEN.entries, EXCELJS_TREE_BROKEN.readFile, ROOT_DEPS)
    expect(broken.edges).toBeGreaterThan(0)
    expect(broken.packages).toBe(9)
  })

  it('the shipped win shape: zip-stream 的 archiver-utils 缺席被点名', () => {
    const { missing } = collectMissing(EXCELJS_TREE_BROKEN.entries, EXCELJS_TREE_BROKEN.readFile, ROOT_DEPS)
    expect(missing).toContainEqual({ from: '/node_modules/zip-stream', dep: 'archiver-utils' })
    expect(missing).not.toContainEqual({ from: '/node_modules/archiver', dep: 'archiver-utils' })
  })

  it('a root package dropped whole is caught via the root-deps list', () => {
    // playwright-core 不在这个夹具里 —— 清单内没有任何引用方能暴露它，只能靠根名单
    const { missing } = collectMissing(EXCELJS_TREE_BROKEN.entries, EXCELJS_TREE_BROKEN.readFile, ['exceljs', 'playwright-core'])
    expect(missing).toContainEqual({ from: '(app root)', dep: 'playwright-core' })
    expect(missing).not.toContainEqual({ from: '(app root)', dep: 'exceljs' })
  })

  it('the old mac shape (nested copies under each consumer) passes', () => {
    const { missing } = collectMissing(EXCELJS_TREE_NESTED_OK.entries, EXCELJS_TREE_NESTED_OK.readFile, ROOT_DEPS)
    expect(missing).toEqual([])
  })

  it('a flat shape (single top-level copy) also passes', () => {
    const { missing } = collectMissing(EXCELJS_TREE_FLAT_OK.entries, EXCELJS_TREE_FLAT_OK.readFile, ROOT_DEPS)
    expect(missing).toEqual([])
  })

  it('optionalDependencies 缺席合法；坏 package.json 记为缺失', () => {
    const entries = [
      '/node_modules/fsevents-consumer/package.json',
      '/node_modules/corrupted/package.json',
    ]
    const contents: Record<string, string> = {
      '/node_modules/fsevents-consumer/package.json': JSON.stringify({ optionalDependencies: { fsevents: '^2.3.2' } }),
      '/node_modules/corrupted/package.json': '{broken',
    }
    const { missing } = collectMissing(entries, (p: string) => contents[p] ?? null, [])
    expect(missing).toEqual([{ from: '/node_modules/corrupted', dep: '(package.json unreadable/unparseable)' }])
  })

  it('@types/* 纯类型依赖豁免 —— electron-builder 本就不拷它们（旧 mac asar 实测的假阳性类）', () => {
    const f = fixture({
      '/node_modules/@fast-csv/format': { dependencies: { '@types/node': '^20.0.0' } },
      '/node_modules/exiftool-vendored': { dependencies: { '@types/luxon': '^3.0.0' } },
    })
    const { missing } = collectMissing(f.entries, f.readFile, [])
    expect(missing).toEqual([])
  })
})

describe('wiring — 树形态不变量与 catch-all 守卫', () => {
  it('no overrides on the zip family — the Go node-dep-tree semver-checks against the PHYSICAL tree', () => {
    // 实测（2026-10-14）：overrides 把 archiver-utils 拉到 2.1.0 后，zip-stream 声明的
    // ^3.0.4 在磁盘上无解，electron-builder 的 node-dep-tree 静默整包丢弃 → asar 内
    // require('exceljs') 即崩；拉到 3.0.4 则轮到 archiver 的 ^2.1.0 被丢。立得住的
    // 形态是顶层 2.1.0 + zip-stream 下嵌套 3.0.4（lockfile + npm ci 保证）。
    const pkg = JSON.parse(read('package.json'))
    expect(pkg.overrides?.['archiver-utils']).toBeUndefined()
  })

  it('lockfile state Y: zip-stream keeps its own nested archiver-utils@3.0.4', () => {
    const lock = JSON.parse(read('package-lock.json'))
    expect(lock.packages['node_modules/zip-stream/node_modules/archiver-utils'].version).toBe('3.0.4')
    expect(lock.packages['node_modules/archiver-utils'].version).toBe('2.1.0')
  })

  it('mac/win 段 files 必须含正向模式 —— 全否定会触发 containsOnlyIgnore 的 **/* 全捕获遍历', () => {
    // 实测（2026-10-14）：全局字符串 files 被 normalizeFiles 归一成 {filter:[…]} 对象
    // matcher，平台段字符串进 defaultMatcher；后者全否定时自动补 **/*，整仓源码树
    // （src/tests/.codegraph/browsers…）作为第二个 fileSet 进 asar。
    const pkg = JSON.parse(read('package.json'))
    for (const platform of ['mac', 'win']) {
      const files = pkg.build[platform].files ?? []
      expect(files.some((p: string) => !p.startsWith('!')), `${platform}.files = ${JSON.stringify(files)}`).toBe(true)
    }
    expect(pkg.build.files).toContain('!.codegraph{,/**/*}')
  })

  it('afterPack routes through the orchestrator running strip-lproj AND the verifier', () => {
    const orchestrator = read('scripts/after-pack.js')
    expect(orchestrator).toContain("require('./strip-lproj')")
    expect(orchestrator).toContain("require('./verify-packed-node-modules')")
    expect(orchestrator).toContain('stripLproj.default(context)')
    expect(orchestrator).toContain('verifyPackedNodeModules(context)')
  })

  it('the verifier throws (not warns) so a bad pack fails the build', () => {
    const source = read('scripts/verify-packed-node-modules.js')
    expect(source).toContain('throw new Error(`[verify-packed-node-modules] packed node_modules is incomplete')
    expect(source).toContain('Object.keys(json.dependencies || {})')
  })
})
