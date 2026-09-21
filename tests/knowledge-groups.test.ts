// PLAN-knowledge-groups G5/G6: the @知识库 mention parser (pure), the scope's
// per-turn lifecycle wiring (source-scanned — vitest here is node-env, the
// engine cannot be mounted), and the scoped state-block count line.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseExpertMentions, parseKnowledgeBaseMention } from '../src/shared/expert-context'

const ROOT = join(__dirname, '..')

const BASES = [
  { id: 'kb_1', name: '项目Alpha' },
  { id: 'kb_2', name: '项目Alpha进阶' },
  { id: 'kb_3', name: '蝴蝶酥资料' },
]

describe('parseKnowledgeBaseMention (G5)', () => {
  it('extracts the base and cuts the token from the text', () => {
    const { base, text } = parseKnowledgeBaseMention('帮我查一下 @蝴蝶酥资料 里的做法', BASES)
    expect(base).toEqual({ id: 'kb_3', name: '蝴蝶酥资料' })
    expect(text).toBe('帮我查一下 里的做法')
  })

  it('longest name wins when two bases share a prefix', () => {
    const { base } = parseKnowledgeBaseMention('@项目Alpha进阶 有什么', BASES)
    expect(base?.id).toBe('kb_2')
  })

  it('no match returns null and the text untouched (an @name typed by hand stays visible)', () => {
    const { base, text } = parseKnowledgeBaseMention('看看 @不存在的库', BASES)
    expect(base).toBeNull()
    expect(text).toBe('看看 @不存在的库')
  })

  it('malformed base entries are skipped, never thrown', () => {
    const { base } = parseKnowledgeBaseMention('查 @蝴蝶酥资料', [{ id: '', name: 'x' }, { id: 'kb_3', name: '' }, ...BASES])
    expect(base?.id).toBe('kb_3')
  })

  it('a name that is both an expert and a base reads as the EXPERT (既有语义优先)', () => {
    const experts = [{ id: 'exp_1', name: '蝴蝶酥资料', enabled: true, description: '' }]
    const afterExpert = parseExpertMentions('查 @蝴蝶酥资料', experts as never[])
    const { base } = parseKnowledgeBaseMention(afterExpert.text, BASES)
    expect(afterExpert.experts).toHaveLength(1)
    expect(base).toBeNull()
  })
})

describe('scope lifecycle wiring (source-scanned; node-env cannot mount the engine)', () => {
  const engine = readFileSync(join(ROOT, 'src/renderer/src/agent/AgentEngine.ts'), 'utf-8')
  const controller = readFileSync(join(ROOT, 'src/renderer/src/hooks/useChatController.ts'), 'utf-8')
  const sessionManager = readFileSync(join(ROOT, 'src/main/agent/session-manager.ts'), 'utf-8')
  const handler = readFileSync(join(ROOT, 'src/main/ipc/agent-session.handler.ts'), 'utf-8')
  const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf-8')
  const domainTools = readFileSync(join(ROOT, 'src/renderer/src/agent/executors/domain-tools.ts'), 'utf-8')

  it('non-vacuity: the scans below read real files', () => {
    expect(engine).toContain('stagedKnowledgeBaseScope')
  })

  it('prepareTurn consumes the staged scope and clears it (per-turn recast, like the summon)', () => {
    expect(engine).toContain('this.opts.knowledgeBaseScope = this.stagedKnowledgeBaseScope')
    expect(engine).toContain('this.stagedKnowledgeBaseScope = null')
  })

  it('the knowledge_search executor funnels the scope into every search shape', () => {
    expect(domainTools).toContain('ex.opts.knowledgeBaseScope?.id')
    expect(domainTools).toContain('km.searchContent(query, scopeBaseId)')
    expect(domainTools).toContain('km.searchWiki(query, scopeBaseId)')
    expect(domainTools).toContain('if (scopeBaseId !== undefined) opts.baseId = scopeBaseId')
  })

  it('the ask chain carries the base hop by hop (any hop dropping it = silent全库)', () => {
    expect(preload).toContain('knowledgeBase?: { id: string; name: string } | null')
    expect(preload).toContain('ipcRenderer.invoke(IPC_CHANNELS.AGENT_SESSION_ASK, sessionId, content, summon, knowledgeBase)')
    expect(handler).toContain('agentSessionManager.ask(sessionId, content, undefined, summon, knowledgeBase)')
    expect(sessionManager).toContain('knowledgeBase?: { id: string; name: string } | null')
    expect(sessionManager).toContain('entry.engine.setKnowledgeBaseScope(knowledgeBase ?? null)')
  })

  it('the renderer parses the mention and hands it to the engine handle', () => {
    expect(controller).toContain('parseKnowledgeBaseMention(content, bases)')
    expect(controller).toContain('engineHandle.startLoop(content, knowledgeBase)')
    expect(controller).toContain('engineHandle.startSummonedLoop(content, mentioned, knowledgeBase)')
  })
})

// The scope is reachable by hand-typing only, and that is the ruling (user
// 2026-09-21: 去掉@框中的知识库相关的内容，去掉消息输入框中的@按钮). The parse
// chain above stays exactly as pinned — what is gone is the UI surface: the
// list itself and the composer button that opened the popup.
describe('the @-composer surface is experts-only (user ruling 2026-09-21)', () => {
  const inputArea = readFileSync(join(ROOT, 'src/renderer/src/components/chat/InputArea.tsx'), 'utf-8')

  it('non-vacuity: the scan reads the real composer', () => {
    expect(inputArea).toContain('data-mention-idx')
  })

  it('the popup neither loads nor lists knowledge bases', () => {
    expect(inputArea).not.toContain('knowledgeListBases')
    expect(inputArea).not.toContain('chatView.knowledgeBase')
  })

  it('the footer has no @ button — the popup still arms on a typed @', () => {
    // The glyph span was the button's whole icon; the popup's own arming rule
    // (typed text, not a click) is what remains, so it must still be there.
    expect(inputArea).not.toContain('>@</span>')
    expect(inputArea).toContain('const mentionActive')
  })
})
