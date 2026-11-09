// 输入框指令自动匹配（2026-11-08）：`/` 指令（init/compact）· `@` 专家 · `$` 技能。
// Pure pieces (command registry, $-mention parser, Forced Skills section) are
// tested directly; the per-turn forcedSkills lifecycle and the composer popup
// are source-scanned — vitest here is node-env, neither the engine nor the
// composer can be mounted.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHAT_COMMANDS, buildInitPrompt, commandArgument, matchChatCommand } from '../src/renderer/src/agent/chat-commands'
import { formatForcedSkillsForPrompt, parseSkillMentions } from '../src/shared/expert-context'

const ROOT = join(__dirname, '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8')

describe('matchChatCommand', () => {
  it('matches a bare command and one followed by an argument', () => {
    expect(matchChatCommand('/init')?.name).toBe('init')
    expect(matchChatCommand('/init 重点关注测试流程')?.name).toBe('init')
    expect(matchChatCommand('/compact')?.name).toBe('compact')
    expect(matchChatCommand('  /compact 保留需求讨论  ')?.name).toBe('compact')
  })

  it('rejects prefixes, mid-text tokens and unknown commands', () => {
    expect(matchChatCommand('/inits')).toBeNull()
    expect(matchChatCommand('/compaction')).toBeNull()
    expect(matchChatCommand('/newer')).toBeNull()
    expect(matchChatCommand('请执行 /init')).toBeNull()
    expect(matchChatCommand('/help')).toBeNull()
    expect(matchChatCommand('')).toBeNull()
  })

  it('the registry holds init, compact and new, each with an i18n description key', () => {
    expect(CHAT_COMMANDS.map((c) => c.name)).toEqual(['init', 'compact', 'new'])
    for (const c of CHAT_COMMANDS) {
      expect(c.descKey).toMatch(/^chatView\.command\./)
      expect(read('src/renderer/src/i18n/locales/zh.ts')).toContain(c.descKey.split('.').pop()!)
      expect(read('src/renderer/src/i18n/locales/en.ts')).toContain(c.descKey.split('.').pop()!)
    }
  })

  it('commandArgument returns the trimmed rest', () => {
    expect(commandArgument('/init  重点测试 ', 'init')).toBe('重点测试')
    expect(commandArgument('/init', 'init')).toBe('')
    expect(matchChatCommand('/new 帮我写周报')?.name).toBe('new')
    expect(commandArgument('/new 帮我写周报', 'new')).toBe('帮我写周报')
  })
})

describe('/new send-path wiring (source scan)', () => {
  const ctrl = read('src/renderer/src/hooks/useChatController.ts')
  const block = ctrl.slice(ctrl.indexOf("newCommand?.name === 'new'"), ctrl.indexOf("initCommand?.name === 'init'"))

  it('sits after /compact and before the /init rewrite and the mention parses', () => {
    expect(block.length).toBeGreaterThan(0)
    expect(ctrl.indexOf("trimmedContent === '/compact'")).toBeLessThan(ctrl.indexOf("newCommand?.name === 'new'"))
    expect(ctrl.indexOf("newCommand?.name === 'new'")).toBeLessThan(ctrl.indexOf('parseExpertMentions(content'))
  })

  it('picks the same kind: browser task → browser form, project → that project preselected, else chat', () => {
    expect(block).toContain("conversationPrimaryOf(current) === 'browser'")
    expect(block).toContain("task.setMode('browser')")
    expect(block).toContain("task.setMode('project')")
    expect(block).toContain('task.setProjectId(currentProjectId)')
    expect(block).toContain("task.setMode('chat')")
    expect(block).toContain('await persistence.createNewConversation()')
  })

  it('refuses in secondary windows and at the session cap; a bare /new is consumed, trailing text becomes the first message', () => {
    expect(block).toContain('options.savesEnabled === false')
    expect(block).toContain('persistence.conversations.length >= MAX_SESSIONS')
    expect(block).toContain('if (!firstMessage) return true')
    expect(block).toContain("convId = ''")
    expect(block).toContain('content = firstMessage')
  })
})

describe('buildInitPrompt', () => {
  it('teaches the .pulsemind/AGENTS.md write contract', () => {
    const p = buildInitPrompt()
    expect(p).toContain('.pulsemind/AGENTS.md')
    expect(p).toContain('read-only')
    expect(p).toMatch(/never delete or reword/)
    expect(p).not.toContain('Additional focus')
  })

  it('surveys the four README-absent dimensions, grounded in real files and depth-budgeted (2026-11-09)', () => {
    const p = buildInitPrompt()
    expect(p).toContain('Code layering')
    expect(p).toContain('Comment conventions')
    expect(p).toContain('Testing habits')
    expect(p).toContain('External dependencies')
    // 防编造 + 防硬凑 + 防膨胀——三道闸都写进 prompt 本身。
    expect(p).toContain('read real files, not just directory names')
    expect(p).toContain('Omit any topic the workspace does not have')
    expect(p).toContain('Keep it tight')
    expect(p).toContain('this file rides every request')
  })

  it('appends the user focus only when given', () => {
    expect(buildInitPrompt('  测试命令  ')).toContain('Additional focus from the user: 测试命令')
    expect(buildInitPrompt('   ')).not.toContain('Additional focus')
  })

  it('carries no $ or @ token — the canned text must not trip the mention parsers', () => {
    expect(buildInitPrompt('x')).not.toMatch(/[$@]/)
  })
})

describe('parseSkillMentions', () => {
  const SKILLS = ['office', 'office-pro', 'coding-workflow', 'browser']

  it('resolves $ tokens, keeps them in the text and cuts them from task', () => {
    const r = parseSkillMentions('用 $office 帮我整理这份报告', SKILLS)
    expect(r.skills).toEqual(['office'])
    expect(r.text).toBe('用 $office 帮我整理这份报告')
    expect(r.task).toBe('用 帮我整理这份报告')
    expect(r.spans).toEqual([{ start: 2, end: 9 }])
  })

  it('longest name wins, several skills are collected in mention order, duplicates dropped', () => {
    const r = parseSkillMentions('$office-pro 和 $browser 再 $office-pro 一下', SKILLS)
    expect(r.skills).toEqual(['office-pro', 'browser'])
  })

  it('leaves non-skill dollars alone ($100, shell vars)', () => {
    const r = parseSkillMentions('预算 $100，echo $HOME', SKILLS)
    expect(r.skills).toEqual([])
    expect(r.task).toBe('预算 $100，echo $HOME')
    expect(r.spans).toEqual([])
  })

  it('skips claimed spans (expert parse wins)', () => {
    const text = '@专家$office 看看'
    // Pretend the expert parse claimed the whole `@专家$office` token.
    const r = parseSkillMentions(text, SKILLS, [{ start: 0, end: 10 }])
    expect(r.skills).toEqual([])
  })

  it('a bare pin has an empty task (the send path refuses it)', () => {
    expect(parseSkillMentions('$office', SKILLS).task).toBe('')
  })
})

describe('formatForcedSkillsForPrompt', () => {
  it('null for no pins', () => {
    expect(formatForcedSkillsForPrompt(null)).toBeNull()
    expect(formatForcedSkillsForPrompt([])).toBeNull()
    expect(formatForcedSkillsForPrompt(['  '])).toBeNull()
  })

  it('names every pinned skill and orders pick_skill + application', () => {
    const s = formatForcedSkillsForPrompt(['office', 'browser'])!
    expect(s).toContain('## Forced Skills')
    expect(s).toContain('`office`, `browser`')
    expect(s).toContain('pick_skill')
    expect(s).toMatch(/apply/)
  })
})

describe('forcedSkills per-turn wiring (source scan)', () => {
  it('the ask chain carries forcedSkills through all five stations', () => {
    expect(read('src/shared/types/electron-bridge.ts')).toMatch(/agentSessionAsk: \([^)]*forcedSkills\?: string\[\] \| null\)/)
    expect(read('src/preload/index.ts')).toContain('AGENT_SESSION_ASK, sessionId, content, summon, knowledgeBase, forcedSkills')
    expect(read('src/main/ipc/agent-session.handler.ts')).toContain(
      'agentSessionManager.ask(sessionId, content, undefined, summon, knowledgeBase, forcedSkills)',
    )
    expect(read('src/main/agent/session-manager.ts')).toContain('entry.engine.setForcedSkills(forcedSkills ?? null)')
    expect(read('src/renderer/src/hooks/useConversationEngine.ts')).toContain('agentSessionAsk(convId, content, summon, knowledgeBase, forcedSkills)')
  })

  it('prepareTurn consumes the staged pins for exactly one turn and the state block renders them', () => {
    const engine = read('src/renderer/src/agent/AgentEngine.ts')
    expect(engine).toContain('this.opts.forcedSkills = this.stagedForcedSkills')
    expect(engine).toContain('this.stagedForcedSkills = null')
    expect(engine).toContain('forcedSkills: this.opts.forcedSkills ?? null')
    expect(read('src/renderer/src/agent/system-prompt-builder.ts')).toContain('formatForcedSkillsForPrompt(forcedSkills ?? null)')
  })

  it('the send path rewrites /init, parses $ after experts, chains claimed spans and passes the pins', () => {
    const ctrl = read('src/renderer/src/hooks/useChatController.ts')
    expect(ctrl).toContain("initCommand?.name === 'init'")
    expect(ctrl).toContain("buildInitPrompt(commandArgument(content, 'init'))")
    expect(ctrl.indexOf('parseExpertMentions(content')).toBeLessThan(ctrl.indexOf('parseSkillMentions(content'))
    expect(ctrl.indexOf('parseSkillMentions(content')).toBeLessThan(ctrl.indexOf('parseKnowledgeBaseMention(content'))
    expect(ctrl).toContain('[...mentions.spans, ...skillMentions.spans]')
    expect(ctrl).toContain("t('chatView.skill.needTask')")
    expect(ctrl).toContain('startLoop(content, knowledgeBase, forcedSkills)')
    expect(ctrl).toContain('startSummonedLoop(content, mentioned, knowledgeBase, forcedSkills)')
    // /compact stays intercepted BEFORE the /init rewrite — it is never a turn.
    expect(ctrl.indexOf("trimmedContent === '/compact'")).toBeLessThan(ctrl.indexOf("initCommand?.name === 'init'"))
  })
})

describe('composer trigger popup (source scan)', () => {
  const inputArea = read('src/renderer/src/components/chat/InputArea.tsx')

  it('arms on /, @ and $ with the rightmost trigger winning', () => {
    expect(inputArea).toContain("inputValue.startsWith('/')")
    expect(inputArea).toContain("wordStartIdx('@')")
    expect(inputArea).toContain("wordStartIdx('$')")
    expect(inputArea).toContain('Math.max(slashIdx, atIdx, dollarIdx)')
  })

  it('reads commands from the shared registry and skills from disk minus the disabled list', () => {
    expect(inputArea).toContain("import { CHAT_COMMANDS } from '../../agent/chat-commands'")
    expect(inputArea).toContain('listImportedSkills()')
    expect(inputArea).toContain('prefs?.disabledSkills')
  })

  it('skills and commands are full-chat features (reuse sites pass a features object without them)', () => {
    expect(inputArea).toContain('const showSkills = features?.skills ?? features === undefined')
    expect(inputArea).toContain('const showCommands = features?.commands ?? features === undefined')
  })

  it('a fully typed command lets Enter submit instead of re-inserting itself', () => {
    expect(inputArea).toContain("triggerKind === 'command' && inputValue.trim() === picked.title")
  })

  it('one sectioned list: empty query shows every section, a typed query keeps only the triggered one', () => {
    expect(inputArea).toContain("const TRIGGER_SECTION_ORDER: TriggerKind[] = ['command', 'expert', 'skill']")
    expect(inputArea).toContain('const kinds: TriggerKind[] = q ? [triggerKind] : TRIGGER_SECTION_ORDER')
    expect(inputArea).toContain('data-trigger-section={section.kind}')
  })

  it('a typed query matches by exact name PREFIX only — no description/substring match', () => {
    expect(inputArea).toContain('name.toLowerCase().startsWith(q)')
    expect(inputArea).not.toMatch(/description[^\n]*\.includes\(q\)/)
    expect(inputArea).not.toMatch(/name\.toLowerCase\(\)\.includes\(q\)/)
  })

  it('the list opens on the triggered section: highlight its first row, scroll its header to the top', () => {
    expect(inputArea).toContain('setMentionNavIdx(triggerFocusIdx)')
    expect(inputArea).toContain('[data-trigger-section="${triggerKind}"]')
    // The header-scroll effect must run AFTER the row-reveal effect in the same
    // commit, or the reveal would leave the section header scrolled off.
    expect(inputArea.indexOf('popup.scrollTop = header ? header.offsetTop : 0')).toBeGreaterThan(inputArea.indexOf('[data-mention-idx="${mentionNavIdx}"]'))
  })

  it('commands are offered only when nothing precedes the trigger (they execute only at message start)', () => {
    expect(inputArea).toContain("const atStart = inputValue.slice(0, triggerIdx).trim() === ''")
    expect(inputArea).toContain('if (!showCommands || !atStart) return []')
  })
})
