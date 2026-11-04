'use strict'

// ── check-linux-glibc ──
// 打包产物的 glibc 下限门禁（目标：UOS 20 / Debian 10 基线，glibc 2.28）。
//
// 背景：better-sqlite3 是 Electron ABI 原生模块，`install-app-deps` 在打包机上
// 现场编译 —— 构建机的 glibc 头文件决定产物的符号需求（glibc ≥ 2.34 把 pthread
// 并入 libc，在 2.34+ 机器上编出来的 .node 会要求 GLIBC_2.34），而 UOS 20 跑的
// 是 2.28：装上去是启动即 `undefined symbol`，不是构建期可见的失败。这个门禁把
// linux-unpacked 下每个 .node 的 GLIBC_x.y 需求逐文件量出来（读 .gnu.version_r
// 里的版本串），超过上限（默认 2.28）非零退出。
//
// 上游 Electron 二进制实测只有 GLIBC_2.25（33.4.11 linux-x64），所以真正会被
// 构建机抬高下限的就是这些现场编译的 .node —— 也是本脚本只扫它们的理由。
//
// 用法：
//   node scripts/check-linux-glibc.js [dir=dist/linux-unpacked] [--ceiling=2.28]
// 退出码：0 = 全部达标；1 = 有文件超上限；2 = 目录里一个 .node 都没找到
//        （没有可验对象时放行等于静默空转，所以这算失败）
// CI 里若存在 GITHUB_STEP_SUMMARY，会追加一张 markdown 表。

const { existsSync, readdirSync, readFileSync, statSync, appendFileSync } = require('node:fs')
const { join, resolve } = require('node:path')

const DEFAULT_DIR = 'dist/linux-unpacked'
const DEFAULT_CEILING = '2.28'

// 版本串在 ELF 的 .gnu.version_r 里是普通 ASCII（"GLIBC_2.28"），在原始字节里
// 直接扫就够 —— 不需要解析 ELF 结构，也就能在任何平台（含 mac 开发机）上跑。
const GLIBC_RE = /GLIBC_(\d+)\.(\d+)(?:\.(\d+))?/g

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

/** 一个二进制里出现的全部 GLIBC_x.y 需求（去重，升序）。 */
function glibcRequirementsOf (buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer)
  const seen = new Map()
  GLIBC_RE.lastIndex = 0
  let match
  while ((match = GLIBC_RE.exec(text)) !== null) {
    const label = `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`
    seen.set(label, parseVersion(label))
  }
  return [...seen.values()].sort(compareVersion)
}

function maxVersion (versions) {
  return versions.length === 0 ? null : versions[versions.length - 1]
}

function exceedsCeiling (versions, ceiling) {
  const max = maxVersion(versions)
  return max !== null && compareVersion(max, parseVersion(ceiling)) > 0
}

/** 递归收集 .node 文件（linux-unpacked 里的原生模块全在 app.asar.unpacked 下）。 */
function collectNodeFiles (dir) {
  const out = []
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.node')) out.push(full)
    }
  }
  if (existsSync(dir) && statSync(dir).isDirectory()) walk(dir)
  return out
}

function scan (files) {
  return files.map((file) => {
    const versions = glibcRequirementsOf(readFileSync(file))
    return { file, versions, max: maxVersion(versions) }
  })
}

function summarize (rows, ceiling) {
  const offenders = rows.filter((row) => row.max && compareVersion(row.max, parseVersion(ceiling)) > 0)
  return { offenders }
}

function main (argv) {
  const args = argv.slice(2)
  const dirArg = args.find((a) => !a.startsWith('--'))
  const ceiling = (args.find((a) => a.startsWith('--ceiling=')) || '').split('=')[1] || DEFAULT_CEILING
  const dir = resolve(dirArg || DEFAULT_DIR)

  const files = collectNodeFiles(dir)
  if (files.length === 0) {
    console.error(`[check-linux-glibc] no *.node found under ${dir}`)
    console.error('[check-linux-glibc] 先打包（npx electron-builder --linux deb）再来验；空扫描不放行。')
    return 2
  }

  const rows = scan(files)
  const { offenders } = summarize(rows, ceiling)

  for (const row of rows) {
    const shown = row.max ? formatVersion(row.max) : 'static (no glibc refs)'
    console.log(`GLIBC<=${shown}\t${row.file}`)
  }

  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (summaryPath) {
    const lines = [
      `### glibc ceiling check (<= ${ceiling})`,
      '',
      '| max GLIBC | file |',
      '| --- | --- |',
      ...rows.map((row) => `| ${row.max ? formatVersion(row.max) : 'static'} | \`${row.file}\` |`),
      '',
    ]
    appendFileSync(summaryPath, lines.join('\n'))
  }

  if (offenders.length > 0) {
    console.error(`\n[check-linux-glibc] ${offenders.length} file(s) require glibc newer than ${ceiling}:`)
    for (const row of offenders) console.error(`  ${row.file} -> GLIBC_${formatVersion(row.max)}`)
    console.error(
      '\n目标机（UOS 20 / Debian 10）是 glibc 2.28。这些模块是在 glibc 更新的构建机上现场编译的：' +
        '把构建环境换到 2.28 基线（如 debian:buster 容器）后重出包，不要靠运行时补库。',
    )
    return 1
  }

  console.log(`\n[check-linux-glibc] OK — ${rows.length} native module(s) within glibc ${ceiling}`)
  return 0
}

module.exports = {
  glibcRequirementsOf,
  maxVersion,
  exceedsCeiling,
  collectNodeFiles,
  scan,
  summarize,
  formatVersion,
}

if (require.main === module) {
  process.exitCode = main(process.argv)
}
