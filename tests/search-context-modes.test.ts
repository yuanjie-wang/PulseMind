/**
 * search 的 context / output_mode（P0-2，2026-10-28）。
 *
 * 三层钉子：
 *  1. 归一化纯函数（帽/取整/未知模式回落/非 content 模式 context 归零）。
 *  2. 四个命令臂的字符串形状——默认调用字节不变（旧测试按子串断言、模型侧
 *     行为与缓存都靠它），新参数在每条臂上都有对应 flag：rg 臂 -C/-l/--count，
 *     grep 臂 -C3/-l/-c（+ :0 过滤），Select-String 臂 -Context/-List/Group-Object。
 *  3. 真执行（darwin/linux）：rg 臂与 grep 回退臂都实际跑一遍，验收「一次
 *     search 返回命中行 ±N 行并带行号」、路径态、计数态、以及「100 行帽把上下
 *     文行也算进去」。
 *  4. wiring：schema 承诺的每个属性都被构建器读取（webfetch 教训的反向钉），
 *     手册口径同步。
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCommandFromSkillInput, normalizeSearchOptions, SEARCH_CONTEXT_MAX } from '../src/renderer/src/agent/command-builder'
import { BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import { toolInstructions } from '../src/renderer/src/tools/tool-instructions'

const RG_UNIX = '/usr/local/bin/rg'
const RG_WIN = 'C:\\Tools\\rg.exe'
const BASE = { query: 'needle', search_dir: '/w', include: '*.ts', exclude: '*.spec.ts' }

const build = (input: Record<string, unknown>, platform = 'darwin', rg: string | null = RG_UNIX): string =>
  buildCommandFromSkillInput('search', input, platform, rg)

// Every flag any arm can gain from the new parameters. A default call must
// contain none of them on any arm.
const NEW_FLAG_RE = / -C ?\d| -l\b| --count\b| -c\b|-Context |-List\b|Group-Object|grep -v ':0\$'/

describe('normalizeSearchOptions', () => {
  it('默认 content + 0', () => {
    expect(normalizeSearchOptions({})).toEqual({ context: 0, mode: 'content' })
    expect(normalizeSearchOptions({ query: 'x' })).toEqual({ context: 0, mode: 'content' })
  })

  it('context 取整、下限 0、上限 SEARCH_CONTEXT_MAX，字符串数字也认', () => {
    expect(SEARCH_CONTEXT_MAX).toBe(5)
    expect(normalizeSearchOptions({ context: 3 }).context).toBe(3)
    expect(normalizeSearchOptions({ context: 99 }).context).toBe(5)
    expect(normalizeSearchOptions({ context: 2.9 }).context).toBe(2)
    expect(normalizeSearchOptions({ context: -4 }).context).toBe(0)
    expect(normalizeSearchOptions({ context: 'abc' }).context).toBe(0)
    expect(normalizeSearchOptions({ context: '4' }).context).toBe(4)
    expect(normalizeSearchOptions({ context: null }).context).toBe(0)
  })

  it('未知 output_mode 回落 content（fail-closed）', () => {
    expect(normalizeSearchOptions({ output_mode: 'files' }).mode).toBe('content')
    expect(normalizeSearchOptions({ output_mode: 'CONTENT' }).mode).toBe('content')
    expect(normalizeSearchOptions({ output_mode: 42 }).mode).toBe('content')
    expect(normalizeSearchOptions({ output_mode: 'files_with_matches' }).mode).toBe('files_with_matches')
    expect(normalizeSearchOptions({ output_mode: 'count' }).mode).toBe('count')
  })

  it('非 content 模式下 context 归零——路径/计数输出没有上下文可言', () => {
    expect(normalizeSearchOptions({ output_mode: 'files_with_matches', context: 3 })).toEqual({ context: 0, mode: 'files_with_matches' })
    expect(normalizeSearchOptions({ output_mode: 'count', context: 5 })).toEqual({ context: 0, mode: 'count' })
  })
})

describe('默认调用字节不变（四臂）', () => {
  const arms: Array<[string, string, string | null]> = [
    ['unix rg', 'darwin', RG_UNIX],
    ['unix fallback', 'darwin', null],
    ['win rg', 'win32', RG_WIN],
    ['win fallback', 'win32', null],
  ]
  for (const [label, platform, rg] of arms) {
    it(`${label}: 无新参数 === 显式默认值，且不含任何新 flag`, () => {
      const plain = build(BASE, platform, rg)
      const explicit = build({ ...BASE, context: 0, output_mode: 'content' }, platform, rg)
      expect(explicit).toBe(plain)
      expect(plain).not.toMatch(NEW_FLAG_RE)
    })
  }

  it('旧测试依赖的子串仍在（rg 臂）', () => {
    const cmd = build({ query: 'foo', search_dir: '.', include: '*.ts', exclude: '*.spec.ts' })
    expect(cmd).toContain(` -n --no-heading -i --max-columns 200 'foo' '.'`)
    expect(cmd).toContain(` -g '*.ts'`)
    expect(cmd).toContain(` -g '!*.spec.ts'`)
    expect(cmd.endsWith(` -g '!*.spec.ts' 2>&1 | head -100`)).toBe(true)
  })
})

describe('unix rg 臂', () => {
  it('context → -C N 落在 glob 之后、2>&1 | head 之前', () => {
    const cmd = build({ ...BASE, context: 3 })
    expect(cmd.endsWith(` -g '!*.spec.ts' -C 3 2>&1 | head -100`)).toBe(true)
  })

  it('files_with_matches → -l；count → --count；两者都不带 -C', () => {
    const files = build({ ...BASE, output_mode: 'files_with_matches', context: 3 })
    expect(files.endsWith(` -g '!*.spec.ts' -l 2>&1 | head -100`)).toBe(true)
    expect(files).not.toMatch(/ -C ?\d/)
    const count = build({ ...BASE, output_mode: 'count', context: 3 })
    expect(count.endsWith(` -g '!*.spec.ts' --count 2>&1 | head -100`)).toBe(true)
    expect(count).not.toMatch(/ -C ?\d/)
  })

  it('context 帽 5：传 50 也只出 -C 5', () => {
    expect(build({ ...BASE, context: 50 })).toContain(' -C 5 2>&1')
  })
})

describe('unix 回退臂（rg 子臂与 grep 子臂都接）', () => {
  const rgArm = (cmd: string): string => cmd.slice(0, cmd.indexOf('; else '))
  const grepArm = (cmd: string): string => cmd.slice(cmd.indexOf('; else ') + 7, cmd.indexOf('; fi '))

  it('context：rg 子臂 -C 3，grep 子臂紧贴形式 -C3（BSD/busybox 口径）', () => {
    const cmd = build({ ...BASE, context: 3 }, 'darwin', null)
    expect(rgArm(cmd)).toMatch(/ -C 3 2>&1$/)
    expect(grepArm(cmd)).toMatch(/--exclude='\*\.spec\.ts' -C3 2>&1$/)
    expect(grepArm(cmd)).not.toContain(' -C 3')
  })

  it('files_with_matches：rg -l + grep -l', () => {
    const cmd = build({ ...BASE, output_mode: 'files_with_matches' }, 'darwin', null)
    expect(rgArm(cmd)).toMatch(/ -l 2>&1$/)
    expect(grepArm(cmd)).toMatch(/ -l 2>&1$/)
    expect(cmd).not.toContain(':0$')
  })

  it('count：rg --count + grep -c，grep 侧追加 :0 过滤（grep -rc 会列出零命中文件）', () => {
    const cmd = build({ ...BASE, output_mode: 'count' }, 'darwin', null)
    expect(rgArm(cmd)).toMatch(/ --count 2>&1$/)
    expect(grepArm(cmd)).toMatch(/ -c 2>&1 \| grep -v ':0\$'$/)
    expect(cmd.endsWith(`; fi | head -100`)).toBe(true)
  })
})

describe('win rg 臂', () => {
  it('context → -C N 落在 | Select-Object -First 100 之前', () => {
    const cmd = build({ ...BASE, context: 2 }, 'win32', RG_WIN)
    expect(cmd.startsWith(`& 'C:\\Tools\\rg.exe' -n --no-heading -i`)).toBe(true)
    expect(cmd.endsWith(` -g '!*.spec.ts' -C 2 | Select-Object -First 100`)).toBe(true)
  })

  it('files_with_matches → -l；count → --count', () => {
    expect(build({ ...BASE, output_mode: 'files_with_matches' }, 'win32', RG_WIN).endsWith(` -l | Select-Object -First 100`)).toBe(true)
    expect(build({ ...BASE, output_mode: 'count' }, 'win32', RG_WIN).endsWith(` --count | Select-Object -First 100`)).toBe(true)
  })
})

describe('win 回退臂（rg 子臂与 Select-String 子臂都接）', () => {
  const rgArm = (cmd: string): string => cmd.slice(0, cmd.indexOf(' 2>$null } else { '))
  const psArm = (cmd: string): string => cmd.slice(cmd.indexOf(' 2>$null } else { ') + 18)

  it('默认形状不变：Filename:LineNumber:Line', () => {
    const cmd = build(BASE, 'win32', null)
    expect(psArm(cmd)).toContain(`| Select-String -Pattern 'needle' | Select-Object -First 100 | ForEach-Object { $_.Filename + ':' + $_.LineNumber + ':' + $_.Line.Trim() } }`)
  })

  it('context：rg 子臂 -C 3 + Select-String -Context 3，ForEach 吐 pre/match/post 三段并带行号', () => {
    const cmd = build({ ...BASE, context: 3 }, 'win32', null)
    expect(rgArm(cmd)).toMatch(/ -C 3$/)
    const ps = psArm(cmd)
    expect(ps).toContain(`Select-String -Pattern 'needle' -Context 3 | Select-Object -First 100`)
    expect(ps).toContain('$m.Context.PreContext')
    expect(ps).toContain('$m.Context.PostContext')
    // rg-style framing: context lines path-line-text, the hit path:line:text
    expect(ps).toContain(`$m.Filename + '-' + ($n - $pre.Count + $i) + '-' + $pre[$i].Trim()`)
    expect(ps).toContain(`$m.Filename + ':' + $n + ':' + $m.Line.Trim()`)
    expect(ps).toContain(`$m.Filename + '-' + ($n + 1 + $i) + '-' + $post[$i].Trim()`)
  })

  it('files_with_matches：rg -l + Select-String -List 回 $_.Path（全路径，模型拿去 read）', () => {
    const cmd = build({ ...BASE, output_mode: 'files_with_matches' }, 'win32', null)
    expect(rgArm(cmd)).toMatch(/ -l$/)
    expect(psArm(cmd)).toContain(`Select-String -Pattern 'needle' -List | Select-Object -First 100 | ForEach-Object { $_.Path }`)
    expect(psArm(cmd)).not.toContain('-Context')
  })

  it('count：rg --count + Group-Object Path → Name:Count', () => {
    const cmd = build({ ...BASE, output_mode: 'count' }, 'win32', null)
    expect(rgArm(cmd)).toMatch(/ --count$/)
    expect(psArm(cmd)).toContain(`Select-String -Pattern 'needle' | Group-Object Path | Select-Object -First 100 | ForEach-Object { $_.Name + ':' + $_.Count }`)
  })

  it('query 在新臂里仍然只经 psEscape 进单引号（注入面不扩）', () => {
    const cmd = build({ ...BASE, query: "it's", output_mode: 'files_with_matches' }, 'win32', null)
    expect(psArm(cmd)).toContain(`-Pattern 'it''s' -List`)
  })
})

// ── 真执行 ────────────────────────────────────────────────────────────────
const isUnix = process.platform !== 'win32'
const rgOnPath = isUnix
  ? (spawnSync('/bin/sh', ['-c', 'command -v rg'], { encoding: 'utf8' }).stdout || '').trim() || null
  : null

function withFixture<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pm-search-ctx-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'alpha\nbeta\nNEEDLE one\ndelta\nepsilon\n')
    writeFileSync(join(dir, 'b.txt'), 'nothing here\nstill nothing\n')
    writeFileSync(join(dir, 'c.txt'), 'NEEDLE two\nfiller\nfiller\nfiller\nNEEDLE three\n')
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const run = (cmd: string, env?: NodeJS.ProcessEnv): string[] =>
  (spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', env }).stdout || '').split('\n').filter(Boolean)

describe.runIf(isUnix && !!rgOnPath)('真执行：rg 臂', () => {
  it('context=1 → 命中行 ±1 行带行号，上下文用 - 分隔、命中用 :', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE one', search_dir: dir, context: 1 }, 'darwin', rgOnPath))
    expect(lines.some((l) => l.endsWith('a.txt-2-beta'))).toBe(true)
    expect(lines.some((l) => l.endsWith('a.txt:3:NEEDLE one'))).toBe(true)
    expect(lines.some((l) => l.endsWith('a.txt-4-delta'))).toBe(true)
    expect(lines.some((l) => l.includes('alpha'))).toBe(false)
    expect(lines.some((l) => l.includes('epsilon'))).toBe(false)
  }))

  it('context=0（默认）→ 只有命中行，没有上下文行', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE one', search_dir: dir }, 'darwin', rgOnPath))
    expect(lines).toHaveLength(1)
    expect(lines[0].endsWith('a.txt:3:NEEDLE one')).toBe(true)
  }))

  it('files_with_matches → 只回匹配文件的路径，不含行内容', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE', search_dir: dir, output_mode: 'files_with_matches' }, 'darwin', rgOnPath)).sort()
    expect(lines).toHaveLength(2)
    expect(lines[0].endsWith('a.txt')).toBe(true)
    expect(lines[1].endsWith('c.txt')).toBe(true)
    expect(lines.some((l) => l.includes('NEEDLE'))).toBe(false)
  }))

  it('count → path:N，零命中文件不出现', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE', search_dir: dir, output_mode: 'count' }, 'darwin', rgOnPath)).sort()
    expect(lines).toHaveLength(2)
    expect(lines[0].endsWith('a.txt:1')).toBe(true)
    expect(lines[1].endsWith('c.txt:2')).toBe(true)
    expect(lines.some((l) => l.includes('b.txt'))).toBe(false)
  }))

  it('100 行帽把上下文行也算进去——50 个命中 + context 1 只回 100 行（手册口径）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pm-search-cap-'))
    try {
      // HIT/pad alternating: every hit is adjacent to the next group, so rg
      // prints 400 contiguous lines with no `--` separators; head keeps 100.
      writeFileSync(join(dir, 'big.txt'), Array.from({ length: 200 }, () => 'HIT\npad').join('\n') + '\n')
      const lines = run(build({ query: 'HIT', search_dir: dir, context: 1 }, 'darwin', rgOnPath))
      expect(lines).toHaveLength(100)
      expect(lines.filter((l) => l.includes(':HIT')).length).toBe(50)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe.runIf(isUnix)('真执行：grep 回退臂（PATH 剥掉 rg，else 子臂真跑）', () => {
  const noRgEnv = { PATH: '/usr/bin:/bin' }

  it('前置：这个 PATH 下 rg 确实不可见，否则下面跑的是 rg 子臂', () => {
    const probe = spawnSync('/bin/sh', ['-c', 'command -v rg'], { encoding: 'utf8', env: noRgEnv })
    expect(probe.status).not.toBe(0)
  })

  it('context=1 → grep -C1 真出 ±1 行，- 分隔 + 行号', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE one', search_dir: dir, context: 1 }, 'darwin', null), noRgEnv)
    expect(lines.some((l) => l.endsWith('a.txt-2-beta'))).toBe(true)
    expect(lines.some((l) => l.endsWith('a.txt:3:NEEDLE one'))).toBe(true)
    expect(lines.some((l) => l.endsWith('a.txt-4-delta'))).toBe(true)
  }))

  it('files_with_matches → grep -l 只回路径', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE', search_dir: dir, output_mode: 'files_with_matches' }, 'darwin', null), noRgEnv).sort()
    expect(lines).toHaveLength(2)
    expect(lines.every((l) => /[ac]\.txt$/.test(l))).toBe(true)
  }))

  it('count → grep -c 的 :0 行被过滤，只剩真命中的 path:N', () => withFixture((dir) => {
    const lines = run(build({ query: 'NEEDLE', search_dir: dir, output_mode: 'count' }, 'darwin', null), noRgEnv).sort()
    expect(lines).toHaveLength(2)
    expect(lines[0].endsWith('a.txt:1')).toBe(true)
    expect(lines[1].endsWith('c.txt:2')).toBe(true)
    expect(lines.some((l) => l.endsWith(':0'))).toBe(false)
    // 非空验证：不过滤时 b.txt:0 确实会出现
    const raw = run(`grep -rc "NEEDLE" "${dir}"`, noRgEnv)
    expect(raw.some((l) => l.endsWith('b.txt:0'))).toBe(true)
  }))
})

// ── wiring ────────────────────────────────────────────────────────────────
describe('wiring：schema 承诺 = 执行器真读，手册同步', () => {
  const search = BUILT_IN_TOOLS.find((t) => t.name === 'search')!
  const props = (search.input_schema as { properties: Record<string, Record<string, unknown>> }).properties

  it('schema 带 output_mode（enum 三值）与 context（integer）', () => {
    expect(props.output_mode).toMatchObject({ type: 'string', enum: ['content', 'files_with_matches', 'count'] })
    expect(props.context).toMatchObject({ type: 'integer' })
    expect(String(props.context.description)).toMatch(/0-5/)
    expect((search.input_schema as { required: string[] }).required).toEqual(['query'])
  })

  it('search schema 的每个属性都被 command-builder 读取——webfetch 教训的反向钉', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/agent/command-builder.ts'), 'utf8')
    for (const key of Object.keys(props)) {
      expect(src, `schema property "${key}" is never read by the builder`).toContain(`input.${key}`)
    }
  })

  it('手册：讲清三种 output_mode、context 范围、100 行帽含上下文行；旧「100 matches」口径退场', () => {
    const manual = toolInstructions.search
    expect(manual).toContain('`output_mode`')
    expect(manual).toContain('`files_with_matches`')
    expect(manual).toContain('`count`')
    expect(manual).toContain('`context` (0–5)')
    expect(manual).toMatch(/100 LINES/)
    expect(manual).toContain('context lines count toward it')
    expect(manual).not.toContain('100 matches')
  })
})
