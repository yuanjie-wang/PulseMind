// ── Internal expert packs for the three assistants (PLAN-form-assist-proposals T5) ──
// 任务创建助手 / 专家创建助手 / 工具创建助手 are ExpertProfile-shaped CODE
// CONSTANTS, not expertStore rows — 「隐藏」is constructive: the panel grid,
// the summon roster, the session-binding dropdown and expertReset can only see
// DB rows, so a constant is invisible there by construction. This file pins
// the shape that keeps it that way:
//
//   · the packs' capability whitelists are EXPLICIT (「缺省 = 不限制」is
//     forbidden for internal packs — an accidental undefined would hand a
//     form filler the global toolset, which is exactly the bug D15 closes);
//   · the identity composition is byte-stable and catalog-proof (the prompt
//     prefix cache dies with any volatile byte — an internal pack whose
//     instructions changed when an MCP server connected would silently
//     re-bill every assistant conversation);
//   · the main-side pinning path exists (wire field, session-manager pin +
//     refresh exemption, prompt assembly, renderer passthrough) — all source
//     scans, because vitest here is node-env and cannot mount the hooks.
//
// Non-vacuity: the scan helper asserts every anchor, and the final test
// counts the anchors so a broken scan cannot pass by finding nothing.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const REPO = process.cwd()

import { ROUTINE_ASSIST_SPEC, ROUTINE_ASSIST_ALLOWED_TOOLS, ROUTINE_ASSISTANT_PROFILE } from '../src/renderer/src/components/routine/routine-assist'
import { EXPERT_ASSIST_SPEC, EXPERT_ASSIST_ALLOWED_TOOLS, EXPERT_ASSISTANT_PROFILE } from '../src/renderer/src/components/settings/expert/expert-assist'
import { TOOL_STUDIO_ALLOWED_TOOLS, TOOL_STUDIO_PROFILE, TOOL_SYSTEM_PROMPT } from '../src/renderer/src/tool-studio/tool-prompt'
import { composeExpertInstructions, type ExpertRefCatalogs } from '../src/shared/expert-context'
import { BUILT_IN_TOOLS } from '../src/renderer/src/tools/built-in-tools'

const PACKS = [
  { name: '任务创建助手', profile: ROUTINE_ASSISTANT_PROFILE, tools: ROUTINE_ASSIST_ALLOWED_TOOLS },
  { name: '专家创建助手', profile: EXPERT_ASSISTANT_PROFILE, tools: EXPERT_ASSIST_ALLOWED_TOOLS },
  { name: '工具创建助手', profile: TOOL_STUDIO_PROFILE, tools: TOOL_STUDIO_ALLOWED_TOOLS },
] as const

const BUILTIN_NAMES = new Set(BUILT_IN_TOOLS.map((t) => t.name))

/** Read a repo file relative to root; every anchor scan below goes through
 *  here so a typo'd path fails loudly instead of scanning nothing. */
function src(...parts: string[]): string {
  return readFileSync(join(REPO, ...parts), 'utf-8')
}

function expectAnchor(haystack: string, needle: string, what: string): void {
  expect(haystack.includes(needle), `missing anchor (${what}): ${needle}`).toBe(true)
}

describe('internal expert packs — shape (D15)', () => {
  it('are code constants with internal- ids, invisible to expertStore by construction', () => {
    for (const { profile, name } of PACKS) {
      expect(profile.id, name).toMatch(/^internal-/)
      expect(profile.enabled, `${name}: 内部包不参与启用开关`).toBeUndefined()
    }
  })

  it('declare their capability whitelists EXPLICITLY — no accidental unrestricted', () => {
    for (const { profile, name } of PACKS) {
      // The key must EXIST even when the value is a deliberate undefined —
      // a missing key is the 「缺省 = 不限制」 shape D15 forbids.
      expect('skillNames' in profile, `${name}: skillNames 必须显式声明`).toBe(true)
      expect('mcpServerIds' in profile, `${name}: mcpServerIds 必须显式声明`).toBe(true)
      if (profile.mcpServerIds !== undefined) expect(profile.mcpServerIds, name).toEqual([])
    }
    // 任务/专家助手不需要任何技能（空数组 = 明确的一个都不许用）。
    expect(ROUTINE_ASSISTANT_PROFILE.skillNames).toEqual([])
    expect(EXPERT_ASSISTANT_PROFILE.skillNames).toEqual([])
    // 工具创建助手保留查技能能力（pick_skill 在白名单里），显式不限制 —
    // undefined 让 composeExpertInstructions 不产出「无技能」的撒谎段落。
    expect(TOOL_STUDIO_PROFILE.skillNames).toBeUndefined()
  })

  it('carry the identity four sections in zh (v1 locale ruling)', () => {
    for (const { profile, name } of PACKS) {
      for (const section of ['basePrompt', 'methodology', 'outputSpec', 'constraints'] as const) {
        expect(typeof profile[section], `${name}.${section}`).toBe('string')
        expect((profile[section] as string).length, `${name}.${section}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('assistant tool whitelists (D13/D17, user ruling 2026-09-19)', () => {
  it('name only real built-in tools, and every list carries ask_user', () => {
    for (const { tools, name } of PACKS) {
      expect(tools.length, name).toBeGreaterThan(0)
      for (const tool of tools) {
        expect(BUILTIN_NAMES.has(tool), `${name}: ${tool} 不是内建工具`).toBe(true)
      }
      expect(tools, `${name}: ask_user 未进白名单`).toContain('ask_user')
    }
  })

  it('任务/专家助手 = ask_user only; 工具助手 keeps its file tools + pick_skill', () => {
    expect(ROUTINE_ASSIST_ALLOWED_TOOLS).toEqual(['ask_user'])
    expect(EXPERT_ASSIST_ALLOWED_TOOLS).toEqual(['ask_user'])
    expect(TOOL_STUDIO_ALLOWED_TOOLS).toContain('pick_skill')
    for (const forbidden of ['exec', 'spawn_agent', 'create_plan', 'pick_tool', 'webfetch']) {
      for (const { tools, name } of PACKS) {
        expect(tools, `${name}: ${forbidden} 不应出现在助手白名单`).not.toContain(forbidden)
      }
    }
  })

  it('the ask_user contract line is in both form-assist specs and the studio prompt', () => {
    expect(ROUTINE_ASSIST_SPEC.rules.join('\n')).toContain('ask_user')
    expect(ROUTINE_ASSIST_SPEC.rulesEn?.join('\n')).toContain('ask_user')
    expect(EXPERT_ASSIST_SPEC.rules.join('\n')).toContain('ask_user')
    expect(EXPERT_ASSIST_SPEC.rulesEn?.join('\n')).toContain('ask_user')
    expect(TOOL_SYSTEM_PROMPT).toContain('ask_user')
  })
})

describe('identity composition is byte-stable and catalog-proof (D16)', () => {
  const CATALOGS_A: ExpertRefCatalogs = {
    skills: [{ id: 'skill-a', name: 'skill-a', summary: 'A' }],
    connectors: [{ id: 'conn-a', name: 'Connector A', summary: 'does A' }],
  }
  const CATALOGS_B: ExpertRefCatalogs = {
    skills: [{ id: 'skill-b', name: 'skill-b' }],
    connectors: [{ id: 'conn-b', name: 'Connector B' }],
  }

  it('composes deterministically — same pack, same bytes, catalogs never leak', () => {
    for (const { profile, name } of PACKS) {
      const once = composeExpertInstructions(profile, CATALOGS_A)
      expect(composeExpertInstructions(profile, CATALOGS_A), name).toBe(once)
      // Empty whitelists must not enumerate catalogs: a prompt that changes
      // when an MCP server connects would bust the assistant's cache prefix.
      expect(composeExpertInstructions(profile, CATALOGS_B), `${name}: 目录变化泄漏进了提示词`).toBe(once)
    }
  })

  it('empty whitelists SAY so; the deliberate undefined says nothing', () => {
    const routine = composeExpertInstructions(ROUTINE_ASSISTANT_PROFILE)
    expect(routine).toContain('# Expert Mode: 任务创建助手')
    expect(routine).toContain('No skills are available')
    expect(routine).toContain('No connectors')
    const studio = composeExpertInstructions(TOOL_STUDIO_PROFILE)
    expect(studio).toContain('# Expert Mode: 工具创建助手')
    expect(studio).not.toContain('## Allowed Skills')
  })
})

describe('the main-side pinning path exists (D16 — source scans)', () => {
  const payloads = src('src', 'shared', 'agent-protocol', 'payloads.ts')
  const sessionManager = src('src', 'main', 'agent', 'session-manager.ts')
  const builder = src('src', 'renderer', 'src', 'agent', 'system-prompt-builder.ts')
  const engine = src('src', 'renderer', 'src', 'agent', 'AgentEngine.ts')
  const hostedHook = src('src', 'renderer', 'src', 'hooks', 'useHostedAgentSession.ts')
  const assistHook = src('src', 'renderer', 'src', 'components', 'form-assist', 'useFormAssistSession.ts')
  const routinePage = src('src', 'renderer', 'src', 'components', 'routine', 'TaskWizardPage.tsx')
  const expertEditor = src('src', 'renderer', 'src', 'components', 'settings', 'expert', 'ExpertEditor.tsx')
  const studioSession = src('src', 'renderer', 'src', 'tool-studio', 'useStudioSession.ts')

  it('wire: AgentSessionCreateOptions carries expertProfile', () => {
    expectAnchor(payloads, 'expertProfile?: ExpertProfile', 'wire type')
  })

  it('session-manager: compose once, pin, exempt from DB-bound experts, survive refresh', () => {
    expectAnchor(sessionManager, 'composeExpertInstructions(opts.expertProfile', 'create-time composition')
    expectAnchor(sessionManager, 'expertProfile: opts.expertProfile', 'pin recorded')
    // The whitelists pass through VERBATIM — all three states survive the
    // pin. `?? []` collapsed the studio's deliberate undefined into 「全部
    // 禁止」 (review0920-H2: pick_skill failed on every named skill), so the
    // passthrough shape is anchored AND the collapsing spelling is banned.
    expectAnchor(sessionManager, 'allowedSkills: opts.expertProfile.skillNames,', 'undefined stays undefined（透传，不 ?? 压扁）')
    expectAnchor(sessionManager, 'allowedMcpServers: opts.expertProfile.mcpServerIds,', 'undefined stays undefined（透传，不 ?? 压扁）')
    expect(sessionManager.includes('skillNames ?? []') || sessionManager.includes('mcpServerIds ?? []'),
      'pinned-pack whitelists must not collapse states with ?? (review0920-H2)').toBe(false)
    expectAnchor(sessionManager, 'if (entry.pinned.expertProfile)', 'refresh exemption BEFORE the DB lookup')
    expectAnchor(sessionManager, 'allowedSkills: entry.expertState?.allowedSkills', 'refresh re-attaches mirror fields')
    expectAnchor(sessionManager, 'allowedMcpServers: entry.expertState?.allowedMcpServers', 'refresh re-attaches mirror fields')
  })

  it('system-prompt-builder: the override branch assembles the pack on top', () => {
    expectAnchor(builder, 'opts.expert?.instructions', 'override + expert assembly')
  })

  it('engine: updateOptions re-derives the MCP set when the bag carries it', () => {
    expectAnchor(engine, 'opts.allowedMcpServers !== undefined', 'updateOptions set rebuild')
  })

  it('renderer: all three assistants pass pack + whitelist through to create', () => {
    expectAnchor(hostedHook, 'expertProfile?: ExpertProfile', 'HostedSessionCreateOptions')
    expectAnchor(hostedHook, 'allowedTools?: string[]', 'HostedSessionCreateOptions')
    expectAnchor(assistHook, 'allowedTools, expertProfile', 'useFormAssistSession passthrough')
    expectAnchor(routinePage, 'expertProfile: ROUTINE_ASSISTANT_PROFILE', 'routine host')
    expectAnchor(routinePage, 'allowedTools: ROUTINE_ASSIST_ALLOWED_TOOLS', 'routine host')
    expectAnchor(expertEditor, 'expertProfile: EXPERT_ASSISTANT_PROFILE', 'expert host')
    expectAnchor(expertEditor, 'allowedTools: EXPERT_ASSIST_ALLOWED_TOOLS', 'expert host')
    expectAnchor(studioSession, 'expertProfile: TOOL_STUDIO_PROFILE', 'tool studio host')
  })

  it('scans enough to be meaningful (a broken anchor must not pass)', () => {
    const anchors = [
      payloads, sessionManager, builder, engine, hostedHook, assistHook, routinePage, expertEditor, studioSession,
    ]
    expect(anchors.every((s) => s.length > 1000)).toBe(true)
    // The one anchor that would vanish first if the exemption is reverted.
    expect(sessionManager.match(/entry\.pinned\.expertProfile/g)?.length).toBeGreaterThanOrEqual(1)
  })
})

/** Walk the renderer tree for the engineCall whitelist test's own use. */
export function rendererSourceFiles(): string[] {
  const root = join(REPO, 'src', 'renderer', 'src')
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry) && !entry.includes('.test.')) out.push(full)
    }
  }
  walk(root)
  return out
}
