// ── Search center ──
// One entry point for the app's four content stores: conversation titles, message
// bodies, memories (FTS5) and knowledge (FTS5 with fallbacks). Every store is queried
// independently, so one failing store still leaves the other groups usable.

import React, { useEffect, useRef, useState } from 'react'
import { Input, Spin } from 'antd'
import { SearchOutlined, DatabaseOutlined, MessageOutlined, CommentOutlined, BulbOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'
import { useNavigationStore } from '../../stores/navigationStore'
import type { MemoryEntry } from '../../memory/types'

/** Queries settle before searching, so typing does not fire a request per keystroke. */
const DEBOUNCE_MS = 300
/** Per-store cap — the groups are a way into the content, not a full export. */
const RESULT_LIMIT = 20

interface ConversationHit {
  id: string
  title: string
  summary: string | null
}

interface MessageHit {
  conversationId: string
  conversationTitle: string
  role: 'user' | 'assistant'
  snippet: string
}

interface KnowledgeHit {
  id: string
  filePath: string
  title: string
  excerpts: string[]
}

interface SearchResults {
  conversations: ConversationHit[]
  messages: MessageHit[]
  memories: MemoryEntry[]
  knowledge: KnowledgeHit[]
}

/** Results tagged with the keyword they were fetched for: anything the render reads
 *  that is not tagged with the *current* keyword is still in flight, so the view needs
 *  no separate "searching" flag and never shows one keyword's hits under another. */
interface SearchState {
  keyword: string
  results: SearchResults
  failed: boolean
}

export interface SearchViewProps {
  /** Open a conversation in the chat view. */
  onOpenConversation?: (conversationKey: string) => void
  /** Reveal the memory manager, where memories are edited. */
  onOpenMemory?: () => void
}

/** A group heading plus its rows; renders nothing when the group came back empty. */
function Group({ title, count, children }: { title: string; count: number; children: React.ReactNode }): React.ReactElement | null {
  if (count === 0) return null
  return (
    <section style={{ marginBottom: 22 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '0 0 6px', fontSize: 12, color: '#999' }}>
        <span>{title}</span>
        <span style={{ color: '#c8c8c8' }}>{count}</span>
      </div>
      <div style={{ border: '1px solid #f0f0f0', borderRadius: 8, overflow: 'hidden' }}>{children}</div>
    </section>
  )
}

/** One result: a title line, an optional meta line, and the matched text. */
function Row({
  icon,
  title,
  meta,
  body,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  meta?: string
  body?: string
  onClick: () => void
}): React.ReactElement {
  return (
    <div className="search-row" onClick={onClick}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: '#222', flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ color: '#999', marginRight: 6 }}>{icon}</span>
          {title}
        </span>
        {meta && <span style={{ fontSize: 11, color: '#aaa', flexShrink: 0 }}>{meta}</span>}
      </div>
      {body && <div style={{ fontSize: 12, color: '#666', marginTop: 3, lineHeight: 1.6, wordBreak: 'break-word' }}>{body}</div>}
    </div>
  )
}

export function SearchView({ onOpenConversation, onOpenMemory }: SearchViewProps): React.ReactElement {
  const { t } = useTranslation()
  const navigate = useNavigationStore((s) => s.navigate)
  const [query, setQuery] = useState('')
  const [state, setState] = useState<SearchState | null>(null)
  // Every run gets an id: a slower earlier query must not settle after a newer one.
  const runIdRef = useRef(0)

  useEffect(() => {
    const keyword = query.trim()
    const runId = ++runIdRef.current
    if (!keyword) return

    const timer = setTimeout(async () => {
      // A store that throws reports null: the group is dropped, the rest still show.
      const [conversations, messages, memories, knowledge] = await Promise.all([
        window.electronAPI.searchConversationsByKeyword(keyword, RESULT_LIMIT).catch(() => null),
        window.electronAPI.searchMessagesByKeyword(keyword, RESULT_LIMIT).catch(() => null),
        window.electronAPI.searchMemories({ query: keyword, limit: RESULT_LIMIT }).catch(() => null),
        window.electronAPI.knowledgeSearchContent(keyword).catch(() => null),
      ])
      if (runIdRef.current !== runId) return

      setState({
        keyword,
        failed: [conversations, messages, memories, knowledge].every((group) => group === null),
        results: {
          conversations: conversations ?? [],
          messages: messages ?? [],
          memories: memories ?? [],
          knowledge: (knowledge ?? []).slice(0, RESULT_LIMIT),
        },
      })
    }, DEBOUNCE_MS)

    return () => clearTimeout(timer)
  }, [query])

  const openConversation = (key: string): void => {
    navigate({ kind: 'chat' })
    onOpenConversation?.(key)
  }

  const keyword = query.trim()
  const settled = state && state.keyword === keyword ? state : null
  const results = settled?.results
  const total = results ? results.conversations.length + results.messages.length + results.memories.length + results.knowledge.length : 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#fff' }}>
      <div style={{ padding: '18px 24px 12px' }}>
        <Input
          autoFocus
          allowClear
          size="large"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('search.placeholder')}
          prefix={<SearchOutlined style={{ color: '#bbb' }} />}
        />
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 24px' }}>
        {!keyword ? (
          <div style={{ color: '#bbb', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>{t('search.hint')}</div>
        ) : !settled ? (
          <div style={{ padding: '40px 0', textAlign: 'center' }}>
            <Spin />
          </div>
        ) : settled.failed ? (
          <div style={{ color: '#bbb', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>{t('search.failed')}</div>
        ) : total === 0 ? (
          <div style={{ color: '#bbb', fontSize: 13, padding: '40px 0', textAlign: 'center' }}>{t('search.noResults', { q: keyword })}</div>
        ) : (
          <>
            <Group title={t('search.groups.conversations')} count={results!.conversations.length}>
              {results!.conversations.map((hit) => (
                <Row
                  key={hit.id}
                  icon={<MessageOutlined />}
                  title={hit.title || hit.id}
                  body={hit.summary ?? undefined}
                  onClick={() => openConversation(hit.id)}
                />
              ))}
            </Group>

            <Group title={t('search.groups.messages')} count={results!.messages.length}>
              {results!.messages.map((hit, index) => (
                <Row
                  key={`${hit.conversationId}:${index}`}
                  icon={<CommentOutlined />}
                  title={hit.conversationTitle || hit.conversationId}
                  meta={hit.role === 'user' ? t('search.roleUser') : t('search.roleAssistant')}
                  body={hit.snippet}
                  onClick={() => openConversation(hit.conversationId)}
                />
              ))}
            </Group>

            <Group title={t('search.groups.memories')} count={results!.memories.length}>
              {results!.memories.map((hit) => (
                <Row key={hit.id} icon={<BulbOutlined />} title={hit.content} meta={t('search.openMemory')} onClick={() => onOpenMemory?.()} />
              ))}
            </Group>

            <Group title={t('search.groups.knowledge')} count={results!.knowledge.length}>
              {results!.knowledge.map((hit) => (
                <Row
                  key={hit.id}
                  icon={<DatabaseOutlined />}
                  title={hit.title || hit.filePath}
                  body={hit.excerpts[0]}
                  onClick={() => navigate({ kind: 'knowledge' })}
                />
              ))}
            </Group>
          </>
        )}
      </div>

      <style>{`
        .search-row {
          padding: 10px 14px;
          cursor: pointer;
          border-bottom: 1px solid #f5f5f5;
          transition: background 0.15s;
        }
        .search-row:last-child { border-bottom: none; }
        .search-row:hover { background: #f7f7f7; }
      `}</style>
    </div>
  )
}

export default SearchView
