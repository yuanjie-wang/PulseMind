import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skillStore } from '../src/main/storage/skill-store'
import { SKILLS_DIR } from '../src/main/storage/index'
import { BUILT_IN_SKILLS } from '../src/renderer/src/skills/built-in-skills'
import { formatSkillMd, parseSkillMarkdown, skillContentSignature } from '../src/main/utils/skill-parser'
import type { SkillDefinition } from '../src/shared/types/skill-types'

/**
 * 内置技能种子的原地升级（`ensureBuiltInSkills` 的第三个分支）。
 *
 * The drift this file pins: the agent-side skill registry is built from the
 * BUNDLED definitions — `SkillManager`'s constructor registers
 * `BUILT_IN_SKILLS` before the disk scan runs, and `register()` no-ops on a
 * live built-in's name — so pick_skill always served the new body after a
 * release changed a built-in's text, while the `**Location:**` line in the
 * same envelope advertised a seed that seeding never overwrites. Measured on
 * the dev machine: `create_skill`'s disk copy was still the PulseAI-era text
 * (old app name, old `~/.pulseai` path, a tool name since renamed). The cure
 * is the one write over an existing SKILL.md the provenance manifest can
 * prove safe: the file's signature equals what a previous launch recorded
 * seeding → the user never touched it → upgrade in place. Anything else
 * (a user edit, an unparseable file, a pre-manifest body) is kept, exactly as
 * before — the branch can only fire on content the app itself wrote.
 */

const NAME = 'probe_seed_upgrade'
const SKILL_DIR = join(SKILLS_DIR, NAME)
const MD_PATH = join(SKILL_DIR, 'SKILL.md')
const MANIFEST_PATH = join(SKILLS_DIR, '.seed-hashes.json')

const v1: SkillDefinition = {
  name: NAME,
  description: 'Seed upgrade probe, first shipped text.',
  category: 'probe',
  builtIn: true,
  triggers: ['probeupgrade'],
  systemPrompt: '## Probe\n\nFirst shipped body — the text a previous release seeded.',
}
const v2: SkillDefinition = {
  ...v1,
  description: 'Seed upgrade probe, text the current bundle carries.',
  systemPrompt: '## Probe\n\nSecond shipped body — what the upgraded bundle carries.',
}

const writeSkillFile = (content: string) => {
  mkdirSync(SKILL_DIR, { recursive: true })
  writeFileSync(MD_PATH, content, 'utf-8')
}
const readManifest = (): Record<string, string> => {
  try {
    return (JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as { seeds?: Record<string, string> }).seeds ?? {}
  } catch {
    return {}
  }
}

let manifestBefore: string | null
beforeEach(() => {
  manifestBefore = existsSync(MANIFEST_PATH) ? readFileSync(MANIFEST_PATH, 'utf-8') : null
  rmSync(SKILL_DIR, { recursive: true, force: true })
  // Each case states its own provenance precondition — a manifest entry left
  // by the previous case would silently authorize (or block) the upgrade.
  rmSync(MANIFEST_PATH, { force: true })
})
afterAll(() => {
  rmSync(SKILL_DIR, { recursive: true, force: true })
  // The manifest is shared with the user's real seeds — put back whatever the
  // suite started with instead of leaving probe entries behind.
  if (manifestBefore === null) rmSync(MANIFEST_PATH, { force: true })
  else writeFileSync(MANIFEST_PATH, manifestBefore, 'utf-8')
})

describe('built-in seed upgrade — provenance decides whose text wins', () => {
  it('upgrades our own untouched seed when the bundled text moves on', async () => {
    await skillStore.ensureBuiltInSkills([v1])
    expect(readFileSync(MD_PATH, 'utf-8')).toContain('First shipped body')
    expect(readManifest()[NAME]).toBe(skillContentSignature(v1))

    await skillStore.ensureBuiltInSkills([v2])
    const upgraded = readFileSync(MD_PATH, 'utf-8')
    expect(upgraded).toContain('Second shipped body')
    expect(upgraded).not.toContain('First shipped body')
    expect(readManifest()[NAME]).toBe(skillContentSignature(v2))
    // The upgraded file is byte-identical to what a fresh install would get.
    expect(upgraded).toBe(formatSkillMd(v2))
  })

  it('a user edit survives the upgrade — provenance no longer matches', async () => {
    await skillStore.ensureBuiltInSkills([v1])
    writeSkillFile(formatSkillMd(v1).replace('First shipped body', 'MY OWN EDIT'))

    await skillStore.ensureBuiltInSkills([v2])
    expect(readFileSync(MD_PATH, 'utf-8')).toContain('MY OWN EDIT')
    expect(readFileSync(MD_PATH, 'utf-8')).not.toContain('Second shipped body')
    // The recorded seed stays v1: if the user ever reverts their edit, the
    // next launch upgrades from there.
    expect(readManifest()[NAME]).toBe(skillContentSignature(v1))
  })

  it('a pre-manifest body is still only ever kept — the branch needs recorded provenance', async () => {
    writeSkillFile(formatSkillMd(v1))

    await skillStore.ensureBuiltInSkills([v2])
    expect(readFileSync(MD_PATH, 'utf-8')).toContain('First shipped body')
    expect(readManifest()[NAME]).toBeUndefined()
  })

  it('an unparseable file is user content — kept, never adopted, never upgraded', async () => {
    writeSkillFile('not a skill file at all')

    await skillStore.ensureBuiltInSkills([v2])
    expect(readFileSync(MD_PATH, 'utf-8')).toBe('not a skill file at all')
  })

  it('round-trips: re-running with the live text adopts instead of rewriting', async () => {
    await skillStore.ensureBuiltInSkills([v1])
    await skillStore.ensureBuiltInSkills([v2])
    expect(readFileSync(MD_PATH, 'utf-8')).toBe(formatSkillMd(v2))
    // Adoption arm: content already equals the live definition — signature
    // stable, no third state.
    expect(skillContentSignature(parseSkillMarkdown(readFileSync(MD_PATH, 'utf-8'), `${NAME}/SKILL.md`))).toBe(skillContentSignature(v2))
  })
})

describe('the trailing-newline asymmetry — historical seeds must not strand (2026-11-04)', () => {
  /**
   * The bug this block pins: browser/office prompts shipped ending with a
   * trailing newline. `formatSkillMd` wrote it verbatim, `parseSkillMarkdown`
   * `.trim()`ed it off, so the parsed signature could never equal the
   * manifest's record (taken from the DEFINITION at seed time) — the upgrade
   * arm and the adoption arm were both dead for such skills, and every text
   * update stranded on disk forever. Measured on the dev machine: the browser
   * manual's disk copy was one revision behind the bundle with zero way to
   * converge, on the very day the login-wall rule shipped.
   */

  const v1t: SkillDefinition = { ...v1, systemPrompt: v1.systemPrompt + '\n' }

  it('a trailing-newline seed still upgrades — provenance survives the parse trim', async () => {
    await skillStore.ensureBuiltInSkills([v1t])
    expect(readManifest()[NAME]).toBe(skillContentSignature(v1t))

    await skillStore.ensureBuiltInSkills([v2])
    const upgraded = readFileSync(MD_PATH, 'utf-8')
    expect(upgraded).toContain('Second shipped body')
    expect(upgraded).not.toContain('First shipped body')
    expect(readManifest()[NAME]).toBe(skillContentSignature(v2))
  })

  it('a trailing-newline seed still gets adopted when its text IS current — future updates must be able to fire', async () => {
    // The office case on the dev machine: disk text already equals the
    // bundle, only the record never matched. Adoption must claim it anyway —
    // without the manifest entry, the NEXT text update would strand.
    writeSkillFile(formatSkillMd(v1t))
    await skillStore.ensureBuiltInSkills([v1t])
    expect(readFileSync(MD_PATH, 'utf-8')).toBe(formatSkillMd(v1t))
    expect(readManifest()[NAME]).toBe(skillContentSignature(v1t))
  })

  it('a user edit on a trailing-newline seed is still user content', async () => {
    await skillStore.ensureBuiltInSkills([v1t])
    writeSkillFile(formatSkillMd(v1t).replace('First shipped body', 'MY OWN EDIT'))

    await skillStore.ensureBuiltInSkills([v2])
    expect(readFileSync(MD_PATH, 'utf-8')).toContain('MY OWN EDIT')
    expect(readManifest()[NAME]).toBe(skillContentSignature(v1t))
  })

  it('every current built-in round-trips losslessly — no prompt may regain a trailing newline', () => {
    for (const def of BUILT_IN_SKILLS) {
      const rt = parseSkillMarkdown(formatSkillMd(def), `${def.name}/SKILL.md`)
      expect(rt.systemPrompt, `${def.name}.systemPrompt`).toBe(def.systemPrompt)
      expect(skillContentSignature(rt), `${def.name} signature`).toBe(skillContentSignature(def))
    }
  })

  it('wiring: adoption/upgrade/retired-sweep all compare through skillProvenanceMatches', () => {
    const src = readFileSync(fileURLToPath(new URL('../src/main/storage/skill-store.ts', import.meta.url)), 'utf-8')
    expect(src.match(/skillProvenanceMatches\(existingParsed, signature\)/u)?.length).toBe(1)
    expect(src.match(/skillProvenanceMatches\(existingParsed, seeds\[skill\.name\]\)/u)?.length).toBe(1)
    expect(src).toContain('skillProvenanceMatches(signature, seeds[retired.name], retired.contentHash)')
    // The naive compares must not come back.
    expect(src).not.toMatch(/seeds\[skill\.name\] === existingSig/u)
    expect(src).not.toMatch(/signature !== seeds\[retired\.name\] && signature !== retired\.contentHash/u)
  })
})
