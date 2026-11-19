// 运行视图的三个动作（2026-11-18）：停止 / 重跑本次·从失败节点续跑 / 产物点开。
// 这三件事的正确性都不在「按钮画出来了」上，而在三处判断力：
//   1. 产物路径归一——相对路径要挂到工作区根下，绝对路径原样透传；错了不会崩，
//      只会让「点开产物」打开一个不存在的路径。
//   2. 停止的双臂——在飞实例走 stop 钩子，排队实例没有钩子、必须撤销队列并结算
//      run 行，否则点停止只静默无反应、行还挂在 running 上转圈。
//   3. 续跑的三道门——运行中不许、回滚过基线不许（前序产物已不在盘上）、没有
//      已完成的前序阶段不许（那与重跑没区别）；引擎侧的播种语义见
//      workflow-engine.test.ts 的 resume 组。
//
// 引擎/主进程的判断力用行为测，UI 与 IPC 的接线只有源码扫描能抓。

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { artifactAbsPath } from '../src/renderer/src/components/routine/run-artifact'

const read = (p: string): string => readFileSync(resolve(__dirname, '..', p), 'utf8')

describe('artifactAbsPath', () => {
  it('工作区相对路径挂到根下', () => {
    expect(artifactAbsPath('/Users/x/ws', 'out/report.md')).toBe('/Users/x/ws/out/report.md')
    expect(artifactAbsPath('/Users/x/ws', 'a/b/c.png')).toBe('/Users/x/ws/a/b/c.png')
  })

  it('开头的 ./ 被剥掉（模型常这么写）', () => {
    expect(artifactAbsPath('/ws', './out/a.md')).toBe('/ws/out/a.md')
    // 只剥一层：`././x` 不是合法产物路径，保持诚实
    expect(artifactAbsPath('/ws', '././a.md')).toBe('/ws/./a.md')
  })

  it('工作区根的尾斜杠（含多根）不叠出双斜杠', () => {
    expect(artifactAbsPath('/ws/', 'a.md')).toBe('/ws/a.md')
    expect(artifactAbsPath('/ws///', 'a.md')).toBe('/ws/a.md')
    expect(artifactAbsPath('C:\\ws\\', 'a.md')).toBe('C:\\ws/a.md')
  })

  it('POSIX 绝对路径原样透传', () => {
    expect(artifactAbsPath('/ws', '/tmp/x.md')).toBe('/tmp/x.md')
  })

  it('Windows 盘符绝对路径（两种分隔符）原样透传', () => {
    expect(artifactAbsPath('C:\\ws', 'D:\\tmp\\x.md')).toBe('D:\\tmp\\x.md')
    expect(artifactAbsPath('C:\\ws', 'D:/tmp/x.md')).toBe('D:/tmp/x.md')
  })

  it('前后空白被修剪（落库字符串偶尔带空格）', () => {
    expect(artifactAbsPath('/ws', '  a.md  ')).toBe('/ws/a.md')
    expect(artifactAbsPath('/ws', '  /tmp/x.md ')).toBe('/tmp/x.md')
  })

  it('工作区根本身带尾斜杠 + 相对路径带 ./ 同时发生', () => {
    expect(artifactAbsPath('/ws/', './out/a.md')).toBe('/ws/out/a.md')
  })
})

describe('停止：在飞走 stop、排队撤销队列（源码扫描）', () => {
  const handler = read('src/main/ipc/pipeline.handler.ts')

  it('runId 前缀守卫 + stop 命中即真、否则 cancel 结算 run 行', () => {
    expect(handler).toMatch(/if \(!String\(runId \?\? ''\)\.startsWith\('prun_'\)\) return false/)
    expect(handler).toMatch(/if \(pipelineEngine\.stop\(id\)\) return true/)
    // 排队实例没有停止钩子：撤销 + 落失败行，否则行永远挂着 running
    expect(handler).toMatch(/return pipelineEngine\.cancel\(id, '已停止（未启动）'\)/)
  })

  it('运行视图：停止钮只在 running 时出现，false 回落如实提示', () => {
    const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')
    expect(page).toContain('window.electronAPI.pipelineStop(run.id)')
    expect(page).toMatch(/\{run\?\.status === 'running' && \(/)
    expect(page).toContain("t('workflow.runViewStopNoop')")
  })
})

describe('重跑 / 续跑：三道门与 resume 透传（源码扫描）', () => {
  const handler = read('src/main/ipc/pipeline.handler.ts')
  const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')

  it('主进程门：运行中 / 回滚过基线 / 无已完成前序阶段', () => {
    expect(handler).toMatch(/if \(prev\.status === 'running'\) throw new Error\('该运行还在进行中，先停止再重跑'\)/)
    expect(handler).toMatch(/if \(prev\.baselineCommit\) \{/)
    expect(handler).toMatch(/if \(!settledBefore\) throw new Error\('没有可复用的已完成阶段，续跑与重跑没有区别'\)/)
    // 前序阶段 = 不是起点、有 verdict、没有 error
    expect(handler).toMatch(/s\.nodeId !== nodeId && !!s\.verdict && !s\.error/)
  })

  it('resume 只在续跑臂铸出并透传给 launch（fresh 不带）', () => {
    expect(handler).toMatch(/resume = \{ fromRunId: id, nodeId \}/)
    expect(handler).toMatch(/\.\.\.\(resume \? \{ resume \} : \{\}\)/)
    expect(handler).toMatch(/pipelineRunStore\.getRun\(id\)/)
    expect(handler).toMatch(/workflowStore\.get\(prev\.workflowId\)/)
  })

  it('渲染端：续跑常驻但按 resumeBlocked 置灰，Tooltip 说明原因', () => {
    // 回滚优先于「无前序」——回滚过的运行里前序阶段行是有的，只是产物没了
    expect(page).toMatch(/if \(!run \|\| run\.status !== 'failed'\) return 'noPrior'/)
    expect(page).toMatch(/if \(run\.baselineCommit\) return 'rollback'/)
    expect(page).toMatch(/if \(!run\.currentNode\) return 'noPrior'/)
    expect(page).toMatch(/const hasPrior = stages\.some\(\(s\) => s\.nodeId !== run\.currentNode && !!s\.verdict && !s\.error\)/)
    expect(page).toContain('disabled={resumeBlocked !== null')
    expect(page).toContain("t('workflow.runViewResumeBlockedRollback')")
    expect(page).toContain("t('workflow.runViewResumeBlockedNoPrior')")
    // 置灰的 antd Button 不派发鼠标事件，Tooltip 必须挂外层 span
    expect(page).toMatch(/<span>[\s\S]{0,500}runViewResume'\)[\s\S]{0,80}<\/span>/)
  })

  it('渲染端：重跑本次/续跑都打同一个 pipelineRerun，模式区分', () => {
    expect(page).toContain('window.electronAPI.pipelineRerun(run.id, mode)')
    expect(page).toContain("onClick={() => void onRerun('resume')}")
    expect(page).toContain("onClick={() => void onRerun('fresh')}")
    // 新实例 → 跳到新 runId（用户要看的是这次新跑的过程）
    expect(page).toMatch(/navigate\(\{ kind: 'routines', workflowRunViewId: res\.runId \}\)/)
  })
})

describe('产物点开（源码扫描）', () => {
  const page = read('src/renderer/src/components/routine/WorkflowRunViewPage.tsx')

  it('纯函数已提出组件（可单测），页面只 import 不再本地定义', () => {
    expect(page).toContain("import { artifactAbsPath } from './run-artifact'")
    expect(page).not.toMatch(/function artifactAbsPath/)
  })

  it('产物 chip 走 openFolder（系统默认程序打开，不是 Finder 里选中）', () => {
    expect(page).toContain('data-workflow-artifact={a}')
    expect(page).toContain('window.electronAPI.openFolder(artifactAbsPath(workspaceDir, rel))')
    // 主进程的失败（缺失路径/可执行黑名单）要显示出来，不吞
    expect(page).toMatch(/message\.error\(err instanceof Error \? err\.message : String\(err\)\)/)
  })
})

describe('IPC 四面 + i18n 两 locale', () => {
  it('channels / preload / bridge 三面同在', () => {
    const channels = read('src/shared/ipc-channels.ts')
    expect(channels).toContain("PIPELINE_STOP: 'pipeline:stop'")
    expect(channels).toContain("PIPELINE_RERUN: 'pipeline:rerun'")
    const preload = read('src/preload/index.ts')
    expect(preload).toContain('pipelineStop: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_STOP, runId)')
    expect(preload).toContain("pipelineRerun: (runId: string, mode: 'fresh' | 'resume') => ipcRenderer.invoke(IPC_CHANNELS.PIPELINE_RERUN, runId, mode)")
    const bridge = read('src/shared/types/electron-bridge.ts')
    expect(bridge).toContain('pipelineStop: (runId: string) => Promise<boolean>')
    expect(bridge).toContain("pipelineRerun: (runId: string, mode: 'fresh' | 'resume') => Promise<{ runId: string }>")
  })

  it('文案键中英同批存在（含两种续跑阻断的原因）', () => {
    const zh = read('src/renderer/src/i18n/locales/zh.ts')
    const en = read('src/renderer/src/i18n/locales/en.ts')
    for (const key of [
      'runViewArtifactOpen',
      'runViewStop',
      'runViewStopNoop',
      'runViewRerun',
      'runViewRerunStarted',
      'runViewResume',
      'runViewResumeStarted',
      'runViewResumeBlockedRollback',
      'runViewResumeBlockedNoPrior',
    ]) {
      expect(zh).toContain(`${key}:`)
      expect(en).toContain(`${key}:`)
    }
  })
})
