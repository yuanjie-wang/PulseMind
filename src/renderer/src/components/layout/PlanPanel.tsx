import { useEffect, useRef, useState } from 'react'
import { theme } from 'antd'
import {
  CheckCircleFilled,
  CloseCircleFilled,
  RightCircleFilled,
  EllipsisOutlined,
  LeftOutlined,
  RightOutlined,
  AimOutlined
} from '@ant-design/icons'
import type { Plan } from '../../types/agent'

interface PlanPanelProps {
  plan: Plan | null
  onJumpToStep: (msgId: string) => void
}

export function PlanPanel({ plan, onJumpToStep }: PlanPanelProps) {
  const { token } = theme.useToken()
  const [collapsed, setCollapsed] = useState(false)
  const [currentPlan, setCurrentPlan] = useState<Plan | null>(null)
  const [visible, setVisible] = useState(false)
  const rafRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  // Track plan existence (not reference) to only animate on null↔non-null transitions
  const hadPlanRef = useRef(false)

  useEffect(() => {
    const hasPlan = plan !== null

    if (hasPlan && !hadPlanRef.current) {
      // Plan appeared (null → non-null): fade in
      hadPlanRef.current = true
      setCurrentPlan(plan)
      setVisible(false)
      // Cancel any previous animation from a prior cycle
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = undefined }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => {
          setVisible(true)
          rafRef.current = 0
        })
      })
    } else if (!hasPlan && hadPlanRef.current) {
      // Plan disappeared (non-null → null): fade out
      hadPlanRef.current = false
      setVisible(false)
      // Cancel any pending fade-in
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      timerRef.current = setTimeout(() => {
        setCurrentPlan(null)
        timerRef.current = undefined
      }, 280)
    } else if (hasPlan) {
      // Plan updated (still non-null): just update content, no animation
      // Don't cancel pending rAF — let the fade-in complete
      setCurrentPlan(plan)
    }
  }, [plan])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const displayPlan = plan || currentPlan
  if (!displayPlan) return null

  const toggleCollapsed = () => setCollapsed(c => !c)

  // ── Tab pill (visible in both expanded and collapsed states) ──
  const tabPill = (
    <div
      onClick={toggleCollapsed}
      style={{
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 24,
        minWidth: 24,
        height: 40,
        borderRadius: '6px 0 0 6px',
        background: token.colorBgElevated,
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        color: token.colorTextSecondary,
        fontSize: 12,
        transition: 'opacity 0.2s'
      }}
      title={collapsed ? '展开任务面板' : '收起任务面板'}
    >
      {collapsed ? <LeftOutlined style={{ fontSize: 12 }} /> : <RightOutlined style={{ fontSize: 12 }} />}
    </div>
  )

  const fadeStyle = {
    opacity: visible ? 1 : 0,
    transition: 'opacity 0.25s ease',
  }

  // ── Collapsed: just the tab pill ──
  if (collapsed) {
    return (
      <div style={{
        position: 'fixed',
        right: 0,
        top: '50%',
        transform: 'translateY(-50%)',
        zIndex: 100,
        backfaceVisibility: 'hidden',
        ...fadeStyle,
      }}>
        {tabPill}
      </div>
    )
  }

  const doneCount = displayPlan.steps.filter(s => s.status === 'completed' || s.status === 'failed').length

  const stepIcon = (step: typeof displayPlan.steps[0], idx: number) => {
    if (step.status === 'completed') return <CheckCircleFilled style={{ color: '#52c41a', fontSize: 14 }} />
    if (step.status === 'failed') return <CloseCircleFilled style={{ color: '#ff4d4f', fontSize: 14 }} />
    if (idx === displayPlan.currentStepIndex && !displayPlan.completed) return <RightCircleFilled style={{ color: token.colorText, fontSize: 14 }} />
    return <EllipsisOutlined style={{ color: token.colorTextQuaternary, fontSize: 14 }} />
  }

  // ── Expanded: panel + tab pill ──
  return (
    <div style={{
      position: 'fixed',
      right: 0,
      top: '50%',
      transform: 'translateY(-50%)',
      zIndex: 100,
      display: 'flex',
      alignItems: 'center',
      backfaceVisibility: 'hidden',
      ...fadeStyle,
    }}>
      {tabPill}
      {/* Panel content */}
      <div style={{
        width: 260,
        maxHeight: '60vh',
        background: token.colorBgElevated,
        borderRadius: '8px 0 0 8px',
        boxShadow: '4px 0 16px rgba(0,0,0,0.1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 12px 8px',
          borderBottom: `1px solid ${token.colorBorderSecondary}`
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: token.colorText }}>
            <AimOutlined style={{ color: token.colorPrimary }} />
            <span>任务进度</span>
            <span style={{ fontSize: 11, fontWeight: 400, color: token.colorTextSecondary }}>
              {doneCount}/{displayPlan.steps.length}
            </span>
          </div>
        </div>

        {/* Objective */}
        <div style={{
          padding: '8px 12px',
          fontSize: 12,
          color: token.colorTextSecondary,
          lineHeight: 1.5,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
          wordBreak: 'break-word'
        }}>
          {displayPlan.objective}
        </div>

        {/* Step list */}
        <div style={{
          flex: 1,
          overflow: 'auto',
          padding: '6px 0'
        }}>
          {displayPlan.steps.map((step, idx) => {
            const isCurrent = idx === displayPlan.currentStepIndex && !displayPlan.completed
            return (
              <div
                key={idx}
                onClick={() => {
                  if (step.msgId) onJumpToStep(step.msgId)
                }}
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: '7px 12px',
                  cursor: step.msgId ? 'pointer' : 'default',
                  background: isCurrent ? token.colorFillSecondary : 'transparent',
                  transition: 'background 0.15s',
                  borderLeft: isCurrent ? `3px solid ${token.colorTextSecondary}` : '3px solid transparent',
                }}
                onMouseEnter={e => { if (step.msgId) e.currentTarget.style.background = token.colorFillTertiary }}
                onMouseLeave={e => { e.currentTarget.style.background = isCurrent ? token.colorFillSecondary : 'transparent' }}
                title={step.msgId ? '跳转到此步骤' : undefined}
              >
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  {stepIcon(step, idx)}
                </div>
                <div style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 12,
                  lineHeight: 1.5,
                  color: step.status === 'pending' ? token.colorTextQuaternary : token.colorText
                }}>
                  {step.description}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
