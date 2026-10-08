// ── Segment-copied message ids must never reach a backend write ──
// groupMessages splits an assistant turn into per-breakpoint COPIES renamed
// `__text` / `__exec` / `__ask` (message-segments.ts) so one turn can render as
// a text bubble plus collapsible tool segments. The mirror — and therefore the
// `messages` row — keeps the BARE id: the save pipeline snapshots engine
// messages, not segment copies. MessageGroup renders from the copy, so its
// backend writes (knowledge capture, like metadata) used to address
// `msg_…__text` — the favorite capture failed its message-existence check
// (「消息尚未保存或不属于此会话」on every star click, live-reproduced
// 2026-10-08) and the metadata UPDATE silently hit 0 rows. This file pins both
// halves: where the suffix is minted (pure logic) and that MessageGroup strips
// it before any IPC (source scan — vitest is node-env, no renderer).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { groupMessages, stripMessageIdSuffix } from '../src/renderer/src/components/chat/message-segments'
import type { AgentMessage, ContentBlock } from '../src/renderer/src/types/agent'

const ROOT = join(__dirname, '..')

const msg = (over: Partial<AgentMessage> = {}): AgentMessage => ({
  id: 'msg_1791471914785_aq0jv7v',
  role: 'assistant',
  contentBlocks: [],
  createdAt: '2026-10-08T15:05:14.785Z',
  ...over,
})

describe('stripMessageIdSuffix', () => {
  it('strips every breakpoint suffix the segment layer mints', () => {
    expect(stripMessageIdSuffix('msg_x__text')).toBe('msg_x')
    expect(stripMessageIdSuffix('msg_x__exec')).toBe('msg_x')
    expect(stripMessageIdSuffix('msg_x__ask')).toBe('msg_x')
  })

  it('leaves bare mirror ids untouched — the id shape is suffix-shaped on purpose', () => {
    // Non-vacuity: real ids carry single underscores (`_h358roe`); the regex is
    // anchored on the DOUBLE underscore tail. If this ever stripped a bare id,
    // the "fix" would be corrupting every write it touches.
    expect(stripMessageIdSuffix('msg_1791471914785_aq0jv7v')).toBe('msg_1791471914785_aq0jv7v')
    expect(stripMessageIdSuffix('msg_1791470733941_h358roe')).toBe('msg_1791470733941_h358roe')
  })
})

describe('where the divergence is minted', () => {
  it('the text segment copy is renamed __text while the input keeps the bare id', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '正文' } as ContentBlock,
      { type: 'tool_use', id: 'tu_1', name: 'read', input: {} } as ContentBlock,
    ]
    const segs = groupMessages([msg({ contentBlocks: blocks })])
    const textSeg = segs.find(s => s.type === 'single') as { type: 'single'; msg: AgentMessage }
    expect(textSeg.msg.id).toBe('msg_1791471914785_aq0jv7v__text')
    // the render copy is a COPY: whatever the mirror holds stays bare
    expect(stripMessageIdSuffix(textSeg.msg.id)).toBe('msg_1791471914785_aq0jv7v')
  })
})

describe('MessageGroup addresses backend writes at the bare id (wiring scan)', () => {
  const src = readFileSync(join(ROOT, 'src/renderer/src/components/chat/MessageGroup.tsx'), 'utf8')

  it('strips the segment suffix once and uses it for BOTH backend writes', () => {
    expect(src).toMatch(/const persistedMsgId = stripMessageIdSuffix\(msg\.id\)/)
    // knowledge capture: the field the favorite handler looks up
    expect(src).toMatch(/messageId: persistedMsgId/)
    // like metadata: an UPDATE keyed on the row id — a suffixed id hits 0 rows
    // silently, so the like is lost on the next hydration
    expect(src).toMatch(/updateMessageMetadata\(persistedMsgId, \{ liked: next \}\)/)
  })

  it('never sends the segment copy id straight to a backend write', () => {
    // Non-vacuity: this is the exact regression shape (the old lines read
    // `messageId: msg.id` / `updateMessageMetadata(msg.id, …)`).
    expect(src).not.toMatch(/messageId: msg\.id\b/)
    expect(src).not.toMatch(/updateMessageMetadata\(msg\.id\b/)
  })
})
