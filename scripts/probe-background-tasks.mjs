// ── probe-background-tasks（PLAN-background-tasks）───────────────────────────
//
// 骨架版（2026-11-07）：纯逻辑/静态不变量探针。计划里的真机探针（dev 应用内
// 跑 sleep → 点「转入后台」→ 观察自动投递回合 + 系统通知 + 绿点）工作量大，
// 本期降级为骨架 + 人工走查清单（见文件尾注释）；四段实现的静态契约由
// tests/background-delivery.test.ts + tests/persistent-shell.test.ts 钉死。
//
// 运行：node scripts/probe-background-tasks.mjs（exit 0 = 全部通过）。

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(REPO, rel), 'utf8')

let failures = 0
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) failures++
}

// 1. marker 契约（composer 与渲染端同一真源）
const notice = read('src/shared/background-notice.ts')
check('shared marker module exists with [[background-notice]]', notice.includes("'[[background-notice]]'"))

// 2. 合成消息走 ask（普通回合），marker 前缀 + 输出尾
const sm = read('src/main/agent/session-manager.ts')
check('deliverBackgroundNotice exists', sm.includes('async deliverBackgroundNotice'))
check('synthetic turn rides ask()', /deliverBackgroundNotice[\s\S]*?await this\.ask\(sessionId, content\)/.test(sm))
check('inline 2KB log tail via svcExecLogs', /svcExecLogs\(n\.pid, 2048\)/.test(sm))
check('gates ordered: reentry → empty → active → slots', (() => {
  const i = sm.indexOf('async deliverBackgroundNotice')
  const body = sm.slice(i, sm.indexOf('/** Rebuild engine options', i))
  const a = body.indexOf('deliveringBackground.has(sessionId)')
  const b = body.indexOf('backgroundNotices.length === 0')
  const c = body.indexOf('isActiveStatus(entry.engine.agentStatus)')
  const d = body.indexOf('runningLoops >= MAX_CONCURRENT_LOOPS')
  return a > -1 && a < b && b < c && c < d
})())

// 3. exit 事件面同拍发射
check('backgroundExit listener emits background_task', /setSessionBackgroundExitListener\(\(sessionId[\s\S]{0,800}type: 'background_task'/.test(sm))

// 4. 持久 shell 转后台的四个契约（详钉在 tests/persistent-shell.test.ts）
const term = read('src/main/services/terminal.ts')
check('svcPromoteToBackground exists', term.includes('export function svcPromoteToBackground'))
check('shell pid keys the background membership', term.includes('backgroundByPid.set(shellPid, entry)'))
check('detached sentinel closes the run + session push', term.includes('notifySessionBackgroundExit(shell.sessionId, shellPid, parsed.code)'))

// 5. D 段模型引导
const tools = read('src/renderer/src/tools/built-in-tools.ts')
const instr = read('src/renderer/src/tools/tool-instructions.ts')
check('exec background description carries the remote-watch pattern', tools.includes('gh run watch'))
check('exec manual carries both guidance lines', instr.includes('gh run watch') && instr.includes('放后台'))

// 6. vitest 侧的完整钉子仍然全绿（防探针与测试漂移）
try {
  execFileSync('npx', ['vitest', 'run', 'tests/background-delivery.test.ts', 'tests/persistent-shell.test.ts'], {
    cwd: REPO, stdio: 'inherit',
  })
  check('vitest pins green', true)
} catch {
  check('vitest pins green', false)
}

console.log(failures === 0 ? '\nprobe-background-tasks: ALL GREEN' : `\nprobe-background-tasks: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

// ── 真机走查清单（人工，dev 应用）────────────────────────────────────────────
// 1. 前台跑 `sleep 30`（或真 gh run watch）→ 卡片出现「转入后台」钮 → 点击：
//    ① 卡片立即以「后台运行中 pid=N」收口，回合结束、输入框立即可用；
//    ② 侧栏该会话灯槽出现数字 1；
//    ③ 主进程继续写 tmp/proc-logs/<pid>.log（shell 路径 = shell pid）。
// 2. 进程退出：正在看该会话且空闲 → 合成回合出现（纤细系统行 + 模型播报输出尾）。
// 3. 进程退出但会话非当前/窗口无焦点：侧栏绿点 + 系统通知（设置可关）。
// 4. 前台忙（回合进行中）退出：回合结束后自动补投递（busy→completed 边沿）。
// 5. 转后台后立刻发新命令：落新 shell，cwd 恢复、export 丢失（接受代价）。
// 6. exec_kill(pid) / 会话销毁对被转后台的进程仍然有效。
