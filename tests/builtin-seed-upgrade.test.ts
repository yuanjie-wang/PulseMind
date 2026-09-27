import { describe, expect, it, beforeEach, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { skillStore } from '../src/main/storage/skill-store'
import { SKILLS_DIR } from '../src/main/storage/index'
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
  systemPrompt: '## Probe\n\nFirst shipped body — the text a previous release seeded.'
}
const v2: SkillDefinition = {
  ...v1,
  description: 'Seed upgrade probe, text the current bundle carries.',
  systemPrompt: '## Probe\n\nSecond shipped body — what the upgraded bundle carries.'
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
    expect(skillContentSignature(parseSkillMarkdown(readFileSync(MD_PATH, 'utf-8'), `${NAME}/SKILL.md`)))
      .toBe(skillContentSignature(v2))
  })
})
