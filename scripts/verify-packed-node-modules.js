'use strict'

// afterPack 门禁：app.asar 里的 node_modules 必须自洽 —— 清单里每一个包的
// runtime dependencies 都要在 asar 的虚拟解析路径上找到目标包。
//
// 背景（2026-10-14，0.4.2 win portable 实测）：electron-builder 25.1.8 的
// node-dep-tree（Go 二进制）按「物理嵌套形态」收集版本冲突依赖 —— npm 的
// hoisting 形态不同，某个嵌套副本就可能整包缺席。win 包的
// zip-stream → archiver-utils 正是这样丢的：exceljs→archiver 要 2.1.0（顶层），
// zip-stream 要 3.0.4（嵌套），构建机上 hoisting 翻转后收集器把嵌套那份漏掉，
// 用户侧打包后 require('exceljs') 直接 Cannot find module。
// 修复分两层：lockfile 钉死自洽形态（npm ci 可复现：顶层 archiver-utils@2.1.0
// + zip-stream 名下嵌套 3.0.4，tests/packed-node-modules.test.ts 的 state-Y
// 用例钉住），本门禁把残余冲突（exceljs 的 unzipper 0.10/0.12 无法拉平）等
// 任何同类丢件变成构建失败而不是用户运行时崩溃。
// 红线：不要用 package.json overrides 把这族依赖拉平 —— Go 树读的是磁盘上的
// 物理 package.json，overrides 对它不可见；实测拉到 2.1.0 丢 zip-stream 的、
// 拉到 3.0.4 丢 archiver 的，两头都是同样的静默丢件（该方案已被否决，
// wiring 用例钉住 overrides 必须不在场）。
//
// 纯逻辑（resolveVirtual / listPackageDirs / collectMissing）由
// tests/packed-node-modules.test.ts 直测；本文件同时是 afterPack 的入口，
// 经 scripts/after-pack.js 调用。

const { dirname, join } = require('node:path')
const { existsSync, readFileSync } = require('node:fs')

const NODE_MODULES = 'node_modules'
// 纯类型依赖（@types/*）：运行时从不可 require，electron-builder 的
// node-dep-tree 也不拷它们（@fast-csv/docx/pptxgenjs/exiftool-vendored 都把
// @types/node 声明进了 runtime dependencies —— 旧 mac asar 实测的假阳性类）。
const TYPE_ONLY_DEP = /^@types\//

// 从 asar 清单里枚举所有包目录：清单条目形如 '/node_modules/foo/package.json'
//（'/' 起头、posix 分隔；scoped 包是 '/node_modules/@scope/pkg/…'）。
// 只认位于某层 node_modules 之下的 package.json —— 应用自己的根 package.json 不算包。
function listPackageDirs (entries) {
  const dirs = new Set()
  for (const entry of entries) {
    if (!entry.endsWith('/package.json')) continue
    if (entry.split('/').includes(NODE_MODULES)) dirs.add(dirname(entry))
  }
  return [...dirs].sort()
}

// node 的逐级向上 node_modules 查找的虚拟版：fromDir 起沿祖先链找
// `<dir>/node_modules/<name>`。目录形如 '/node_modules/foo'（无尾斜杠，根为 ''）。
// 命中条件与 require 一致：目录本身在清单里（有 package.json 或纯目录条目）、
// 或单文件模块 `<name>.js`。
function resolveVirtual (fromDir, name, hasPath) {
  let dir = fromDir.replace(/\/+$/, '') || ''
  for (;;) {
    const candidate = `${dir}/${NODE_MODULES}/${name}`
    if (hasPath(`${candidate}/package.json`) || hasPath(candidate)) return candidate
    if (hasPath(`${candidate}.js`)) return `${candidate}.js`
    let parent = dirname(dir)
    if (parent === '/') parent = ''
    if (parent === dir) return null
    dir = parent
  }
}

// 主检查。entries：asar 清单（'/' 起头路径的数组）；readFile(virtualPath)：
// 从 asar 取文件内容（找不到返回 null/throw 交由调用方封装）；rootDeps：
// 构建侧 package.json 的 dependencies 名单 —— 整包缺席（清单里根本没有该包）
// 的丢件没有任何在清单内的引用方能暴露，靠这份名单兜底。
// 返回 { missing: [{ from, dep }], packages, edges }。
function collectMissing (entries, readFile, rootDeps = []) {
  const has = new Set(entries)
  const hasPath = (p) => has.has(p)
  const missing = []
  let edges = 0

  for (const name of rootDeps) {
    const at = `/node_modules/${name}`
    if (!(hasPath(`${at}/package.json`) || hasPath(at) || hasPath(`${at}.js`))) {
      missing.push({ from: '(app root)', dep: name })
    }
  }

  const pkgDirs = listPackageDirs(entries)
  for (const dir of pkgDirs) {
    let json
    const raw = readFile(`${dir}/package.json`)
    try {
      json = JSON.parse(raw.toString('utf8'))
    } catch {
      missing.push({ from: dir, dep: '(package.json unreadable/unparseable)' })
      continue
    }
    // optionalDependencies 缺席是合法形态；peerDependencies 由宿主环境供给，
    // 都不在 require 时保证之列，只有 dependencies 是硬承诺。
    for (const dep of Object.keys(json.dependencies || {})) {
      if (TYPE_ONLY_DEP.test(dep)) continue
      edges++
      if (!resolveVirtual(dir, dep, hasPath)) missing.push({ from: dir, dep })
    }
  }
  return { missing, packages: pkgDirs.length, edges }
}

function locateAsar (context) {
  const appOutDir = context.appOutDir
  const candidates = context.electronPlatformName === 'darwin'
    ? [join(appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app.asar')]
    : [join(appOutDir, 'resources', 'app.asar')]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  throw new Error(`[verify-packed-node-modules] app.asar not found under ${appOutDir}`)
}

// afterPack 入口。任何缺失都会 throw —— electron-builder 以非零码失败，
// 坏包到不了用户手里。
async function verifyPackedNodeModules (context) {
  const asarPath = locateAsar(context)
  const asar = require('@electron/asar')
  const projectDir = (context.packager && context.packager.projectDir) || process.cwd()
  const rootDeps = Object.keys(require(join(projectDir, 'package.json')).dependencies || {})

  const entries = asar.listPackage(asarPath).map(p => {
    let e = String(p).split('\\').join('/')
    if (!e.startsWith('/')) e = `/${e}`
    return e
  })

  const unpackedRoot = join(dirname(asarPath), 'app.asar.unpacked')
  const readFile = (virtualPath) => {
    const rel = virtualPath.replace(/^\//, '')
    // 分隔符必须跟着打包机走（2026-11-06 Windows CI 实测：386 个包全被判成
    // package.json unreadable，而同一份代码在 mac 上 392 包全绿）。
    // asar 头里的层级键是**打包时**按 path.sep 切出来的：Windows 上打的包，
    // extractFile 的 searchNodeFromDirectory 只认 '\'，传 '/' 会查不到 ——
    // 上面对 listPackage 的输出做了 '\'→'/' 归一（所以包目录枚举得出来），
    // 但 extractFile 要的是原始形态。两个都试：mac/linux 第一次即命中，
    // 不改变既有行为；Windows 走第二次。
    for (const candidate of [rel, rel.split('/').join('\\')]) {
      try {
        return asar.extractFile(asarPath, candidate)
      } catch {
        // asarUnpack 的条目（better-sqlite3/@img）内容在旁路目录里
        try {
          return readFileSync(join(unpackedRoot, candidate))
        } catch {
          // 换下一种分隔符
        }
      }
    }
    return null
  }

  const { missing, packages, edges } = collectMissing(entries, readFile, rootDeps)
  if (missing.length > 0) {
    const lines = missing.map(m => `  - ${m.dep}  (required by ${m.from})`)
    console.error(`[verify-packed-node-modules] ${missing.length} dependency(ies) NOT resolvable inside ${asarPath}:\n${lines.join('\n')}`)
    throw new Error(`[verify-packed-node-modules] packed node_modules is incomplete — ${missing.length} unresolvable dependency(ies)`)
  }
  console.log(`[verify-packed-node-modules] OK — ${packages} packages / ${edges} dependency edges resolved inside app.asar`)
}

module.exports = { resolveVirtual, listPackageDirs, collectMissing, verifyPackedNodeModules }
