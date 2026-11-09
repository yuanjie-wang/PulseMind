// 画布左侧的图标悬浮窗（user 2026-11-09：编辑工作流时把左侧工具箱整块撤掉，
// 画布吃满宽度——「添加环节 / 自动整理」收成一列只有图标的钮，垂直排列、
// 垂直居中贴住画布左缘）。简化模型（三期裁定）：开始/结束芯片常驻画布、
// 不可增删，所以这里只有这两件事可做。
//
// 缩放条（React Flow 的 <Controls>）里原先挂过一个「添加环节」钮，同一功能
// 两个入口既冗余又容易被当成缩放按钮——那个钮已撤，添加只此一处。

import React from 'react'
import { ApartmentOutlined, PlusOutlined } from '@ant-design/icons'
import { useTranslation } from '../../i18n/useTranslation'

export interface WorkflowCanvasDockProps {
  /** 加一个空白任务节点（落点 = 当前视口中心，ID/标题由画布铸）。 */
  onAddNode: () => void
  /** 自动整理布局（全量重排，忽略已有坐标）。 */
  onTidy: () => void
}

export function WorkflowCanvasDock({ onAddNode, onTidy }: WorkflowCanvasDockProps): React.ReactElement {
  const { t } = useTranslation()
  const actions = [
    { key: 'add', icon: <PlusOutlined />, label: t('workflow.canvasAddNode'), onClick: onAddNode },
    { key: 'tidy', icon: <ApartmentOutlined />, label: t('workflow.canvasTidy'), onClick: onTidy },
  ]
  return (
    <div className="wf-canvas-dock" data-canvas-dock="workflow" role="toolbar" aria-orientation="vertical">
      {actions.map((a) => (
        <button
          key={a.key}
          type="button"
          className="wf-dock-btn"
          data-dock-action={a.key}
          onClick={a.onClick}
          title={a.label}
          aria-label={a.label}
        >
          {a.icon}
        </button>
      ))}
    </div>
  )
}
