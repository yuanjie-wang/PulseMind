import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── full_20261011 M9-P0-1: four "join a caller-supplied name onto a data dir
// then rm/unlink" entry points had NO path validation. `name='..'` made
// join(DIR, '..') the DATA_DIR itself and the recursive rm happily deleted
// every conversation, the knowledge base, settings.json and the MCP
// credentials; routine ids rode a `.json` suffix that made traversal
// convenient (`'../settings'` → settings.json). skill-store already carried
// the right shape (resolveSkillDir) and knowledge-store the validate-then-
// delete pattern — this pins the shared guard and every entry point that now
// routes through it.
//
// getDb must never be reached here (hostile names throw at the guard BEFORE
// the DB touch, and the throwaway HOME has no db dir — keep it loud).
vi.mock('../src/main/storage/database', () => ({
  getDb: () => { throw new Error('getDb must not be reached in safe-name tests') },
}))

import { safeChildPath } from '../src/main/storage/safe-name'
import { DATA_DIR, SKILLS_DIR, TOOLS_DIR } from '../src/main/storage/index'
import { ROUTINES_DIR, routineStore } from '../src/main/storage/routine-store'
import { toolStore } from '../src/main/storage/tool-store'
import { skillStore } from '../src/main/storage/skill-store'

describe('safeChildPath', () => {
  const base = '/data/root'
  it('accepts plain child names and nested paths', () => {
    expect(safeChildPath(base, 'abc')).toBe(join(base, 'abc'))
    expect(safeChildPath(base, 'a/b/SKILL.md')).toBe(join(base, 'a/b/SKILL.md'))
    expect(safeChildPath(base, 'x.json')).toBe(join(base, 'x.json'))
  })
  it('rejects empty, NUL, dot and traversal spellings', () => {
    expect(safeChildPath(base, '')).toBeNull()
    expect(safeChildPath(base, '..')).toBeNull()
    expect(safeChildPath(base, '../settings')).toBeNull()
    expect(safeChildPath(base, 'a/../../out')).toBeNull()
    expect(safeChildPath(base, 'a\0b')).toBeNull()
    expect(safeChildPath(base, '.')).toBeNull()
  })

  it('an absolute NAME is folded inside by join (never escapes, stays a child)', () => {
    // node's join treats a leading separator as a segment: join(base, '/etc')
    // is base/etc — the guard's job is "never leave baseDir", and this stays.
    const p = safeChildPath(base, '/etc/passwd')!
    expect(p.startsWith(base + '/')).toBe(true)
  })
})

describe('storage delete/write entry points refuse escaping names (M9-P0-1)', () => {
  it('toolStore.remove refuses traversal and empty ids', () => {
    // The throwaway HOME starts bare — materialize the layout the assertions probe.
    mkdirSync(DATA_DIR, { recursive: true })
    expect(() => toolStore.remove('..')).toThrow(/invalid tool id/)
    expect(() => toolStore.remove('')).toThrow(/invalid tool id/)
    expect(() => toolStore.remove('../../settings')).toThrow(/invalid tool id/)
    expect(existsSync(DATA_DIR)).toBe(true)
    // A plain (even unknown) id still passes the guard and no-ops on disk:
    expect(() => toolStore.remove('definitely-not-a-tool')).not.toThrow()
  })

  it('routineStore.remove refuses the `.json`-suffixed traversal', () => {
    mkdirSync(DATA_DIR, { recursive: true })
    const settingsPath = join(DATA_DIR, 'settings.json')
    const sentinel = '{ "probe": true }'
    if (!existsSync(settingsPath)) writeFileSync(settingsPath, sentinel, 'utf-8')
    const before = readFileSync(settingsPath, 'utf-8')
    expect(() => routineStore.remove('../settings')).toThrow(/invalid routine id/)
    expect(() => routineStore.remove('../../mcp/mcp-servers')).toThrow(/invalid routine id/)
    expect(readFileSync(settingsPath, 'utf-8')).toBe(before)
    expect(() => routineStore.remove('no-such-routine')).not.toThrow()
  })

  it('skillStore delete/write/read route through resolveSkillDir', async () => {
    await expect(skillStore.deleteImported('..')).rejects.toThrow(/invalid skill name/)
    await expect(skillStore.write({ name: '../evil' } as never)).rejects.toThrow(/invalid skill name/)
    expect(existsSync(join(DATA_DIR, 'evil'))).toBe(false)
    // install/readRaw are reads — a TRULY escaping name answers null, never
    // the decoy. (`../skills/<x>` resolves back INSIDE skills by join
    // semantics — the pick_skill whitelist bypass against it is closed at the
    // renderer gate, which only reads experiences listed by em.list(); the
    // storage guard's contract is "never leave the root".)
    const decoyDir = join(DATA_DIR, 'evil')
    mkdirSync(decoyDir, { recursive: true })
    writeFileSync(join(decoyDir, 'SKILL.md'), '---\nname: evil\ndescription: decoy\n---\nBody', 'utf-8')
    expect(await skillStore.install('../../evil')).toBeNull()
    expect(await skillStore.readRawContent('../../evil')).toBeNull()
    expect(SKILLS_DIR).toBeTruthy()
    expect(ROUTINES_DIR).toBeTruthy()
    expect(TOOLS_DIR).toBeTruthy()
  })
})
