import { afterEach, describe, expect, it, vi } from 'vitest'

// ── full_20261011 M10-P0-1: svcSearchWiki passed the model-controlled query
// to rg/grep as a BARE positional argument. execFile avoids the shell but not
// option parsing, and rg has an option that executes a program:
// `--pre=/bin/sh` ran /bin/sh with each searched file as its argument —
// measured with the repo's own rg 14.1.1 (rc=1, the preprocessor fired).
// knowledge_search is read-tier (never held), so this was a no-approval,
// no-audit execution path. The fix passes the query through `-e` (consumed as
// a VALUE, same shape as the multi-term branch) and terminates option parsing
// with `--` before the search dir.

const execCalls: Array<{ cmd: string; args: string[] }> = []

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    execCalls.push({ cmd, args })
    cb(null, '')
  },
}))

// searchDir skips a non-existent wiki dir, so the factory mints a real one.
// Tests read the same path back through the mocked module itself.
vi.mock('../src/main/storage', async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const base = mkdtempSync(join(tmpdir(), 'pm-kinj-'))
  const wiki = join(base, 'wiki')
  mkdirSync(wiki, { recursive: true })
  return {
    getBaseRawDir: () => join(base, 'raw'),
    getBaseWikiDir: () => wiki,
  }
})

vi.mock('../src/main/utils/ripgrep', async (importOriginal) => {
  // buildRgSearchArgs (review_20261013 高2) rides the same module — the wiki
  // channel delegates to it now, so the mock must keep the real builder and
  // stub only the binary/parse pair.
  const actual = await importOriginal<typeof import('../src/main/utils/ripgrep')>()
  return {
    ...actual,
    ripgrepBinary: () => '/usr/bin/rg',
    parseRgLine: () => null,
  }
})

// The service pulls ~30 names off the store; only wikiFtsCount matters here
// (0 → the local FTS wrapper short-circuits → the rg fallback runs). A loop
// keeps the factory honest about the rest without executing the real store
// (it needs better-sqlite3). The name list lives INSIDE the factory — vi.mock
// is hoisted above top-level declarations.
vi.mock('../src/main/storage/knowledge-store', () => {
  const names = [
    'importLocalFiles', 'importUrl', 'reextractKnowledge', 'abortKnowledgeImport', 'prepareImport',
    'readRawContent', 'readWikiContent', 'listWikiFiles', 'saveExperienceToRaw', 'saveFavoriteToRaw',
    'getStats', 'markFileCompiled', 'applyWikiChanges', 'appendWikiLog', 'clearAllKnowledge',
    'rebuildWikiIndex', 'searchContent', 'listAllFiles', 'listAllFilesAdvanced', 'getFile',
    'deleteFile', 'getSchemaContent', 'isValidWikiPagePath', 'wikiFtsCount', 'rebuildWiki',
    'listAllBases', 'createKnowledgeBase', 'renameKnowledgeBaseById', 'removeKnowledgeBase',
    'moveKnowledgeFileToBase', 'moveKnowledgeFilesToBase',
  ]
  const mod: Record<string, unknown> = {}
  for (const n of names) mod[n] = n === 'wikiFtsCount' ? () => 0 : () => undefined
  return mod
})

vi.mock('../src/main/storage/database', () => ({ getDb: () => { throw new Error('no db in this test') } }))

import { svcSearchWiki } from '../src/main/services/knowledge-queries'
import { getBaseWikiDir } from '../src/main/storage'

afterEach(() => { execCalls.length = 0 })

describe('svcSearchWiki — query is a value, never an option (full_20261011 M10-P0-1)', () => {
  it('a --pre= query lands as an -e VALUE, and -- terminates options before the dir', async () => {
    const hostile = '--pre=/bin/sh'
    const wikiDir = getBaseWikiDir('base1')
    await svcSearchWiki(hostile, 'base1')
    expect(execCalls.length).toBeGreaterThan(0)
    const rg = execCalls.find(c => c.cmd === '/usr/bin/rg')
    expect(rg).toBeDefined()
    const args = rg!.args
    // The query is the value of -e — the exact position rg reads the pattern
    // from, where option parsing cannot reach it:
    expect(args.includes(hostile)).toBe(true)
    expect(args[args.indexOf(hostile) - 1]).toBe('-e')
    // `--` sits between the last option-ish token and the search dir:
    const dashDash = args.indexOf('--')
    expect(dashDash).toBeGreaterThan(-1)
    expect(args[dashDash + 1]).toBe(wikiDir)
    expect(args[args.length - 1]).toBe(wikiDir)
    // No bare positional query token anywhere outside the -e pair:
    expect(args.filter(a => a === hostile)).toHaveLength(1)
  })

  it('the grep fallback (single-term retry shape) gets the same treatment', async () => {
    const hostile = '--exclude-dir=/'
    const wikiDir = getBaseWikiDir('base1')
    await svcSearchWiki(hostile, 'base1')
    const grep = execCalls.find(c => c.cmd === 'grep')
    if (!grep) return // non-unix CI — rg assertions above still cover the builder
    expect(grep.args.includes(hostile)).toBe(true)
    expect(grep.args[grep.args.indexOf(hostile) - 1]).toBe('-e')
    const dashDash = grep.args.indexOf('--')
    expect(dashDash).toBeGreaterThan(-1)
    expect(grep.args[dashDash + 1]).toBe(wikiDir)
  })

  it('ordinary queries still produce the same shape as the multi-term branch', async () => {
    await svcSearchWiki('react hooks', 'base1')
    const rg = execCalls.find(c => c.cmd === '/usr/bin/rg')
    expect(rg).toBeDefined()
    expect(rg!.args.slice(0, 6)).toEqual(['-n', '--no-heading', '-i', '--max-columns', '300', '--max-count'])
    expect(rg!.args.includes('-F')).toBe(true)
    expect(rg!.args.includes('-e')).toBe(true)
  })
})
