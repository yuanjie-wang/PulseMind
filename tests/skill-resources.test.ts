import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { resolveSkillResourcePath, seedSkillResources } from '../src/main/utils/skill-resources'
import { BUILT_IN_SKILLS } from '../src/renderer/src/skills/built-in-skills'
import { formatSkillMd, parseSkillMarkdown } from '../src/main/utils/skill-parser'

const newDir = (): string => mkdtempSync(join(tmpdir(), 'pm-skill-res-'))

describe('resolveSkillResourcePath — the skill-directory boundary', () => {
  const dir = join(tmpdir(), 'skill-dir')

  it('resolves a plain skill-relative path', () => {
    expect(resolveSkillResourcePath(dir, 'references/xlsx.md')).toBe(join(dir, 'references/xlsx.md'))
  })

  it('resolves a nested path', () => {
    expect(resolveSkillResourcePath(dir, 'a/b/c.md')).toBe(join(dir, 'a/b/c.md'))
  })

  it('normalizes an interior `..` that stays inside', () => {
    expect(resolveSkillResourcePath(dir, 'references/../notes.md')).toBe(join(dir, 'notes.md'))
  })

  it('rejects an escaping path — the whole reason this function exists', () => {
    expect(resolveSkillResourcePath(dir, '../escape.md')).toBeNull()
    expect(resolveSkillResourcePath(dir, 'references/../../escape.md')).toBeNull()
    expect(resolveSkillResourcePath(dir, 'a/b/../../../escape.md')).toBeNull()
  })

  it('rejects absolute paths, POSIX and Windows', () => {
    expect(resolveSkillResourcePath(dir, '/etc/hosts')).toBeNull()
    expect(resolveSkillResourcePath(dir, 'C:\\Windows\\x.md')).toBeNull()
  })

  it('rejects empty and directory-self paths', () => {
    expect(resolveSkillResourcePath(dir, '')).toBeNull()
    expect(resolveSkillResourcePath(dir, '   ')).toBeNull()
    expect(resolveSkillResourcePath(dir, '.')).toBeNull()
    expect(resolveSkillResourcePath(dir, 'references/..')).toBeNull()
  })
})

describe('seedSkillResources — seeding policy', () => {
  it('writes nested files, creating parent directories', async () => {
    const dir = newDir()
    const written = await seedSkillResources(dir, { 'references/a.md': 'A', 'b/c.md': 'C' })
    expect(written.sort()).toEqual([join(dir, 'b/c.md'), join(dir, 'references/a.md')].sort())
    expect(readFileSync(join(dir, 'references/a.md'), 'utf-8')).toBe('A')
    expect(readFileSync(join(dir, 'b/c.md'), 'utf-8')).toBe('C')
  })

  it('never overwrites an existing file — a user edit wins', async () => {
    const dir = newDir()
    await seedSkillResources(dir, { 'references/a.md': 'shipped v1' })
    const second = await seedSkillResources(dir, { 'references/a.md': 'shipped v2' })
    expect(second).toEqual([])
    expect(readFileSync(join(dir, 'references/a.md'), 'utf-8')).toBe('shipped v1')
  })

  it('skips escaping paths instead of writing outside the skill', async () => {
    const dir = newDir()
    const written = await seedSkillResources(dir, { '../escape.md': 'nope', 'ok.md': 'yes' })
    expect(written).toEqual([join(dir, 'ok.md')])
    expect(existsSync(join(dir, '..', 'escape.md'))).toBe(false)
    expect(readFileSync(join(dir, 'ok.md'), 'utf-8')).toBe('yes')
  })

  it('is a no-op without a resource map', async () => {
    expect(await seedSkillResources(newDir(), undefined)).toEqual([])
  })
})

describe('seedSkillResources — the provenance upgrade arm (2026-10-07)', () => {
  const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
  const harness = () => {
    const seeds: Record<string, string> = {}
    const recorded: string[] = []
    return {
      seeds,
      recorded,
      provenance: {
        seeds,
        record: (key: string, sig: string) => {
          seeds[key] = sig
          recorded.push(key)
        },
        skillName: 'office',
      },
    }
  }

  it('a manifest-recorded seed upgrades in place when the shipped text moves on', async () => {
    const dir = newDir()
    const h = harness()
    await seedSkillResources(dir, { 'references/pptx.md': 'shipped v1' }, h.provenance)
    expect(h.seeds['office#references/pptx.md']).toBe(sha('shipped v1'))
    const second = await seedSkillResources(dir, { 'references/pptx.md': 'shipped v2 — recipes' }, h.provenance)
    expect(second).toEqual([join(dir, 'references/pptx.md')])
    expect(readFileSync(join(dir, 'references/pptx.md'), 'utf-8')).toBe('shipped v2 — recipes')
    expect(h.seeds['office#references/pptx.md']).toBe(sha('shipped v2 — recipes'))
  })

  it('a user-edited reference still wins — the manifest does not record it as ours', async () => {
    const dir = newDir()
    const h = harness()
    await seedSkillResources(dir, { 'references/pptx.md': 'shipped v1' }, h.provenance)
    // the user edits the file behind the app's back
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'references/pptx.md'), 'my hand-tuned rules', 'utf-8')
    const second = await seedSkillResources(dir, { 'references/pptx.md': 'shipped v2' }, h.provenance)
    expect(second).toEqual([])
    expect(readFileSync(join(dir, 'references/pptx.md'), 'utf-8')).toBe('my hand-tuned rules')
  })

  it('a pre-manifest seed whose content IS the shipped text gets adopted, not rewritten', async () => {
    const dir = newDir()
    const h = harness()
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'references/pptx.md'), 'shipped v1', 'utf-8') // seeded before manifests existed
    const second = await seedSkillResources(dir, { 'references/pptx.md': 'shipped v1' }, h.provenance)
    expect(second).toEqual([])
    expect(h.seeds['office#references/pptx.md']).toBe(sha('shipped v1'))
    expect(h.recorded).toContain('office#references/pptx.md')
  })

  it('without provenance the write-once behavior is unchanged (old callers)', async () => {
    const dir = newDir()
    await seedSkillResources(dir, { 'references/a.md': 'v1' })
    const second = await seedSkillResources(dir, { 'references/a.md': 'v2' })
    expect(second).toEqual([])
    expect(readFileSync(join(dir, 'references/a.md'), 'utf-8')).toBe('v1')
  })
})

/**
 * 真实数据断言（非空转）：内置技能的每个 resource 路径都必须落在技能目录内，
 * 且 SKILL.md 正文点名的 references/*.md 必须真的有对应文件——正文是模型唯一
 * 的索引，指向不存在的文件等于让模型去 read 一个 404。
 */
describe('built-in skills — every referenced file ships', () => {
  const REFERENCE_PATH_RE = /references\/[A-Za-z0-9._-]+\.md/g

  it('every declared resource path stays inside its skill directory', () => {
    for (const skill of BUILT_IN_SKILLS) {
      for (const relPath of Object.keys(skill.resources || {})) {
        expect(
          resolveSkillResourcePath(`/skills/${skill.name}`, relPath),
          `${skill.name}: resource path "${relPath}" must resolve inside the skill directory`
        ).not.toBeNull()
      }
    }
  })

  it('every reference named in a SKILL.md body is a declared resource', () => {
    for (const skill of BUILT_IN_SKILLS) {
      const declared = new Set(Object.keys(skill.resources || {}))
      const named = skill.systemPrompt.match(REFERENCE_PATH_RE) || []
      for (const path of named) {
        expect(declared, `${skill.name}: body names "${path}" but no such resource ships`).toContain(path)
      }
    }
  })

  it('the office skill ships the three format rule sets its body routes to', () => {
    const office = BUILT_IN_SKILLS.find((s) => s.name === 'office')
    expect(office).toBeDefined()
    expect(Object.keys(office!.resources!).sort()).toEqual([
      'references/docx.md',
      'references/pptx.md',
      'references/xlsx.md',
    ])
    // Every rule set must be substantial — a stub would silently under-deliver.
    for (const [path, content] of Object.entries(office!.resources!)) {
      expect(content.length, `${path} looks like a stub`).toBeGreaterThan(1200)
    }
  })

  it('round-trips through SKILL.md without leaking resources into the frontmatter', () => {
    const office = BUILT_IN_SKILLS.find((s) => s.name === 'office')!
    const md = formatSkillMd(office)
    const lines = md.split('\n')
    const end = lines.indexOf('---', 1)
    const frontmatter = lines.slice(1, end).join('\n')
    expect(frontmatter).toContain('name: office')
    expect(frontmatter).not.toContain('resources')

    // The seeded copy is what `listImported` / `install` read back, so the
    // round trip has to survive with the routing intact.
    const parsed = parseSkillMarkdown(md, 'office/SKILL.md')
    expect(parsed.name).toBe('office')
    expect(parsed.triggers).toContain('docx')
    expect(parsed.systemPrompt).toContain('references/docx.md')
  })
})

/**
 * The skill body's "read references/<file>" instruction needs an absolute
 * anchor. This is wiring, not logic (vitest here is node-env — the engine
 * cannot be mounted), so it is asserted as source, with each scan pinned to
 * the specific wiring text so a revert fails instead of scanning nothing.
 */
describe('the skill location reaches the model — the references read path', () => {
  const readSrc = (rel: string): string => readFileSync(join(__dirname, '..', rel), 'utf-8')

  it('pick_skill names the SKILL.md location in its envelope, on both lookup paths', () => {
    const src = readSrc('src/renderer/src/agent/tool-executors.ts')
    expect(src).toContain('**Location:**')
    // by-name and by-intent envelopes both go through the disk-fresh read
    // (freshSkillDefinition) and the helper with skillsDir — the envelope and
    // the file its **Location:** line advertises must be the same text, not
    // the never-refreshed registry copy.
    expect(src).toContain('await this.freshSkillDefinition(skillName, skill.definition)')
    // intent 分支的局部变量在 audit 2026-10-10 #9 改名为 selectedSkill（白名单
    // 只拦技能的判定要先查注册表）——磁盘新读的契约不变。
    expect(src).toContain('await this.freshSkillDefinition(cleanName, selectedSkill.definition)')
    expect(src).toContain('formatSelectedSkill(skill.definition.name, def, this.opts.skillsDir)')
    expect(src).toContain('formatSelectedSkill(cleanName, def, this.opts.skillsDir)')
  })

  it('spawn-tool passes the engine skillsDir, so sub-agent locations are absolute', () => {
    const src = readSrc('src/renderer/src/agent/executors/spawn-tool.ts')
    expect(src).toMatch(/getSystemPromptAppendix\(\s*ex\.opts\.skillsDir\s*,/)
  })

  it('the office body anchors on the Location line / Skills Directory, not a phantom <available_skills>', () => {
    const office = BUILT_IN_SKILLS.find((s) => s.name === 'office')!
    // The main desktop loop never emits <available_skills> (only spawn
    // prompts do) — the body must not send the model looking for it.
    expect(office.systemPrompt).not.toContain('<available_skills>')
    expect(office.systemPrompt).toContain('Location')
    expect(office.systemPrompt).toContain('Skills Directory')
  })
})
