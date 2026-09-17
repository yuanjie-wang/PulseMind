import { describe, expect, it, beforeEach } from 'vitest'
import { toolBlockSummary, toolDisplayName } from '../src/renderer/src/components/chat/tool-summary'
import { registerToolDescriptions, resetToolDescriptions, lookupToolDescription } from '../src/renderer/src/components/chat/tool-descriptions'
import type { ToolUseBlock } from '../src/renderer/src/types/agent'

/** PLAN-tool-ux T1（裁定 D1=C）：动词人性化、对象保留原文。折叠头与审批区
 *  同源这一契约不变——这里直接测那条同源字符串本身。 */

const zh = (key: string): string => {
  const table: Record<string, string> = {
    'toolLabel.exec': '运行命令',
    'toolLabel.read': '读取文件',
    'toolLabel.write': '写入文件',
    'toolLabel.edit': '编辑文件',
    'toolLabel.search': '搜索内容',
    'toolLabel.list_dir': '浏览目录',
    'toolLabel.webfetch': '访问网页',
    'toolLabel.git_commit': '创建提交',
    'toolLabel.spawn_agent': '派出专家',
    'toolLabel.knowledge_search': '检索知识库',
    'toolLabel.find': '查找文件',
    'toolLabel.page_click': '点击元素',
  }
  return table[key] ?? key
}

const block = (name: string, input: Record<string, unknown>): ToolUseBlock =>
  ({ type: 'tool_use', id: `t_${name}`, name, input, status: 'completed' }) as unknown as ToolUseBlock

beforeEach(() => {
  resetToolDescriptions()
})

describe('toolDisplayName', () => {
  it('maps known tools through the translator', () => {
    expect(toolDisplayName('exec', zh)).toBe('运行命令')
    expect(toolDisplayName('page_click', zh)).toBe('点击元素')
  })

  it('falls back to the raw name without a translator (pure function contract)', () => {
    expect(toolDisplayName('exec')).toBe('exec')
    expect(toolBlockSummary(block('exec', { command: 'npm test' }))).toBe('exec · npm test')
  })

  it('falls back to the schema description first sentence, then the raw name', () => {
    registerToolDescriptions([
      { name: 'mcp__git__get_diff', description: 'Show the working tree diff. Use before committing.' },
      { name: 'no_desc_tool' },
    ])
    expect(toolDisplayName('mcp__git__get_diff', zh)).toBe('Show the working tree diff')
    expect(toolDisplayName('no_desc_tool', zh)).toBe('no_desc_tool')
    expect(lookupToolDescription('mcp__git__get_diff')).toContain('diff')
  })
})

describe('toolBlockSummary object half stays verbatim', () => {
  it('exec keeps the raw command with the 80-char truncation (D1=C)', () => {
    const short = toolBlockSummary(block('exec', { command: 'npm install && npm run build' }), zh)
    expect(short).toBe('运行命令 · npm install && npm run build')
    const long = 'x'.repeat(200)
    expect(toolBlockSummary(block('exec', { command: long }), zh)).toBe(`运行命令 · ${'x'.repeat(80)}`)
  })

  it('fs families carry the path (write keeps its size suffix)', () => {
    expect(toolBlockSummary(block('read', { file_path: '/tmp/a/index.ts' }), zh)).toBe('读取文件 · /tmp/a/index.ts')
    expect(toolBlockSummary(block('edit', { file_path: '/tmp/a.ts', old_str: 'a', new_str: 'b' }), zh)).toBe('编辑文件 · /tmp/a.ts')
    expect(toolBlockSummary(block('write', { file_path: '/tmp/a.ts', content: 'x'.repeat(2048) }), zh)).toBe('写入文件 · /tmp/a.ts (2.0 KB)')
    expect(toolBlockSummary(block('list_dir', { dir_path: '/tmp' }), zh)).toBe('浏览目录 · /tmp')
  })

  it('search family carries the query; find its pattern', () => {
    expect(toolBlockSummary(block('search', { query: 'write lock' }), zh)).toBe('搜索内容 · write lock')
    expect(toolBlockSummary(block('find', { pattern: '*.test.ts' }), zh)).toBe('查找文件 · *.test.ts')
    expect(toolBlockSummary(block('knowledge_search', { query: '沙盒' }), zh)).toBe('检索知识库 · 沙盒')
  })

  it('webfetch shows the host, git_commit the message first line', () => {
    expect(toolBlockSummary(block('webfetch', { url: 'https://example.com/a/b' }), zh)).toBe('访问网页 · example.com')
    expect(toolBlockSummary(block('git_commit', { message: 'feat: write lock\n\ndetails' }), zh)).toBe('创建提交 · feat: write lock')
  })

  it('unknown family falls to the k=v chain with description excluded, label prefixed', () => {
    expect(toolBlockSummary(block('spawn_agent', { subAgentId: 'exp_1', task: 'do it', description: 'intent' }), zh))
      .toBe('派出专家 · subAgentId=exp_1')
    expect(toolBlockSummary(block('mcp__x__y', { repo: 'foo' }), zh)).toBe('mcp__x__y · repo=foo')
  })

  it('empty or absent input → label only (no dangling separator)', () => {
    expect(toolBlockSummary(block('read', {}), zh)).toBe('读取文件')
    const noInput = { type: 'tool_use', id: 't', name: 'read', status: 'completed' } as unknown as ToolUseBlock
    expect(toolBlockSummary(noInput, zh)).toBe('读取文件')
  })
})
