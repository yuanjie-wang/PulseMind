import { describe, it, expect } from 'vitest'
import { guardPath, buildDenyRoots, buildBaselineDenyRoots, resolveTarget } from '../src/shared/sandbox/path-jail'

const HOME = '/Users/dev'
const WORKSPACE = '/Users/dev/code/my-app'
const denyRoots = buildDenyRoots(HOME, 'darwin')
const base = { denyRoots, workspaceDir: WORKSPACE }

describe('resolveTarget', () => {
  it('hangs relative paths off the workspace', () => {
    expect(resolveTarget(WORKSPACE, 'src/a.ts')).toBe(`${WORKSPACE}/src/a.ts`)
  })
  it('keeps absolute paths', () => {
    expect(resolveTarget(WORKSPACE, '/etc/hosts')).toBe('/etc/hosts')
  })
})

describe('guardPath — reads', () => {
  it('allow reads inside the workspace', () => {
    expect(guardPath({ ...base, target: 'src/a.ts', operation: 'read' }).ok).toBe(true)
  })
  it('allow reads outside the workspace (agent may look around)', () => {
    expect(guardPath({ ...base, target: '/usr/local/share/x.json', operation: 'read' }).ok).toBe(true)
  })
  it('deny reads of protected roots', () => {
    const d = guardPath({ ...base, target: `${HOME}/.ssh/id_rsa`, operation: 'read' })
    expect(d.ok).toBe(false)
  })
  it('deny reads resolved through symlinks into protected roots', () => {
    const d = guardPath({ ...base, target: '/tmp/idrsa', operation: 'read', realTarget: `${HOME}/.ssh/id_rsa` })
    expect(d.ok).toBe(false)
  })
})

describe('guardPath — writes (workspace-write)', () => {
  it('allow writes inside the workspace', () => {
    expect(guardPath({ ...base, target: 'src/out.ts', operation: 'write' }).ok).toBe(true)
  })
  it('deny writes outside the workspace', () => {
    const d = guardPath({ ...base, target: '/Users/dev/Desktop/evil.txt', operation: 'write' })
    expect(d.ok).toBe(false)
    expect(d.ok ? '' : d.reason).toMatch(/outside the workspace/)
  })
  it('block traversal that escapes the workspace lexically', () => {
    const d = guardPath({ ...base, target: '../escape.txt', operation: 'write' })
    expect(d.ok).toBe(false)
  })
  it('deny writes into ~/.pulsemind even from a workspace session', () => {
    const d = guardPath({ ...base, target: `${HOME}/.pulsemind/db/pulsemind.db`, operation: 'write' })
    expect(d.ok).toBe(false)
  })
  it('allow writes through a symlink landing inside the workspace', () => {
    const d = guardPath({ ...base, target: '/tmp/link-out.txt', operation: 'write', realTarget: `${WORKSPACE}/out.txt` })
    expect(d.ok).toBe(true)
  })
  it('deny writes through a symlink landing outside the workspace', () => {
    const d = guardPath({ ...base, target: `${WORKSPACE}/link`, operation: 'write', realTarget: '/Users/dev/Desktop/evil.txt' })
    expect(d.ok).toBe(false)
  })
  it('treat the workspace root itself as writable', () => {
    expect(guardPath({ ...base, target: WORKSPACE, operation: 'write' }).ok).toBe(true)
  })
})

describe('guardPath — baseline (no session)', () => {
  const baselineRoots = buildBaselineDenyRoots(HOME, 'darwin')
  it('allows app-internal writes into ~/.pulsemind', () => {
    const d = guardPath({ denyRoots: baselineRoots, target: `${HOME}/.pulsemind/knowledge/raw/a.md`, operation: 'write' })
    expect(d.ok).toBe(true)
  })
  it('still denies secrets', () => {
    expect(guardPath({ denyRoots: baselineRoots, target: `${HOME}/.ssh/id_rsa`, operation: 'read' }).ok).toBe(false)
  })
  it('denies the executable/config surface of the app itself (full_20261011 M8-F2)', () => {
    // A renderer-side UTIL write into hooks/ is code require()d by the NEXT
    // main process; settings.json / mcp-servers.json carry credentials and
    // spawn commands; db/ is the conversation store.
    for (const target of [
      `${HOME}/.pulsemind/hooks/app-start.js`,
      `${HOME}/.pulsemind/settings.json`,
      `${HOME}/.pulsemind/mcp/mcp-servers.json`,
      `${HOME}/.pulsemind/db/pulsemind.db`,
    ]) {
      for (const operation of ['write', 'read'] as const) {
        const d = guardPath({ denyRoots: baselineRoots, target, operation })
        expect(d.ok, `${operation} ${target}`).toBe(false)
      }
    }
    // …while the app's own working surfaces stay writable:
    expect(guardPath({ denyRoots: baselineRoots, target: `${HOME}/.pulsemind/tmp/html-cards/x.html`, operation: 'write' }).ok).toBe(true)
    expect(guardPath({ denyRoots: baselineRoots, target: `${HOME}/.pulsemind/skills/foo/SKILL.md`, operation: 'write' }).ok).toBe(true)
  })
})

describe('guardPath — workspace under a deny root (M8.1)', () => {
  // The default PulseMind workspace sits inside the protected ~/.pulsemind root;
  // the session's own workspace must stay writable despite the ancestor deny.
  const buried = `${HOME}/.pulsemind/workspace/20260912103000`
  const buriedBase = { denyRoots, workspaceDir: buried }

  it('allow writes inside a workspace that lives under ~/.pulsemind', () => {
    expect(guardPath({ ...buriedBase, target: 'notes/a.md', operation: 'write' }).ok).toBe(true)
    expect(guardPath({ ...buriedBase, target: buried, operation: 'write' }).ok).toBe(true)
  })
  it('allow reads inside the buried workspace', () => {
    expect(guardPath({ ...buriedBase, target: 'notes/a.md', operation: 'read' }).ok).toBe(true)
  })
  it('still deny ~/.pulsemind paths outside the buried workspace', () => {
    const d = guardPath({ ...buriedBase, target: `${HOME}/.pulsemind/db/pulsemind.db`, operation: 'write' })
    expect(d.ok).toBe(false)
    expect(guardPath({ ...buriedBase, target: `${HOME}/.pulsemind/settings.json`, operation: 'read' }).ok).toBe(false)
  })
  it('still deny writes to secrets outside the buried workspace', () => {
    expect(guardPath({ ...buriedBase, target: `${HOME}/.ssh/id_rsa`, operation: 'write' }).ok).toBe(false)
  })
  it('deny a symlink from the workspace into a protected root (realpath governs)', () => {
    const d = guardPath({ ...buriedBase, target: `${buried}/link`, operation: 'write', realTarget: `${HOME}/.pulsemind/memory/MEMORY.md` })
    expect(d.ok).toBe(false)
  })
  it('keep baseline (no session) deny behavior unchanged', () => {
    const baselineRoots = buildBaselineDenyRoots(HOME, 'darwin')
    expect(guardPath({ denyRoots: baselineRoots, target: `${HOME}/.pulsemind/workspace/x`, operation: 'write' }).ok).toBe(true)
  })
})

describe('guardPath — dual-coordinate workspace (workspaceReal)', () => {
  // realTarget is always canonical; a workspace whose ancestors include a
  // symlink (/tmp → /private/tmp) is spelled differently from its real path.
  // Judging real against the lexical root denied EVERY op inside such a
  // workspace (measured: svcCopyFile's session cases failed on it).
  const lexicalWs = '/tmp/pm-workspace'
  const realWs = '/private/tmp/pm-workspace'
  const dualBase = { denyRoots, workspaceDir: lexicalWs, workspaceReal: realWs }

  it('allow a canonical write inside the canonical root', () => {
    const d = guardPath({ ...dualBase, target: `${lexicalWs}/out.txt`, operation: 'write', realTarget: `${realWs}/out.txt` })
    expect(d.ok).toBe(true)
  })

  it('deny a canonical write escaping BOTH spellings', () => {
    const d = guardPath({ ...dualBase, target: `${lexicalWs}/link`, operation: 'write', realTarget: '/Users/dev/Desktop/evil.txt' })
    expect(d.ok).toBe(false)
    expect(d.ok ? '' : d.reason).toMatch(/outside the workspace/)
  })

  it('keep the deny-root exemption working under the spelling mismatch', () => {
    // Workspace under ~/.pulsemind (a deny root for sessions): realInside must
    // be judged against workspaceReal, or the exemption collapses and the
    // session loses its own workspace to the ancestor deny.
    const buriedLex = '/tmp/.pulsemind/workspace/ws1'
    const buriedReal = '/private/tmp/.pulsemind/workspace/ws1'
    const d = guardPath({
      denyRoots,
      workspaceDir: buriedLex,
      workspaceReal: buriedReal,
      target: `${buriedLex}/notes.md`,
      operation: 'write',
      realTarget: `${buriedReal}/notes.md`,
    })
    expect(d.ok).toBe(true)
    // And a real link escape out of the buried workspace still hits the deny.
    const escape = guardPath({
      denyRoots,
      workspaceDir: buriedLex,
      workspaceReal: buriedReal,
      target: `${buriedLex}/link`,
      operation: 'write',
      realTarget: `${HOME}/.ssh/id_rsa`,
    })
    expect(escape.ok).toBe(false)
  })

  it('allow a target whose canonical location is the workspace', () => {
    // Spelled via a symlink outside — lands inside, must pass.
    const d = guardPath({ ...dualBase, target: '/elsewhere/ws-link/x.txt', operation: 'write', realTarget: `${realWs}/x.txt` })
    expect(d.ok).toBe(true)
  })
})

describe('buildDenyRoots', () => {
  it('adds the macOS keychain only on darwin', () => {
    expect(buildDenyRoots(HOME, 'darwin').some((r) => r.includes('Keychains'))).toBe(true)
    expect(buildDenyRoots(HOME, 'linux').some((r) => r.includes('Keychains'))).toBe(false)
  })
})

describe('guardPath — extra writable roots (~/.pulsemind/skills, 2026-09-27)', () => {
  // The agent's sanctioned edit surface for skill files: skill text is content
  // the model is SUPPOSED to revise (create_skill's premise), and `install`
  // already lets it create arbitrary skill text — denying edit on the same
  // files only broke the revision loop. Everything else under ~/.pulsemind
  // stays denied.
  const skills = `${HOME}/.pulsemind/skills`
  const skillsBase = { denyRoots, workspaceDir: WORKSPACE, extraWritableRoots: [{ dir: skills, real: null }] }

  it('allow writes to a SKILL.md inside the skills tree', () => {
    expect(guardPath({ ...skillsBase, target: `${skills}/office/SKILL.md`, operation: 'write' }).ok).toBe(true)
  })
  it('allow writes deep in companion resources', () => {
    expect(guardPath({ ...skillsBase, target: `${skills}/office/references/docx.md`, operation: 'write' }).ok).toBe(true)
  })
  it('allow svc reads inside the skills tree (the shell path could always)', () => {
    expect(guardPath({ ...skillsBase, target: `${skills}/office/SKILL.md`, operation: 'read' }).ok).toBe(true)
  })
  it('the seed manifest dotfile rides the same exemption (accepted residual)', () => {
    expect(guardPath({ ...skillsBase, target: `${skills}/.seed-hashes.json`, operation: 'write' }).ok).toBe(true)
  })
  it('still deny the rest of ~/.pulsemind — settings, db, memory, mcp, experiences', () => {
    for (const p of [
      `${HOME}/.pulsemind/settings.json`,
      `${HOME}/.pulsemind/db/pulsemind.db`,
      `${HOME}/.pulsemind/memory/MEMORY.md`,
      `${HOME}/.pulsemind/mcp/mcp-servers.json`,
      `${HOME}/.pulsemind/experiences/webmail-send/SKILL.md`,
    ]) {
      expect(guardPath({ ...skillsBase, target: p, operation: 'write' }).ok).toBe(false)
      expect(guardPath({ ...skillsBase, target: p, operation: 'read' }).ok).toBe(false)
    }
  })
  it('refuse a sibling that merely shares the prefix (skills-extra ≠ skills)', () => {
    expect(guardPath({ ...skillsBase, target: `${HOME}/.pulsemind/skills-extra/x.md`, operation: 'write' }).ok).toBe(false)
  })
  it('deny a symlink inside skills that lands in a secrets root (realpath governs)', () => {
    const d = guardPath({ ...skillsBase, target: `${skills}/office/link`, operation: 'write', realTarget: `${HOME}/.ssh/id_rsa` })
    expect(d.ok).toBe(false)
  })
  it('deny a symlink from skills into the still-protected memory dir', () => {
    const d = guardPath({ ...skillsBase, target: `${skills}/office/link`, operation: 'write', realTarget: `${HOME}/.pulsemind/memory/MEMORY.md` })
    expect(d.ok).toBe(false)
  })
  it('deny a symlink spelled inside skills whose realpath escapes ~/.pulsemind entirely', () => {
    const d = guardPath({ ...skillsBase, target: `${skills}/link.md`, operation: 'write', realTarget: '/Users/dev/Desktop/evil.txt' })
    expect(d.ok).toBe(false)
  })
  it('judge the canonical spelling against the root\'s realpath (symlinked ancestor)', () => {
    // The skills root itself reached through a symlinked ancestor: the lexical
    // target spelling exempts the deny check, the canonical spelling passes
    // the jail against the root's `real`.
    const d = guardPath({
      denyRoots,
      workspaceDir: WORKSPACE,
      extraWritableRoots: [{ dir: '/tmp/skills', real: '/private/tmp/skills' }],
      target: '/tmp/skills/office/SKILL.md',
      operation: 'write',
      realTarget: '/private/tmp/skills/office/SKILL.md',
    })
    expect(d.ok).toBe(true)
  })
})

describe('guardFsTarget — the glue passes the skills root (real fs, throwaway HOME)', () => {
  it('adjudicates the exemption end-to-end inside a session context', async () => {
    const { guardFsTarget } = await import('../src/main/sandbox/guard')
    const { sessionSandbox } = await import('../src/main/sandbox/session-context')
    const { homedir } = await import('node:os')
    const { mkdirSync, symlinkSync, rmSync, writeFileSync } = await import('node:fs')
    const home = homedir()
    const skills = `${home}/.pulsemind/skills`
    const workspace = `${home}/.pulsemind/workspace/glue-probe`
    mkdirSync(`${skills}/office`, { recursive: true })
    mkdirSync(workspace, { recursive: true })
    writeFileSync(`${skills}/office/SKILL.md`, 'seed text', 'utf-8')

    const inside = sessionSandbox.run({ sessionId: 'conv_glue', workspaceDir: workspace }, async () => {
      // the file tools' actual seam: write + edit into skills now pass
      const w = await guardFsTarget(`${skills}/online-spreadsheet/SKILL.md`, 'write')
      expect(w.ok).toBe(true)
      const r = await guardFsTarget(`${skills}/office/SKILL.md`, 'read')
      expect(r.ok).toBe(true)
      // the rest of the data root is untouched
      const settings = await guardFsTarget(`${home}/.pulsemind/settings.json`, 'write')
      expect(settings.ok).toBe(false)
      expect(settings.ok ? '' : settings.reason).toMatch(/Path is protected/)
      const mcp = await guardFsTarget(`${home}/.pulsemind/mcp/mcp-servers.json`, 'write')
      expect(mcp.ok).toBe(false)
      // a symlink inside skills escaping the tree still fails closed
      const link = `${skills}/office/escape-link`
      try { rmSync(link) } catch { /* absent */ }
      symlinkSync(`${home}/.ssh`, link)
      const escape = await guardFsTarget(`${link}/id_rsa`, 'write')
      expect(escape.ok).toBe(false)
      // workspace behavior unchanged
      const ws = await guardFsTarget(`${workspace}/notes.md`, 'write')
      expect(ws.ok).toBe(true)
    })
    await inside
    try { rmSync(`${skills}/office/escape-link`) } catch { /* already gone */ }
  })
})
