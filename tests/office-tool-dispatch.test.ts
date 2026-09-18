// office_inspect dispatch consistency (review_20260919 H10).
// The tool was registered with an executor case in execWorkspaceTool, but the
// DISPATCH side never knew the name: 全部允许 routed it to execOtherTool →
// "Unknown tool", and an approval release fell through approveTool's branches
// into the shell default — with a model-supplied `command` field executed as a
// shell command. The fix puts office_inspect on the read tier and gives both
// dispatch surfaces an explicit branch; vitest here is node-env (the engine
// cannot be mounted), so the contract is asserted as source — the same way
// tests/pending-approval.test.ts and tests/expert-delegation.test.ts pin
// their wiring.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8')

const tiers = read('src/renderer/src/agent/engine/tool-tiers.ts')
const executors = read('src/renderer/src/agent/tool-executors.ts')
const flow = read('src/renderer/src/agent/engine/execution-flow.ts')
const builtins = read('src/renderer/src/tools/built-in-tools.ts')

describe('office_inspect — registration ⊆ dispatch (H10)', () => {
  it('non-vacuity: the scans read real sources', () => {
    expect(tiers).toContain('READ_TIER_TOOLS')
    expect(builtins).toContain("name: 'office_inspect'")
  })

  it('office_inspect sits on the read tier', () => {
    expect(tiers).toMatch(/READ_TIER_TOOLS = new Set\(\[[^\]]*'office_inspect'[^\]]*\]\)/)
  })

  it('the read-tier executor dispatches it to the workspace executor', () => {
    // execReadOnlyTools: without this branch the tool fell to the shell
    // command builder at the bottom of the method.
    expect(executors).toMatch(/execReadOnlyTools[\s\S]*?if \(t\.name === 'office_inspect'\) \{\s*\n\s*await this\.execWorkspaceTool\(t\)/)
  })

  it('an approval release can never reach the shell default', () => {
    expect(flow).toMatch(/if \(targetBlock\.name === 'office_inspect'\) \{\s*\n\s*await this\.engine\.toolExecutor\.execWorkspaceTool\(targetBlock\)/)
  })

  it('the workspace executor keeps its inspect case (the implementation)', () => {
    expect(executors).toMatch(/else if \(t\.name === 'office_inspect'\) \{/)
  })
})
