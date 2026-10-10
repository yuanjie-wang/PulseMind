// install — the conversation-side door into the app's own stores.
//
// ~/.pulsemind is a path-jail DENY ROOT: the agent's write/edit tools answer
// "Path is protected" there, which is why the old create_skill/create_mcp
// guides dead-ended — they told the model to prepare SKILL.md or
// mcp-servers.json with the write tool first, and the guard refused every
// step (the exact conv_20260925230016 shape that produced experience_save).
// The cure is the same shape: the payloads ride the tool call — `content`
// lands through SkillStore.writeRawSkill (guard-free, verbatim,
// never-overwrite) and `config` through mcpRegisterServer. This file pins the
// doors themselves: real store against real disk (the skills dir sits under
// the throwaway HOME setup.ts installs), the extracted execInstallTool
// against a fake host, and the wiring asserted as source the way
// office-tool-dispatch does it.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { execInstallTool, installTypeOf } from '../src/renderer/src/agent/executors/install-tool'
import { setHost } from '../src/renderer/src/agent/host'
import { HOST_METHOD_KEYS } from '../src/renderer/src/agent/host/types'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { ToolExecContext } from '../src/renderer/src/agent/executors/context'
import type { ToolUseBlock } from '../src/shared/types/agent'
import { BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'
import { toolInstructions } from '../src/renderer/src/tools/tool-instructions'
import { BUILT_IN_SKILLS } from '../src/renderer/src/skills/built-in-skills'
import { TOOL_PARAM_LIMITS } from '../src/renderer/src/agent/engine/engine-constants'
import { skillStore } from '../src/main/storage/skill-store'
import { SKILLS_DIR } from '../src/main/storage/index'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const skillMd = (name: string, body = 'Body text.') =>
  `---\nname: ${name}\ndescription: Install tool probe.\ncategory: probe\n---\n## Active Skill: Probe\n\n${body}\n`

// ── Part A: the store door (real store, real disk) ──────────────────────

describe('SkillStore.writeRawSkill — the sanctioned door into the deny-rooted skills dir', () => {
  it('writes the SKILL.md verbatim (bytes in, bytes on disk) and returns the definition', async () => {
    const content = skillMd('probe_install_verbatim').replace(/\n/g, '\r\n')
    const res = await skillStore.writeRawSkill(content)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.skill.name).toBe('probe_install_verbatim')
    expect(res.skill.category).toBe('probe')
    const mdPath = join(SKILLS_DIR, 'probe_install_verbatim', 'SKILL.md')
    expect(existsSync(mdPath)).toBe(true)
    expect(readFileSync(mdPath, 'utf-8')).toBe(content)
  })

  it('derives the skill name from the frontmatter when the caller omits it', async () => {
    const res = await skillStore.writeRawSkill(skillMd('probe_install_derived'))
    expect(res.ok).toBe(true)
    expect(existsSync(join(SKILLS_DIR, 'probe_install_derived', 'SKILL.md'))).toBe(true)
  })

  it('rejects unparseable content with the parser\'s message', async () => {
    const res = await skillStore.writeRawSkill('no frontmatter here at all')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('frontmatter')
  })

  it('rejects a name that disagrees with the expectedName hint', async () => {
    const res = await skillStore.writeRawSkill(skillMd('probe_install_a'), 'probe_install_b')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error).toContain('probe_install_a')
    expect(res.error).toContain('probe_install_b')
    expect(existsSync(join(SKILLS_DIR, 'probe_install_a'))).toBe(false)
  })

  it('refuses a frontmatter name that escapes the skills directory', async () => {
    const res = await skillStore.writeRawSkill(skillMd('../../probe_install_escape'))
    expect(res.ok).toBe(false)
    expect(existsSync(join(SKILLS_DIR, 'probe_install_escape'))).toBe(false)
  })

  it('never overwrites an existing skill — built-ins seed into the same dir, so this protects them too', async () => {
    const first = skillMd('probe_install_existing', 'First body — the one that landed.')
    const ok = await skillStore.writeRawSkill(first)
    expect(ok.ok).toBe(true)

    const second = await skillStore.writeRawSkill(skillMd('probe_install_existing', 'Second body — must not land.'))
    expect(second.ok).toBe(false)
    if (second.ok) expect.fail('expected refusal')
    expect(second.error).toContain('already exists')
    const mdPath = join(SKILLS_DIR, 'probe_install_existing', 'SKILL.md')
    expect(readFileSync(mdPath, 'utf-8')).toBe(first)
  })
})

// ── Part B: the executor (fake host; the skill side wired to the REAL store) ──

interface Call { method: string; args: unknown[] }

function harness(hostOverrides: Record<string, (...args: never[]) => unknown>) {
  const calls: Call[] = []
  const recorded = (method: string) => (...args: unknown[]) => { calls.push({ method, args }) }
  const results: Array<{ text: string; isError: boolean }> = []
  const registered: string[] = []
  const enabled: string[] = []
  let stateChanged = 0
  const ex = {
    opts: {
      skillManager: {
        registerSkill: (def: { name: string }) => { registered.push(def.name) },
        enable: (name: string) => { enabled.push(name) },
      },
      onSkillStateChange: () => { stateChanged++ },
      adapter: {},
      apiKey: 'sk-test',
      baseURL: 'https://api.example.com',
      model: 'test-model',
    },
    addToolResult: (_id: string, text: string, isError: boolean) => { results.push({ text, isError }) },
    notify: () => {},
    formatExecResult: () => '',
  } as unknown as ToolExecContext
  const host = {
    // defaults that must never be reached without the test wiring them
    readFile: recorded('readFile'),
    ...hostOverrides,
  } as unknown as PulseHost
  setHost(host)
  const block = (input: Record<string, unknown>): ToolUseBlock =>
    ({ type: 'tool_use', id: 'tu_1', name: 'install', input, status: 'pending' })
  return { ex, calls, results, registered, enabled, block, stateChanged: () => stateChanged }
}

const callsOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method)

describe('execInstallTool — skill mode through the content door', () => {
  it('writes through the real store, installs from disk, registers and enables', async () => {
    const writes: Array<{ content: string; expectedName?: string }> = []
    const { ex, results, registered, enabled, block, stateChanged } = harness({
      writeSkillSource: async (content: string, expectedName?: string) => {
        writes.push({ content, expectedName })
        return skillStore.writeRawSkill(content, expectedName)
      },
      installSkill: (name: string) => skillStore.install(name),
      readSkillRaw: (name: string) => skillStore.readRawContent(name),
    })
    const t = block({ type: 'skill', content: skillMd('probe_install_exec') })
    await execInstallTool(ex, t)

    expect(writes).toHaveLength(1)
    expect(results).toHaveLength(1)
    expect(results[0]!.isError).toBe(false)
    expect(results[0]!.text).toContain('installed and enabled')
    expect(t.exitCode).toBe(0)
    expect(registered).toEqual(['probe_install_exec'])
    expect(enabled).toEqual(['probe_install_exec'])
    expect(stateChanged()).toBe(1)
    // the envelope and the file must tell the same story: the registry got the
    // disk-fresh definition, so the body on disk is the body that was installed
    expect(readFileSync(join(SKILLS_DIR, 'probe_install_exec', 'SKILL.md'), 'utf-8')).toContain('Body text.')
  })

  it('omitting "name" takes the frontmatter name; a disagreeing name is refused with both names', async () => {
    const noName = harness({
      writeSkillSource: (c: string, e?: string) => skillStore.writeRawSkill(c, e),
      installSkill: (n: string) => skillStore.install(n),
    })
    const t1 = noName.block({ type: 'skill', content: skillMd('probe_install_noname') })
    await execInstallTool(noName.ex, t1)
    expect(t1.exitCode).toBe(0)
    expect(noName.registered).toEqual(['probe_install_noname'])

    const mismatch = harness({
      writeSkillSource: (c: string, e?: string) => skillStore.writeRawSkill(c, e),
      installSkill: () => { throw new Error('installSkill must not be reached after a refusal') },
    })
    const t2 = mismatch.block({ type: 'skill', name: 'other_name', content: skillMd('probe_install_real') })
    await execInstallTool(mismatch.ex, t2)
    expect(t2.exitCode).toBe(-1)
    expect(mismatch.results[0]!.isError).toBe(true)
    expect(mismatch.results[0]!.text).toContain('other_name')
    expect(mismatch.results[0]!.text).toContain('probe_install_real')
  })

  it('without content, the on-disk flow stays — and its failure now points at the content door', async () => {
    const { ex, results, block } = harness({
      installSkill: async () => null,
    })
    const t = block({ type: 'skill', name: 'probe_install_missing' })
    await execInstallTool(ex, t)
    expect(t.exitCode).toBe(-1)
    expect(results[0]!.isError).toBe(true)
    expect(results[0]!.text).toContain('"content"')
  })
})

describe('execInstallTool — mcp mode through the config door', () => {
  const mcpHarness = (overrides: Record<string, unknown> = {}) => {
    const registered: unknown[] = []
    const started: string[] = []
    const h = harness({
      mcpRegisterServer: async (config: unknown) => {
        registered.push(config)
        if (overrides.registerFails) return { success: false, error: overrides.registerFails as string }
        return { success: true, server: { id: 'srv_1', name: (config as { name: string }).name } }
      },
      mcpStartServer: async (id: string) => { started.push(id); return { success: true } },
      ...overrides.host,
    })
    return { ...h, registered, started }
  }

  it('registers straight from the config object and starts the returned id — readFile is never touched', async () => {
    const h = mcpHarness()
    const config = { name: 'probe-mcp', command: 'npx', args: ['-y', 'some-server'] }
    const t = h.block({ type: 'mcp', config })
    await execInstallTool(h.ex, t)

    expect(h.registered).toEqual([config])
    expect(h.started).toEqual(['srv_1'])
    expect(t.exitCode).toBe(0)
    expect(h.results[0]!.isError).toBe(false)
    expect(h.results[0]!.text).toContain('probe-mcp')
    expect(callsOf(h.calls, 'readFile')).toHaveLength(0)
  })

  it('a "name" that disagrees with config.name is refused before registration', async () => {
    const h = mcpHarness()
    const t = h.block({ type: 'mcp', name: 'other', config: { name: 'probe-mcp', command: 'npx' } })
    await execInstallTool(h.ex, t)
    expect(t.exitCode).toBe(-1)
    expect(h.results[0]!.text).toContain('other')
    expect(h.results[0]!.text).toContain('probe-mcp')
    expect(h.registered).toHaveLength(0)
  })

  it('a failed registration surfaces the manager\'s error text', async () => {
    const h = mcpHarness({ registerFails: 'spawnarmor: command not allowed' })
    const t = h.block({ type: 'mcp', config: { name: 'probe-mcp', command: 'npx' } })
    await execInstallTool(h.ex, t)
    expect(t.exitCode).toBe(-1)
    expect(h.results[0]!.isError).toBe(true)
    expect(h.results[0]!.text).toContain('command not allowed')
  })

  it('without config, the legacy file flow answers with the config door in its error', async () => {
    const h = mcpHarness({
      host: { readFile: async () => null },
    })
    const t = h.block({ type: 'mcp', name: 'probe-mcp' })
    await execInstallTool(h.ex, t)
    expect(t.exitCode).toBe(-1)
    expect(h.results[0]!.text).toContain('"config"')
    expect(callsOf(h.calls, 'mcpRegisterServer')).toHaveLength(0)
  })

  it('the legacy file flow still works when the file is actually reachable', async () => {
    const h = mcpHarness({
      host: { readFile: async () => JSON.stringify([{ config: { name: 'probe-mcp', command: 'node', args: ['x.js'] } }]) },
    })
    const t = h.block({ type: 'mcp', name: 'probe-mcp' })
    await execInstallTool(h.ex, t)
    expect(t.exitCode).toBe(0)
    expect(h.registered).toEqual([{ name: 'probe-mcp', command: 'node', args: ['x.js'] }])
    expect(h.started).toEqual(['srv_1'])
  })

  it('an unknown type is refused', async () => {
    const h = mcpHarness()
    const t = h.block({ type: 'extension' })
    await execInstallTool(h.ex, t)
    expect(t.exitCode).toBe(-1)
    expect(h.results[0]!.text).toContain('Must be "skill" or "mcp"')
  })
})

// ── Part C: the wiring (asserted as source / real imports, node-env) ────────

describe('install wiring — the door exists at every layer and never routes through the guard', () => {
  it('the host surface carries writeSkillSource on every layer', () => {
    expect(HOST_METHOD_KEYS).toContain('writeSkillSource')
    expect(read('src/shared/types/electron-bridge.ts')).toContain('writeSkillSource: (content: string, expectedName?: string)')
    expect(read('src/preload/index.ts')).toContain('IPC_CHANNELS.SKILLS_WRITE_SOURCE')
    const handler = read('src/main/ipc/skills.handler.ts')
    expect(handler).toContain('SKILLS_WRITE_SOURCE')
    expect(handler).toContain('skillStore.writeRawSkill')
    const mainHost = read('src/main/agent/main-host.ts')
    expect(mainHost).toContain('writeSkillSource')
    expect(mainHost).toContain('skillStore.writeRawSkill')
  })

  it('the main host implements it through the store — guardFsTarget never appears in it', () => {
    const mainHost = read('src/main/agent/main-host.ts')
    expect(mainHost).not.toContain('guardFsTarget')
    expect(mainHost).not.toContain("from '../sandbox/guard'")
  })

  it('the executor module itself is guard-free', () => {
    const src = read('src/renderer/src/agent/executors/install-tool.ts')
    // call/import forms only — the header comment may name the guard it routes around
    expect(src).not.toContain('guardFsTarget(')
    expect(src).not.toContain("from '../sandbox/guard'")
    expect(src).not.toContain('file-ops')
    expect(src).toContain('writeSkillSource')
    expect(src).toContain('mcpRegisterServer')
  })

  it('tool-executors delegates execInstall to the extracted module', () => {
    expect(read('src/renderer/src/agent/tool-executors.ts')).toContain('execInstallTool(this, t)')
  })

  it('the tool schema carries content + config and requires only "type"', () => {
    const install = BUILT_IN_TOOLS.find((t) => t.name === 'install')
    expect(install).toBeDefined()
    const props = install!.input_schema.properties as Record<string, { type: string }>
    expect(props.content?.type).toBe('string')
    expect(props.config?.type).toBe('object')
    expect(install!.input_schema.required).toEqual(['type'])
  })

  it('the oversized-param guard knows about install.content', () => {
    expect(TOOL_PARAM_LIMITS.install?.content).toBeGreaterThan(0)
  })

  it('the manual points revisions at direct edits and keeps mcp-servers.json protected', () => {
    const manual = toolInstructions.install
    expect(manual).toContain('`content`')
    expect(manual).toContain('`config`')
    expect(manual).toContain('WRITABLE')
    expect(manual).toContain('edit the file directly')
    expect(manual).toContain('sandbox-protected')
  })

  it('the guides teach the direct-edit revision flow (skills dir is writable)', () => {
    const createSkill = BUILT_IN_SKILLS.find((s) => s.name === 'create_skill')
    const createMcp = BUILT_IN_SKILLS.find((s) => s.name === 'create_mcp')
    expect(createSkill).toBeDefined()
    expect(createMcp).toBeDefined()
    // the revision loop goes through the file tools now — skills is writable
    expect(createSkill!.systemPrompt).toContain('writable')
    expect(createSkill!.systemPrompt).toContain('`edit`')
    // 2026-09-27 feedback: the flow mandates read-before-write + verification,
    // and spells out the activation semantics (body fresh per pick, registry
    // frontmatter/triggers rebuild next session, no re-enable)
    expect(createSkill!.systemPrompt).toContain('NEVER write over a skill file you have not read')
    expect(createSkill!.systemPrompt).toContain('re-reads SKILL.md from disk on every call')
    expect(createSkill!.systemPrompt).toContain('NO re-enable and NO re-registration')
    // ...and the seed-upgrade caveat for hand-edited built-ins is spelled out
    expect(createSkill!.systemPrompt).toContain('seed upgrades')
    // create_mcp's protected-file language stays truthful (mcp/ is NOT exempted)
    expect(createMcp!.systemPrompt).not.toContain('overwrite `~/.pulsemind/mcp/mcp-servers.json`')
    expect(createMcp!.systemPrompt).toContain('protected data root')
  })

  it('the guard glue passes the skills root as an extra writable root', () => {
    const guard = read('src/main/sandbox/guard.ts')
    expect(guard).toContain('extraWritableRoots')
    expect(guard).toContain("'skills'")
    // and the pure decision module carries the contract
    const jail = read('src/shared/sandbox/path-jail.ts')
    expect(jail).toContain('extraWritableRoots')
  })
})

// ── full_20261011 M2-P1-2: the exec-tier hold on install(type=mcp) classified
// with a strict `=== 'mcp'` while the executor trimmed the same field —
// `"mcp "` / `"MCP"` fell back into systemTools (never held) and still
// registered. One predicate now answers for both sides.

describe('install-mcp classification — one predicate for the ladder and the executor', () => {
  it('trim + casefold variants all classify as mcp', () => {
    for (const t of ['mcp', ' mcp', 'mcp ', '\nmcp', 'MCP', ' Mcp ']) {
      expect(installTypeOf({ input: { type: t } }), JSON.stringify(t)).toBe('mcp')
    }
    expect(installTypeOf({ input: { type: 'skill' } })).toBe('skill')
    expect(installTypeOf({ input: { type: ' Skill ' } })).toBe('skill')
    expect(installTypeOf({ input: {} })).toBe('')
    expect(installTypeOf({ input: { type: 42 } })).toBe('42')
  })

  it('the executor and both ladder sites go through the predicate (no second spelling)', () => {
    const src = read('src/renderer/src/agent/executors/install-tool.ts')
    expect(src).toContain('const installType = installTypeOf(t)')
    const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
    // The strict raw comparison must not come back at either ladder site:
    expect(flow).not.toContain("String(t.input?.type || '') === 'mcp'")
    expect(flow.match(/installTypeOf\(t\) === 'mcp'/g)).toHaveLength(2)
  })

  it('a case/spelling variant of mcp reaches the config door (was: unknown-type error)', async () => {
    const registered: unknown[] = []
    const started: string[] = []
    const h = harness({
      mcpRegisterServer: async (config: unknown) => {
        registered.push(config)
        return { success: true, server: { id: 'srv_1', name: (config as { name: string }).name } }
      },
      mcpStartServer: async (id: string) => { started.push(id); return { success: true } },
    })
    const t = h.block({ type: 'MCP', config: { name: 'probe-mcp', command: 'npx' } })
    await execInstallTool(h.ex, t)
    expect(registered).toHaveLength(1)
    expect(started).toEqual(['srv_1'])
  })
})
