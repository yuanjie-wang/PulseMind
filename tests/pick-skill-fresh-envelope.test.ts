import { describe, it, expect, afterEach } from 'vitest'
import { ToolExecutor } from '../src/renderer/src/agent/tool-executors'
import { setHost } from '../src/renderer/src/agent/host'
import type { PulseHost } from '../src/renderer/src/agent/host/types'
import type { AgentEngineOptions } from '../src/renderer/src/agent/types'
import type { ToolUseBlock } from '../src/shared/types/agent'
import type { SkillDefinition } from '../src/shared/types/skill-types'

/**
 * pick_skill 的信封正文读盘优先（freshSkillDefinition）。
 *
 * The contract this file pins: the envelope's **Location:** line points at
 * `~/.pulsemind/skills/<name>/SKILL.md`, so the body above it must be that
 * file's text — not the launch-time registry copy, which never refreshes and
 * diverges the moment the file is hand-edited mid-session or seed-upgraded by
 * `ensureBuiltInSkills` after an app update. `installSkill` (the same host
 * call `install` uses) re-parses the file at call time; null (deleted
 * mid-session) or a host failure falls back to the registry definition, which
 * is then the only description there is.
 */

const REGISTRY_DEF: SkillDefinition = {
  name: 'probe_fresh',
  description: 'registry description',
  category: 'probe',
  systemPrompt: 'REGISTRY BODY'
}
const DISK_DEF: SkillDefinition = {
  ...REGISTRY_DEF,
  description: 'disk description',
  systemPrompt: 'DISK BODY — what the Location line advertises'
}

const skillManagerStub = {
  getSkill: (name: string) =>
    name === 'probe_fresh' ? { definition: REGISTRY_DEF, enabled: true } : undefined,
  getEnabledSkills: () => [{ definition: REGISTRY_DEF, enabled: true }]
}

interface PickOutcome { content: string; isError?: boolean }

function runPick(
  input: Record<string, unknown>,
  installSkill: (name: string) => Promise<SkillDefinition | null>,
  selectionAgent?: { execute: (input: unknown, opts: unknown) => Promise<string> }
) {
  const seen: PickOutcome[] = []
  setHost({ installSkill } as unknown as PulseHost)
  const t = { id: 't1', name: 'pick_skill', input } as unknown as ToolUseBlock
  const ex = new ToolExecutor(
    { conversationId: 'conv_1', skillsDir: '/data/skills', skillManager: skillManagerStub } as unknown as AgentEngineOptions,
    new Map(),
    null as never,
    (selectionAgent ?? null) as never,
    (_id: string, content: string, isError?: boolean) => seen.push({ content, isError }),
    () => {}
  )
  return ex.execPickSkill(t).then(() => seen[0])
}

afterEach(() => setHost(null as unknown as PulseHost))

describe('execPickSkill — the envelope serves the disk text its Location line names', () => {
  it('named lookup: a mid-session file edit wins the envelope body', async () => {
    const out = await runPick({ name: 'probe_fresh' }, async () => DISK_DEF)
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('DISK BODY — what the Location line advertises')
    expect(out?.content).toContain('disk description')
    expect(out?.content).not.toContain('REGISTRY BODY')
    expect(out?.content).toContain('**Location:** /data/skills/probe_fresh/SKILL.md')
  })

  it('named lookup: file gone (null) falls back to the registry copy', async () => {
    const out = await runPick({ name: 'probe_fresh' }, async () => null)
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('REGISTRY BODY')
  })

  it('named lookup: a host failure never fails the pick', async () => {
    const out = await runPick({ name: 'probe_fresh' }, async () => { throw new Error('ipc gone') })
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('REGISTRY BODY')
  })

  it('intent path: the selection agent pick is served disk-fresh too', async () => {
    const out = await runPick(
      { intent: 'do the probe thing' },
      async (name) => (name === 'probe_fresh' ? DISK_DEF : null),
      { execute: async () => 'probe_fresh' }
    )
    expect(out?.isError).toBeFalsy()
    expect(out?.content).toContain('DISK BODY — what the Location line advertises')
    expect(out?.content).not.toContain('REGISTRY BODY')
  })
})
