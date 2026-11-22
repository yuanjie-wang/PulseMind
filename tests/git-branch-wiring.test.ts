// Wiring pins for the composer git branch picker. Source scans cannot prove a
// git CLI returns the right thing (tests/git-branch-actions.test.ts does that
// against real repos); they pin the CROSS-LAYER wiring that a real-repo test
// cannot see: prop chain, footer order, the single IPC channel, the collapse
// stage, and the two confirmation gates.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8')

const inputArea = read('src/renderer/src/components/chat/InputArea.tsx')
const chatView = read('src/renderer/src/components/layout/ChatView.tsx')
const chatBody = read('src/renderer/src/components/chat/ChatBody.tsx')
const composer = read('src/renderer/src/components/chat/Composer.tsx')
const gitTypes = read('src/shared/types/git.ts')
const service = read('src/main/git/git.service.ts')
const button = read('src/renderer/src/components/chat/GitBranchButton.tsx')
const hook = read('src/renderer/src/hooks/useGitBranch.ts')
const zh = read('src/renderer/src/i18n/locales/zh.ts')
const en = read('src/renderer/src/i18n/locales/en.ts')

describe('composer git branch picker wiring', () => {
  it('footerLeft: the 授权 button sits immediately to the LEFT of the git picker', () => {
    const branch = inputArea.indexOf('<GitBranchButton')
    const approval = inputArea.indexOf('{showAuthorization && (')
    expect(approval).toBeGreaterThan(0)
    expect(branch).toBeGreaterThan(approval)
    expect(inputArea).toContain('from \'./GitBranchButton\'')
  })

  it('only project-bound conversations can mount it', () => {
    expect(inputArea).toContain('features?.gitBranch')
    expect(inputArea).toContain('!!gitProjectId')
    expect(button).toContain('!status?.isRepo')
    expect(button).toContain('!branches?.isRepo')
  })

  it('the project id reaches BOTH welcome and chat InputArea hosts', () => {
    // ChatView: its own welcome InputArea + the ChatBody it renders.
    expect(chatView.match(/gitProjectId=\{composerProjectId\}/g)?.length).toBe(2)
    // ChatBody: its welcome InputArea + transcript InputArea.
    expect(chatBody.match(/gitProjectId=\{gitProjectId\}/g)?.length).toBe(2)
    expect(chatBody).toContain('gitProjectId?: string')
    // Three total: the two InputArea hosts plus the pre-existing
    // TurnDeliverablesCard, which has always taken the conversation workspace.
    expect(chatBody.match(/workspaceDir=\{workspaceDir\}/g)?.length).toBe(3)
  })

  it('reads and writes both ride GIT_INVOKE, never the terminal channel', () => {
    expect(hook).toContain("action: 'status'")
    expect(hook).toContain("action: 'branch_list'")
    expect(button).toContain("action: 'switch'")
    expect(button).toContain("action: 'branch_create'")
    expect(button).not.toContain('execCommandSync')
    expect(button).not.toContain('TERMINAL_EXEC')
    expect(hook).not.toContain('execCommandSync')
  })

  it('branch actions are first-class in the service and share the write jail', () => {
    for (const action of ['branch_list', 'switch', 'branch_create']) {
      expect(gitTypes).toContain(`'${action}'`)
      expect(service).toContain(`case '${action}'`)
    }
    // A switch rewrites HEAD + work tree, so it must be inside the same cwd
    // gate as commit/restore — not just a new case in the dispatch.
    const jail = service.slice(service.indexOf('currentSessionSandbox()') - 400, service.indexOf('currentSessionSandbox()'))
    expect(jail).toContain("action.action === 'switch'")
    expect(jail).toContain("action.action === 'branch_create'")
    // Empty repo "## No commits yet on main" must not become the branch name.
    expect(service).toContain('No commits yet on')
  })

  it('the branch label sheds at the EXISTING ≤500 stage — no new breakpoint', () => {
    expect(composer).toContain('.pm-branch-label { display: none; }')
    const labelRule = composer.indexOf('.pm-branch-label { display: none; }')
    const stage500 = composer.indexOf('@container pm-composer (max-width: 500px)')
    const stage440 = composer.indexOf('@container pm-composer (max-width: 440px)')
    expect(labelRule).toBeGreaterThan(stage500)
    expect(labelRule).toBeLessThan(stage440)
    expect(composer).not.toContain('(max-width: 600px)')
    expect(composer).not.toContain('(max-width: 700px)')
    expect(button).toContain('pm-branch-label')
  })

  it('the outer chip shows only the branch name — statuses stay in the panel', () => {
    const chip = button.slice(button.indexOf('className="pm-chat-branch"'))
    expect(chip).toContain('{currentName}')
    expect(chip).toContain('pm-branch-label')
    expect(chip).not.toContain('dirtyCount')
    expect(chip).not.toContain('status.ahead')
    expect(chip).not.toContain('conflictCount')
    // The panel's status block still carries them for the safety gate.
    expect(button).toContain('{dirtyCount > 0 && <span')
    expect(button).toContain('{status.ahead > 0 && <span')
  })

  it('panel rows: real :hover on every row, and three distinct highlight levels', () => {
    expect(button).toContain('<style>{BRANCH_ROW_CSS}</style>')
    expect(button).toContain('.pm-git-branch-row:hover')
    expect(button).toContain('onMouseEnter')
    // current = link tint, keyboard active = strong wash, hover = light wash.
    expect(button).toContain('background: var(--pm-link-bg)')
    expect(button).toContain('background: var(--pm-hover-strong)')
    // No blue left bar (user ruling 2026-11-21): the tint alone marks current.
    expect(button).not.toContain('box-shadow: inset')
    expect(button).toContain('pm-git-branch-row-current')
  })

  it('panel helper ink is quiet; the outer caret matches the 授权 / 模型 carets', () => {
    // The clarity fix lifted PANEL helper text from faint -> quiet. The outer
    // caret is chrome, not helper text: it stays faint so the git picker reads
    // exactly like the permission and model Dropdowns beside it.
    const chipAt = button.indexOf('className="pm-chat-branch"')
    const panel = button.slice(0, chipAt)
    const chip = button.slice(chipAt)
    expect(panel).not.toContain('--pm-text-faint')
    expect(panel).toContain('--pm-text-quiet')
    const caret = "style={{ fontSize: 10, color: 'var(--pm-text-faint)', marginLeft: 4 }}"
    expect(chip).toContain(caret)
    expect(inputArea).toContain(caret)
    // Negative control: quieting the caret again is exactly the mismatch.
    expect(chip.replace(caret, caret.replace('--pm-text-faint', '--pm-text-quiet'))).not.toContain(caret)
    expect(button).not.toContain('#185FA5')
    expect(button).toContain("background: 'var(--pm-elevated)'")
  })

  it('both confirmation gates are present (running turn + dirty tree)', () => {
    expect(button).toContain('isRequesting')
    expect(button).toContain('dirtyCount > 0')
    expect(button).toContain('okButtonProps: { danger: true }')
    expect(button).toContain('conflictCount > 0')
    // P0 has no stash action — the user can cancel and commit first.
    expect(button).not.toContain("action: 'stash'")
  })

  it('zh + en both carry the gitBranch strings', () => {
    expect(zh).toContain('gitBranch: {')
    expect(en).toContain('gitBranch: {')
    expect(zh).toContain('dirtyBody:')
    expect(en).toContain('runningBody:')
  })

  it('阴性对照：拆掉任一环，对应的 pin 恰好变红', () => {
    const withoutJail = service.replace("action.action === 'switch'", "action.action === 'never'")
    const jail = withoutJail.slice(withoutJail.indexOf('currentSessionSandbox()') - 400, withoutJail.indexOf('currentSessionSandbox()'))
    expect(jail).not.toContain("action.action === 'switch'")
    expect(inputArea.replace('!!gitProjectId', 'true')).not.toContain('!!gitProjectId')
    expect(composer.replace('(max-width: 500px)', '(max-width: 999px)')).not.toContain('@container pm-composer (max-width: 500px)')
  })
})
