'use strict'

// ── check-linux-glibc ──
// 打包产物的「目标机可加载性」门禁（目标：UOS 20 / Debian 10 基线）。
//
// 两条轴都必须量，缺一条就会有静默失败：
//   1. glibc（GLIBC_x.y）——默认上限 2.28。better-sqlite3 是 Electron ABI 原生
//      模块，`install-app-deps` 在打包机上现场编译：构建机 glibc ≥ 2.34 时产物
//      会要求 GLIBC_2.34，装到 2.28 的目标机是启动即 `undefined symbol`。
//   2. libstdc++（GLIBCXX_3.4.z）——默认上限 3.4.25（Debian 10 的 GCC 8.3）。
//      2026-11-23 实锤：官方 sherpa-onnx linux 平台包 1.12.40 的 GLIBC 只有
//      2.16，却要 GLIBCXX_3.4.29（`std::__throw_bad_array_new_length`，GCC 11
//      才引入）——只量 glibc 的门禁会放行一个「装机 dlopen 报 version not
//      found」的包。第三方预编译件常常是 glibc 很低、libstdc++ 很高，两条轴
//      不同源，必须分开量。
//
// 两种失败都是**装机即报错、构建期无感**：`undefined symbol` 或
// `version 'GLIBCXX_3.4.29' not found`。这个门禁把 linux-unpacked 下每个
// .node / .so 的两条需求逐文件量出来（读 .gnu.version_r 里的版本串），
// 任一超上限非零退出。
//
// 唯一例外是 Chromium（`resources/chromium/**`）：那是 Google 的 Chrome for
// Testing 构建，我们既不能重编也没有更老的 Linux 版本可换，判红也修不了 ——
// 所以它只打印、不判红（workflow 里那颗 chrome 二进制的 informational 步骤同理）。
//
// ── 随包私有 C++ 运行库（2026-11-23 方案 ①）──
// 引擎目录里若有 `libpmcxx.so.6`（我们随包带的 libstdc++ 副本），那么**同目录**
// 引擎的 GLIBCXX 需求不再由系统 libstdc++ 承担，而由这份提供方承担。于是：
//   · 这些文件的 GLIBCXX 上限 = 提供方实测定义到的最高版本（实测 3.4.30），
//     而不是目标机系统的 3.4.25 —— 否则方案 ① 落地后门禁会永远红，红得没意义；
//   · 但同一目录下的引擎对象**不得残留** `libstdc++.so.6` 的 DT_NEEDED。残留说明
//     #它还在用系统的（glibc 按 SONAME 复用已加载对象），此时抬高上限就是自欺 ——
//     这种文件一律判红，并且退回系统上限。
//   · 提供方自己也要量：自身 GLIBC ≤ 上限（超了等于把失败搬到运行库身上），且
//     提供 ≥ 引擎需求（不够就是换了个地方报 version not found）。
// 提供方**不享受** Chromium 那种豁免：它是我们自己决定随包的，量不过就该改 blob。
//
// 用法：
//   node scripts/check-linux-glibc.js [dir=dist/linux-unpacked] \
//     [--ceiling=2.28] [--glibcxx-ceiling=3.4.25]
// 退出码：0 = 全部达标；1 = 有文件超上限；2 = 目录里一个 .node/.so 都没找到
//        （没有可验对象时放行等于静默空转，所以这算失败）
// CI 里若存在 GITHUB_STEP_SUMMARY，会追加一张 markdown 表。

const { existsSync, readdirSync, readFileSync, statSync, appendFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

const DEFAULT_DIR = 'dist/linux-unpacked'
const DEFAULT_CEILING = '2.28'
const DEFAULT_CXX_CEILING = '3.4.25'

// 随包私有 C++ 运行库的文件名（prepare-asr-engine.js 的 LINUX_CXX.name 同字面量）。
const PRIVATE_CXX_NAME = 'libpmcxx.so.6'
// 引擎对象里残留这个串 = 还链着系统 libstdc++，私有运行库不会被打开。
const STALE_CXX_NEEDED = 'libstdc++.so.6\0'

// 版本串在 ELF 的 .gnu.version_r 里是普通 ASCII（"GLIBC_2.28" / "GLIBCXX_3.4.29"），
// 在原始字节里直接扫就够 —— 不需要解析 ELF 结构，也就能在任何平台（含 mac 开发机）
// 上跑。两条正则互不吃对方：GLIBC_ 后面必须是数字，GLIBCXX_ 在 GLIBC 后面是 X。
const GLIBC_RE = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g
const GLIBCXX_RE = /GLIBCXX_(\d+)\.(\d+)(?:\.(\d+))?/g

function parseVersion (text) {
  const [major, minor, patch] = String(text).split('.').map((n) => Number(n) || 0)
  return [major, minor, patch || 0]
}

function compareVersion (a, b) {
  for (let i = 0; i < 3; i++) {
    const diff = (a[i] || 0) - (b[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** [2, 28, 0] → '2.28'（tail 的 .0 不参与展示，2.2.5 保留三段）。 */
function formatVersion (version) {
  return version.slice(0, version[2] ? 3 : 2).join('.')
}

/** 一个二进制里出现的全部 `<prefix>x.y[.z]` 需求（去重，升序）。 */
function requirementsOf (buffer, re) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer)
  const seen = new Map()
  re.lastIndex = 0
  let match
  while ((match = re.exec(text)) !== null) {
    const label = `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`
    seen.set(label, parseVersion(label))
  }
  return [...seen.values()].sort(compareVersion)
}

/** 一个二进制里出现的全部 GLIBC_x.y 需求（去重，升序）。 */
function glibcRequirementsOf (buffer) {
  return requirementsOf(buffer, GLIBC_RE)
}

/** 一个二进制里出现的全部 GLIBCXX_x.y.z 需求（去重，升序）。2026-11-23 新增：
 *  与 glibc 是两个独立上限，第三方预编译件经常 glibc 很低、libstdc++ 很高，
 *  只量前者会漏（M0 的 2.0.2 两条都超，1.12.40 只有后者超）。 */
function glibcxxRequirementsOf (buffer) {
  return requirementsOf(buffer, GLIBCXX_RE)
}

function maxVersion (versions) {
  return versions.length === 0 ? null : versions[versions.length - 1]
}

function exceedsCeiling (versions, ceiling) {
  const max = maxVersion(versions)
  return max !== null && compareVersion(max, parseVersion(ceiling)) > 0
}

/** 第三方不可重建的随包二进制（只报告、不判红）——见文件头。 */
function isThirdPartyBundle (file) {
  const normalized = String(file).split(/[\\/]/).join('/')
  return normalized.includes('/chromium/')
}

/** 递归收集 .node 与随包引擎的 .so（PLAN-voice-input M3：resources/asr-engine
 *  的 libsherpa-onnx-*.so / libonnxruntime.so 走 extraResources 落在
 *  resources/asr-engine/<plat>-<arch>/ 下，同一个门必须罩住它们——2026-11-23
 *  起还罩 GLIBCXX，因为官方 1.12.40 引擎的 glibc 达标而 libstdc++ 不达标）。
 *
 *  ⚠️ 刻意不扩到 `.so.*`（versioned soname）：那份私有运行库 `libpmcxx.so.6`
 *  自身会**定义** GLIBCXX_3.4.30，而本脚本用原始字节扫版本串、分不清
 *  .gnu.version_d（定义）与 .gnu.version_r（需求）—— 收进来必然假阳性。
 *  它走下面的 collectPrivateRuntimes 单独一条（只量 GLIBC，GLIBCXX 只当"提供"）。 */
function collectNodeFiles (dir) {
  return collectFiles(dir, (name) => name.endsWith('.node') || name.endsWith('.so'))
}

/** 随包私有 C++ 运行库（按确切文件名，不按后缀 —— 见上）。 */
function collectPrivateRuntimes (dir) {
  return collectFiles(dir, (name) => name === PRIVATE_CXX_NAME)
}

function collectFiles (dir, match) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && match(entry.name)) out.push(full)
    }
  }
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  return out
}

/**
 * 每个目录的私有运行库能力（按 dirname 索引，只认「同目录」）。
 * cxxProvides 是它**定义**的最高 GLIBCXX —— 原始字节里分不出定义与需求，但对
 * libstdc++ 副本而言那些串只可能来自 .gnu.version_d（它是版本的提供方）。
 */
function providerCapabilities (runtimes) {
  const map = new Map()
  for (const file of runtimes) {
    const buffer = readFileSync(file)
    map.set(dirname(file), {
      file,
      glibcMax: maxVersion(glibcRequirementsOf(buffer)),
      cxxProvides: maxVersion(glibcxxRequirementsOf(buffer)),
    })
  }
  return map
}

function scan (files, providers = new Map()) {
  return files.map((file) => {
    const buffer = readFileSync(file)
    const versions = glibcRequirementsOf(buffer)
    const cxxVersions = glibcxxRequirementsOf(buffer)
    const provider = providers.get(dirname(file)) ?? null
    return {
      file,
      kind: 'engine',
      versions,
      max: maxVersion(versions),
      cxxVersions,
      cxxMax: maxVersion(cxxVersions),
      thirdParty: isThirdPartyBundle(file),
      provider,
      // 只有「同目录有私有运行库」的文件才谈得上残留（别的模块本来就该用系统库）
      staleCxx: Boolean(provider) && buffer.includes(Buffer.from(STALE_CXX_NEEDED, 'latin1')),
    }
  })
}

/** 提供方自己也进表：GLIBC 轴照量，GLIBCXX 轴只记录提供能力（不是需求）。 */
function scanProviders (providers) {
  return [...providers.values()].map((p) => ({
    file: p.file,
    kind: 'provider',
    versions: p.glibcMax ? [p.glibcMax] : [],
    max: p.glibcMax,
    cxxVersions: [],
    cxxMax: null,
    cxxProvides: p.cxxProvides,
    thirdParty: false,
    provider: null,
    staleCxx: false,
  }))
}

/**
 * 一条文件该用的 GLIBCXX 上限：同目录有私有运行库且没残留旧 NEEDED 时，用
 * 提供方实测能力；其余一律目标机系统的上限。
 */
function cxxCeilingOf (row, globalCxxCeiling) {
  if (row.kind === 'provider') return null // 定义不是需求，这一轴对它无意义
  if (row.provider && !row.staleCxx && row.provider.cxxProvides) {
    return formatVersion(row.provider.cxxProvides)
  }
  return globalCxxCeiling
}

function summarize (rows, ceiling, cxxCeiling = DEFAULT_CXX_CEILING) {
  const over = (row) => {
    if (row.max && compareVersion(row.max, parseVersion(ceiling)) > 0) return true
    const limit = cxxCeilingOf(row, cxxCeiling)
    if (row.cxxMax && limit && compareVersion(row.cxxMax, parseVersion(limit)) > 0) return true
    return row.staleCxx
  }
  const offenders = []
  const informational = []
  for (const row of rows) {
    if (!over(row)) continue
    if (row.thirdParty) informational.push(row)
    else offenders.push(row)
  }
  return { offenders, informational }
}

/** 一个文件超限的具体轴（报错时分别列出，别让用户自己反推是哪条）。 */
function reasonOf (row, ceiling, cxxCeiling) {
  const reasons = []
  if (row.max && compareVersion(row.max, parseVersion(ceiling)) > 0) reasons.push(`GLIBC_${formatVersion(row.max)}`)
  const limit = cxxCeilingOf(row, cxxCeiling)
  if (row.cxxMax && limit && compareVersion(row.cxxMax, parseVersion(limit)) > 0) {
    // 只有上限真的来自提供方时才提「它只提供到 X」；残留旧 NEEDED 的那种已退回
    // 系统上限，这里说成「只提供到 3.4.25」会误导（提供方其实是够的）
    const fromProvider = Boolean(row.provider) && !row.staleCxx
    reasons.push(`GLIBCXX_${formatVersion(row.cxxMax)}${fromProvider ? `（私有运行库只提供到 ${limit}）` : ''}`)
  }
  if (row.staleCxx) reasons.push('仍 NEEDED libstdc++.so.6（未改用私有 SONAME，随包副本不会被打开）')
  return reasons.join(' + ')
}

function main (argv) {
  const args = argv.slice(2)
  const dirArg = args.find((a) => !a.startsWith('--'))
  const ceiling = (args.find((a) => a.startsWith('--ceiling=')) || '').split('=')[1] || DEFAULT_CEILING
  const cxxCeiling = (args.find((a) => a.startsWith('--glibcxx-ceiling=')) || '').split('=')[1] || DEFAULT_CXX_CEILING
  const dir = resolve(dirArg || DEFAULT_DIR)

  const files = collectNodeFiles(dir)
  if (files.length === 0) {
    console.error(`[check-linux-glibc] no *.node/*.so found under ${dir}`)
    console.error('[check-linux-glibc] 先打包（npx electron-builder --linux dir）再来验；空扫描不放行。')
    return 2
  }

  const providers = providerCapabilities(collectPrivateRuntimes(dir))
  const rows = [...scan(files, providers), ...scanProviders(providers)]
  const { offenders, informational } = summarize(rows, ceiling, cxxCeiling)

  // 提供方在场时把「这条上限被谁抬高了」说清楚，否则表里的 limit 是个谜
  for (const p of providers.values()) {
    const count = rows.filter((r) => r.kind === 'engine' && r.provider === p).length
    console.log(
      `[check-linux-glibc] 私有 C++ 运行库 ${p.file}：自身 GLIBC<=${p.glibcMax ? formatVersion(p.glibcMax) : 'static'}` +
        `, 提供 GLIBCXX<=${p.cxxProvides ? formatVersion(p.cxxProvides) : 'none'}` +
        `（同目录 ${count} 个文件按这个上限判定）`,
    )
  }

  const cxxLabel = (row) => {
    if (row.kind === 'provider') return row.cxxProvides ? `${formatVersion(row.cxxProvides)} (provides)` : 'static'
    const base = row.cxxMax ? formatVersion(row.cxxMax) : 'static'
    const limit = cxxCeilingOf(row, cxxCeiling)
    return limit && limit !== cxxCeiling ? `${base} (limit ${limit})` : base
  }

  for (const row of rows) {
    const glibc = row.max ? formatVersion(row.max) : 'static'
    console.log(`GLIBC<=${glibc}\tGLIBCXX<=${cxxLabel(row)}\t${row.file}`)
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const lines = [
      `### native module floors (GLIBC <= ${ceiling}, GLIBCXX <= ${cxxCeiling})`,
      '',
      '| max GLIBC | max GLIBCXX | file |',
      '| --- | --- | --- |',
      ...rows.map(
        (row) =>
          `| ${row.max ? formatVersion(row.max) : 'static'} | ${cxxLabel(row)} | \`${row.file}\`${row.thirdParty ? '（第三方，只报告）' : ''} |`,
      ),
      '',
    ]
    appendFileSync(summaryPath, lines.join('\n'))
  }

  if (informational.length > 0) {
    console.warn(`\n[check-linux-glibc] ${informational.length} 个第三方二进制超上限（不判红，见文件头）：`)
    for (const row of informational) console.warn(`  ${row.file} -> ${reasonOf(row, ceiling, cxxCeiling)}`)
  }

  if (offenders.length > 0) {
    console.error(`\n[check-linux-glibc] ${offenders.length} file(s) exceed the target floors (GLIBC ${ceiling} / GLIBCXX ${cxxCeiling}):`)
    for (const row of offenders) console.error(`  ${row.file} -> ${reasonOf(row, ceiling, cxxCeiling)}`)
    console.error(
      '\n目标机（UOS 20 / Debian 10）是 glibc 2.28 + libstdc++ GLIBCXX_3.4.25（GCC 8.3）。' +
        '两条轴任一超限，装机都是 dlopen 即失败（`undefined symbol` 或 `version not found`），构建期无感。' +
        '现场编译的模块换 2.28 基线构建环境（debian:buster，或 zig 钉 -target）；' +
        '第三方预编译件（如 sherpa-onnx 平台包）只能换版本、随包自带 libstdc++，或自编——不要指望运行时补库。' +
        `随包自带那份副本必须改名（见 resources/cxx-runtime/README.md）：叫 libstdc++.so.6 会被 glibc 按 SONAME 复用掉，永远不会被打开。`,
    )
    return 1
  }

  const engineCount = rows.filter((row) => row.kind === 'engine').length
  console.log(`\n[check-linux-glibc] OK — ${engineCount} native module(s) within GLIBC ${ceiling} / GLIBCXX ${cxxCeiling}`)
  return 0
}

module.exports = {
  glibcRequirementsOf,
  glibcxxRequirementsOf,
  maxVersion,
  exceedsCeiling,
  collectNodeFiles,
  collectPrivateRuntimes,
  providerCapabilities,
  cxxCeilingOf,
  isThirdPartyBundle,
  scan,
  scanProviders,
  summarize,
  reasonOf,
  formatVersion,
  PRIVATE_CXX_NAME,
}

if (require.main === module) {
  process.exitCode = main(process.argv)
}
