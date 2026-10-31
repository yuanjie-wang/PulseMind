// ── 验证/诊断 strip（PLAN-project-ide 刀一，2026-10-31）──
//
// 树列底部的条形面板，刀三 diff strip 的兄弟件。探测、摘要、失败锚点全部
// 复用 agent/verify-loop.ts 的既有件——`detectVerifyCommands` 的 TTL 缓存是
// 面板与 agent state block 共读的同一份，两者对「工作区定义了什么验证命令」
// 永远不会各执一词；空结果（办公/划痕工作区）就是诚实提示，它同时也是
// 「代码类项目」的判定——不另设项目类型字段。
//
// 执行走渲染端一次性命令桥（execCommandSync）：每次运行都过主进程
// gateRendererExecution 的原生确认框——渲染端发起的 exec 没有审批梯子可答，
// 这个信任形态本刀刻意不动（确认框摩擦记为 PLAN 的开放问题）。
// 失败行点击 → openInPreviewPane：runner 印了行号就 reveal 到行，只有文件名
// 就开在文件顶部（不发明行号，与 summarizeTestOutput 同一裁定）。
//
// 状态重置靠 key 重挂载：外层按 workspaceDir 给 <VerifyPanelBody> 发 key，
// 换目录 = 整个内层换新，运行中/结果/展开态全部归零，effect 里因此只有
// 异步回调 setState（react-hooks/set-state-in-effect）。

import React, { useEffect, useState } from 'react'
import { DeleteOutlined } from '@ant-design/icons'
import { Spin } from 'antd'
import { detectVerifyCommands, parseTestFailures, summarizeTestOutput, type TestFailureLocation } from '../../agent/verify-loop'
import { openInPreviewPane } from '../../stores/previewPaneStore'

/** Idle cap for a verify run — npm/cargo 首次编译可能长时间静默，30s 的默认
 *  idle 帽会误杀；120s 之内无任何输出再杀（wall 帽沿用主进程常量）。 */
const VERIFY_IDLE_TIMEOUT_MS = 120_000

interface Props {
  workspaceDir: string | null
  onClose: () => void
}

interface RunResult {
  command: string
  code: number | null
  output: string
}

export function VerifyPanel({ workspaceDir, onClose }: Props): React.ReactElement {
  return (
    <div
      data-ws-verify-panel
      style={{
        flexShrink: 0,
        maxHeight: '48%',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        borderTop: '1px solid var(--pm-separator-faint)',
        background: 'var(--pm-bg)',
      }}
    >
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderBottom: '1px solid var(--pm-separator-faint)' }}>
        <span style={{ fontSize: 11, color: 'var(--pm-text-muted)', flex: 1, minWidth: 0 }}>验证</span>
        <button type="button" className="pm-ws-btn" title="关闭验证面板" aria-label="关闭验证面板" onClick={onClose}>
          <DeleteOutlined style={{ transform: 'rotate(45deg)' }} />
        </button>
      </div>
      {workspaceDir == null ? (
        <Body>
          <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', padding: '4px 0' }}>当前会话暂无工作目录</div>
        </Body>
      ) : (
        // key = workspaceDir: 换目录即重挂载，内层状态（运行中/结果/输出展开）
        // 天然归零，无需在 effect 里逐项重置。
        <VerifyPanelBody key={workspaceDir} workspaceDir={workspaceDir} />
      )}
    </div>
  )
}

function Body({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="auto-hide-scroll" style={{ overflow: 'auto', minHeight: 0, padding: '6px 10px', fontSize: 12 }}>
      {children}
    </div>
  )
}

function VerifyPanelBody({ workspaceDir }: { workspaceDir: string }): React.ReactElement {
  const [cmds, setCmds] = useState<string[] | null>(null) // null = detecting
  const [running, setRunning] = useState<string | null>(null)
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outputOpen, setOutputOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void detectVerifyCommands(workspaceDir).then((c) => {
      if (!cancelled) setCmds(c)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceDir])

  const run = async (command: string): Promise<void> => {
    if (running) return
    setRunning(command)
    setResult(null)
    setError(null)
    setOutputOpen(false)
    try {
      const res = await window.electronAPI.execCommandSync(command, workspaceDir, VERIFY_IDLE_TIMEOUT_MS)
      setResult({ command, code: res.code, output: res.output })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(null)
    }
  }

  const failures: TestFailureLocation[] = result ? parseTestFailures(result.output) : []
  const summary = result ? summarizeTestOutput(result.output) : null
  const ok = result != null && result.code === 0

  return (
    <Body>
      {cmds === null ? (
        <div style={{ padding: '8px 0', textAlign: 'center' }}>
          <Spin size="small" />
        </div>
      ) : cmds.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--pm-text-muted)', padding: '4px 0' }}>
          未检测到验证命令（工作区根缺 package.json / Cargo.toml / go.mod / pyproject.toml / Makefile）
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {cmds.map((c) => (
              <button
                key={c}
                type="button"
                className="pm-ws-btn"
                data-ws-verify-run
                disabled={running != null}
                title={running != null && running !== c ? '已有验证在运行' : `运行 ${c}`}
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 4,
                  border: '1px solid var(--pm-separator-faint)',
                  color: running === c ? 'var(--pm-link)' : 'var(--pm-text-muted)',
                  opacity: running != null && running !== c ? 0.5 : 1,
                }}
                onClick={() => void run(c)}
              >
                {running === c ? '运行中…' : `▶ ${c}`}
              </button>
            ))}
          </div>
          {running != null && (
            <div style={{ padding: '6px 0', textAlign: 'center' }}>
              <Spin size="small" />
            </div>
          )}
          {error != null && <div style={{ color: 'var(--pm-error)', padding: '4px 0', whiteSpace: 'pre-wrap' }}>{error}</div>}
          {result != null && (
            <div data-ws-verify-result style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 11,
                    padding: '0 6px',
                    borderRadius: 3,
                    color: ok ? 'var(--pm-success, #52c41a)' : 'var(--pm-error)',
                    background: ok ? 'rgba(82,196,26,0.12)' : 'rgba(255,77,79,0.12)',
                  }}
                >
                  {ok ? '通过' : '失败'} · exit {result.code ?? '—'}
                </span>
                {summary && <span style={{ fontSize: 11, color: 'var(--pm-text-muted)' }}>{summary.line}</span>}
                <button
                  type="button"
                  className="pm-ws-btn"
                  style={{ fontSize: 11, marginLeft: 'auto', color: 'var(--pm-text-quiet)' }}
                  onClick={() => setOutputOpen((v) => !v)}
                >
                  {outputOpen ? '收起输出' : '查看输出'}
                </button>
              </div>
              {failures.length > 0 && (
                <div data-ws-verify-failures style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {failures.map((f) => (
                    <button
                      key={f.line != null ? `${f.path}:${f.line}` : f.path}
                      type="button"
                      className="pm-ws-btn"
                      data-ws-verify-failure
                      title="在预览中打开"
                      style={{
                        fontSize: 11,
                        textAlign: 'left',
                        color: 'var(--pm-link)',
                        padding: '1px 0',
                        fontFamily: 'Menlo, Consolas, monospace',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      onClick={() => openInPreviewPane(f.path, f.line != null ? { mode: 'line', line: f.line } : undefined)}
                    >
                      {f.line != null ? `${f.path}:${f.line}` : f.path}
                    </button>
                  ))}
                </div>
              )}
              {outputOpen && (
                <pre
                  data-ws-verify-output
                  style={{
                    margin: 0,
                    maxHeight: 180,
                    overflow: 'auto',
                    fontSize: 11,
                    lineHeight: 1.5,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    background: 'var(--pm-bg-soft, rgba(0,0,0,0.04))',
                    borderRadius: 4,
                    padding: '6px 8px',
                  }}
                >
                  {result.output || '（无输出）'}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </Body>
  )
}
