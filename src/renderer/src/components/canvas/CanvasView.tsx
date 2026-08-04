import React, { useRef, useCallback, useEffect, useState } from 'react'
import { useCanvasStore } from '../../stores/canvasStore'
import type { Annotation, Point, ToolType, BoundingBox } from '../../types/canvas'
import { generateId } from '../../types/canvas'
import ZoomControls from './ZoomControls'
import RectFrame from './RectFrame'
import AnnotationNotePopup from './AnnotationNotePopup'
import LeftAnnotationToolbar from './LeftAnnotationToolbar'
import RegionConfig from './RegionConfig'
import { snapMove, snapResize } from '../../utils/snap'
import { drawAnnotation } from '../../utils/canvasDrawUtils'
import { createCanvasEngine, buildUserPrompt, type CanvasEngineHandle } from './canvasEngine'
import type { SubAgentProfile } from '../../../../shared/types/subagent'
import { useSettings } from '../../hooks/SettingsContext'

// ── Constants ──

const GRID_SIZE = 24
const MIN_ZOOM = 0.1
const MAX_ZOOM = 5

// ── Coordinate helpers ──

function screenToDoc(
  sx: number, sy: number,
  panX: number, panY: number, zoom: number,
): Point {
  return { x: (sx - panX) / zoom, y: (sy - panY) / zoom }
}

// ── Helpers ──

function findParentRect(ann: Annotation, all: Annotation[]): string | undefined {
  if (ann.type === 'rect') return undefined
  const rects = all.filter(a => a.type === 'rect' && a.boundingBox && a.id !== ann.id)
  let hitX: number, hitY: number
  if (ann.boundingBox) {
    hitX = ann.boundingBox.x + ann.boundingBox.width / 2
    hitY = ann.boundingBox.y + ann.boundingBox.height / 2
  } else if (ann.points.length > 0) {
    hitX = ann.points.reduce((s, p) => s + p.x, 0) / ann.points.length
    hitY = ann.points.reduce((s, p) => s + p.y, 0) / ann.points.length
  } else {
    return undefined
  }
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i].boundingBox!
    if (hitX >= r.x && hitX <= r.x + r.width && hitY >= r.y && hitY <= r.y + r.height) {
      return rects[i].id
    }
  }
  return undefined
}

function isInsideAnyRect(docPos: Point, annotations: Annotation[]): boolean {
  const rects = annotations.filter(a => a.type === 'rect' && a.boundingBox)
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i].boundingBox!
    if (docPos.x >= r.x && docPos.x <= r.x + r.width && docPos.y >= r.y && docPos.y <= r.y + r.height) {
      return true
    }
  }
  return false
}

function clampToRect(docPos: Point, annotations: Annotation[], tool: ToolType): Point {
  if (tool === 'pan' || tool === 'cursor' || tool === 'rect') return docPos
  const rects = annotations.filter(a => a.type === 'rect' && a.boundingBox)
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i].boundingBox!
    if (docPos.x >= r.x && docPos.x <= r.x + r.width && docPos.y >= r.y && docPos.y <= r.y + r.height) {
      return {
        x: Math.max(r.x, Math.min(r.x + r.width, docPos.x)),
        y: Math.max(r.y, Math.min(r.y + r.height, docPos.y)),
      }
    }
  }
  return docPos
}

function parseEdge(edge: string) {
  return {
    left: edge.includes('w'),
    right: edge.includes('e'),
    top: edge.includes('n'),
    bottom: edge.includes('s'),
  }
}

function getRectAtPoint(docPos: Point, annotations: Annotation[]): Annotation | undefined {
  const rects = annotations.filter(a => a.type === 'rect' && a.boundingBox)
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i].boundingBox!
    if (docPos.x >= r.x && docPos.x <= r.x + r.width && docPos.y >= r.y && docPos.y <= r.y + r.height) {
      return rects[i]
    }
  }
  return undefined
}

// ── CanvasView Component ──

export default function CanvasView() {
  const {
    annotations, selectedRectId, zoom, panX, panY,
    generatingAnnotationIds,
    addAnnotation, removeAnnotation, setAnnotationCode, updateAnnotationBounds,
    updateAnnotationText,
    setSelectedRectId, addGeneratingAnnotationId, removeGeneratingAnnotationId,
    addRevisionEntry, setZoom, setPan, persistCanvas, loadCanvas,
  } = useCanvasStore()

  // ── Persistence: load on mount, auto-save on changes ──
  useEffect(() => { loadCanvas() }, [loadCanvas])
  useEffect(() => { persistCanvas() }, [annotations, panX, panY, persistCanvas])

  // Center view on first visit (reads store state AFTER loadCanvas via getState)
  useEffect(() => {
    const { panX, panY, setPan } = useCanvasStore.getState()
    if (panX === 0 && panY === 0) {
      requestAnimationFrame(() => {
        const rect = containerRef.current?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          setPan(rect.width / 2, rect.height / 2)
        }
      })
    }
  }, [])

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const currentTool = useCanvasStore(s => s.currentTool)
  const setCurrentTool = useCanvasStore(s => s.setCurrentTool)
  const currentColor = useCanvasStore(s => s.currentColor)
  const setCurrentColor = useCanvasStore(s => s.setCurrentColor)
  const [isPanning, setIsPanning] = useState(false)
  const [isDrawing, setIsDrawing] = useState(false)
  const startPointRef = useRef<Point | null>(null)
  const lastPanRef = useRef<Point>({ x: 0, y: 0 })
  const currentPathRef = useRef<Point[]>([])
  const dragRef = useRef<{ rectId: string; startScreen: Point; startBounds: BoundingBox; currentBounds: BoundingBox } | null>(null)
  const resizeRef = useRef<{ rectId: string; edge: string; startScreen: Point; startBounds: BoundingBox; startSize: { w: number; h: number } } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const usingDocListenersRef = useRef(false)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const resizeCleanupRef = useRef<(() => void) | null>(null)
  // Ref-based redraw bypasses React scheduling for 60fps during drag/resize/pan
  const redrawRef = useRef<() => void>(() => {})
  const [snapLines, setSnapLines] = useState<Array<{ orientation: 'v' | 'h'; pos: number }>>([])
  const [textInputPos, setTextInputPos] = useState<Point | null>(null)
  const [textInputValue, setTextInputValue] = useState('')
  const textInputRef = useRef<HTMLInputElement>(null)
  const [generationError, setGenerationError] = useState<Record<string, string>>({})
  const [toolEvents, setToolEvents] = useState<Record<string, Array<{ toolName: string; args: string; status: 'running' | 'done'; summary?: string }>>>({})
  const [pendingNote, setPendingNote] = useState<{ x: number; y: number; annotationId: string } | null>(null)
  const [isCtrlHeld, setIsCtrlHeld] = useState(false)
  const { activeProfile } = useSettings()
  const canvasEngineMapRef = useRef<Map<string, CanvasEngineHandle>>(new Map())

  // Background deselect — deselect rect when clicking outside canvas
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Don't deselect when clicking on toolbar/popup elements
      if (target.closest('[data-rect-control="true"]')) return
      if (containerRef.current && !containerRef.current.contains(target)) {
        useCanvasStore.getState().setSelectedRectId(null)
      }
    }
    document.addEventListener('mousedown', handler, true)
    return () => document.removeEventListener('mousedown', handler, true)
  }, [])

  // Clean up engines when annotations are cleared (from toolbar or store reset)
  useEffect(() => {
    const unsub = useCanvasStore.subscribe((state) => {
      if (state.annotations.length === 0 && canvasEngineMapRef.current.size > 0) {
        for (const [, handle] of canvasEngineMapRef.current) {
          handle.cancel()
        }
        canvasEngineMapRef.current.clear()
      }
    })
    return unsub
  }, [])

  // Track Ctrl/Meta key for iframe-agnostic zoom
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') setIsCtrlHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Control' || e.key === 'Meta') setIsCtrlHeld(false)
    }
    document.addEventListener('keydown', down)
    document.addEventListener('keyup', up)
    return () => {
      document.removeEventListener('keydown', down)
      document.removeEventListener('keyup', up)
    }
  }, [])

  // Canvas tool events now come from local engine (not IPC)

  // ── Redraw annotations on canvas ──

  const redraw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const dpr = window.devicePixelRatio || 1
    const w = parent.clientWidth
    const h = parent.clientHeight
    // Only resize if dimensions changed (avoids GPU compositor churn)
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Reset transform with DPR scale so all drawing uses CSS-pixel coords
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // Draw parentless annotations only (child annotations are drawn per-rect in RectFrame)
    ctx.save()
    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)
    const toDraw = annotations.filter(a => a.type !== 'rect' && !a.parentId)
    for (const ann of toDraw) {
      drawAnnotation(ctx, ann, undefined, zoom)
    }
    ctx.restore()
  }, [annotations, zoom, panX, panY])
  // Keep ref in sync for imperative redraws that bypass React (pan/drag during drag/resize)
  redrawRef.current = redraw

  // Redraw when annotations/zoom/pan change or container resizes
  useEffect(() => {
    redraw()
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => { redraw() })
    observer.observe(container)
    return () => observer.disconnect()
  }, [redraw])

  // ── Wheel handler: pan (trackpad) / zoom (ctrl+scroll) ──
  // Window capture phase catches events before iframes consume them.
  // passive:false ensures preventDefault works (no Chrome warning).

  const zoomPanRef = useRef({ zoom, panX, panY })
  zoomPanRef.current = { zoom, panX, panY }

  useEffect(() => {
    const handler = (e: WheelEvent) => {
      // Only handle wheel events from within the canvas container or its iframes.
      // Wheel events from iframes surface with the <iframe> element as target in the
      // host document, so contains() correctly matches them. Events from overlays
      // (drawers, modals, tooltips) are outside the container and are ignored.
      if (!containerRef.current?.contains(e.target as Node)) return

      // Not checking currentTool here: iframes handle themselves via pointerEvents
      // (auto for cursor → rect content scrolls, none for others → canvas pans).
      e.preventDefault()
      const { zoom: z, panX: px, panY: py } = zoomPanRef.current
      if (e.ctrlKey || e.metaKey) {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        const factor = e.deltaY < 0 ? 1.12 : 0.88
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor))
        const docX = (mx - px) / z
        const docY = (my - py) / z
        setZoom(newZoom)
        setPan(mx - docX * newZoom, my - docY * newZoom)
      } else {
        setPan(px - e.deltaX, py - e.deltaY)
      }
    }
    window.addEventListener('wheel', handler, { passive: false, capture: true })
    return () => window.removeEventListener('wheel', handler, { capture: true })
  }, [setZoom, setPan])

  // ── Mouse handlers ──

  const getCanvasPos = useCallback((e: React.MouseEvent): Point => {
    const container = containerRef.current
    if (!container) return { x: 0, y: 0 }
    const rect = container.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }, [])

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Skip if clicking on toolbar/panel elements (data-rect-control)
    const target = e.target as HTMLElement
    if (target.closest('[data-rect-control="true"]')) return

    const pos = getCanvasPos(e)
    const docPos = screenToDoc(pos.x, pos.y, panX, panY, zoom)

    if (currentTool === 'pan') {
      setIsPanning(true)
      lastPanRef.current = { x: pos.x, y: pos.y }
      return
    }

    if (currentTool === 'cursor') {
      // Try to select a rect
      const hitRect = getRectAtPoint(docPos, annotations)
      if (hitRect) {
        setSelectedRectId(hitRect.id)
      } else {
        setSelectedRectId(null)
      }
      return
    }

    if (currentTool === 'text') {
      if (!isInsideAnyRect(docPos, annotations)) {
        setSelectedRectId(null)
        setCurrentTool('cursor')
        return
      }
      setTextInputPos(docPos)
      setTextInputValue('')
      return
    }

    // Drawing tools — auto-switch to cursor when outside rects
    if (currentTool !== 'rect' && !isInsideAnyRect(docPos, annotations)) {
      setSelectedRectId(null)
      setCurrentTool('cursor')
      return
    }

    setIsDrawing(true)
    startPointRef.current = docPos
    currentPathRef.current = [docPos]
  }, [currentTool, zoom, panX, panY, getCanvasPos, annotations, setSelectedRectId])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    // Drag/resize handled by document listeners — skip React handler to avoid double processing
    if (usingDocListenersRef.current) return

    const pos = getCanvasPos(e)

    // ── Drag (move) rect ──
    if (dragRef.current) {
      const dx = (pos.x - dragRef.current.startScreen.x) / zoom
      const dy = (pos.y - dragRef.current.startScreen.y) / zoom
      const newBounds = {
        x: dragRef.current.startBounds.x + dx,
        y: dragRef.current.startBounds.y + dy,
        width: dragRef.current.startBounds.width,
        height: dragRef.current.startBounds.height,
      }
      const all = useCanvasStore.getState().annotations
      const others = all
        .filter(a => a.type === 'rect' && a.boundingBox && a.id !== dragRef.current!.rectId)
        .map(a => a.boundingBox!)
      const result = snapMove(newBounds, others)
      updateAnnotationBounds(dragRef.current.rectId, result.bounds)
      setSnapLines(result.lines)
      return
    }

    // ── Resize rect ──
    if (resizeRef.current) {
      const dx = (pos.x - resizeRef.current.startScreen.x) / zoom
      const dy = (pos.y - resizeRef.current.startScreen.y) / zoom
      const sb = resizeRef.current.startBounds
      let newBounds = { ...sb }
      const edge = resizeRef.current.edge
      const dir = parseEdge(edge)

      if (dir.left) {
        newBounds.x = sb.x + dx
        newBounds.width = sb.width - dx
      }
      if (dir.right) {
        newBounds.width = sb.width + dx
      }
      if (dir.top) {
        newBounds.y = sb.y + dy
        newBounds.height = sb.height - dy
      }
      if (dir.bottom) {
        newBounds.height = sb.height + dy
      }

      // Enforce minimum size
      const minSize = 20
      if (newBounds.width < minSize) {
        if (dir.left) newBounds.x = newBounds.x + newBounds.width - minSize
        newBounds.width = minSize
      }
      if (newBounds.height < minSize) {
        if (dir.top) newBounds.y = newBounds.y + newBounds.height - minSize
        newBounds.height = minSize
      }

      const all = useCanvasStore.getState().annotations
      const others = all
        .filter(a => a.type === 'rect' && a.boundingBox && a.id !== resizeRef.current!.rectId)
        .map(a => a.boundingBox!)
      const snapEdges: ('left'|'right'|'top'|'bottom')[] = []
      if (dir.left) snapEdges.push('left')
      if (dir.right) snapEdges.push('right')
      if (dir.top) snapEdges.push('top')
      if (dir.bottom) snapEdges.push('bottom')
      const result = snapResize(newBounds, snapEdges, others)
      let finalBounds = result.bounds
      // Clamp minimum after snap
      if (finalBounds.width < minSize) {
        if (dir.left) finalBounds.x = finalBounds.x + finalBounds.width - minSize
        finalBounds.width = minSize
      }
      if (finalBounds.height < minSize) {
        if (dir.top) finalBounds.y = finalBounds.y + finalBounds.height - minSize
        finalBounds.height = minSize
      }
      updateAnnotationBounds(resizeRef.current.rectId, finalBounds)
      setSnapLines(result.lines)
      return
    }

    if (isPanning) {
      const dx = pos.x - lastPanRef.current.x
      const dy = pos.y - lastPanRef.current.y
      setPan(panX + dx, panY + dy)
      lastPanRef.current = { x: pos.x, y: pos.y }
      return
    }

    if (!isDrawing) return

    const docPos = screenToDoc(pos.x, pos.y, panX, panY, zoom)
    const clamped = clampToRect(docPos, annotations, currentTool)
    currentPathRef.current.push(clamped)

    // Draw preview on overlay canvas (zIndex above RectFrames)
    const canvas = previewCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    const parent = canvas.parentElement
    if (parent) {
      const pw = parent.clientWidth
      const ph = parent.clientHeight
      if (canvas.width !== pw * dpr || canvas.height !== ph * dpr) {
        canvas.width = pw * dpr
        canvas.height = ph * dpr
        canvas.style.width = pw + 'px'
        canvas.style.height = ph + 'px'
      }
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)

    // Draw current stroke preview
    ctx.save()
    ctx.translate(panX, panY)
    ctx.scale(zoom, zoom)
    const start = startPointRef.current!
    ctx.strokeStyle = currentColor
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    switch (currentTool) {
      case 'highlight': {
        ctx.globalAlpha = currentTool === 'highlight' ? 0.3 : 1
        ctx.lineWidth = currentTool === 'highlight' ? 16 : 2
        ctx.beginPath()
        const pts = currentPathRef.current
        ctx.moveTo(pts[0].x, pts[0].y)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y)
        ctx.stroke()
        break
      }
      case 'rect': {
        const rw = clamped.x - start.x
        const rh = clamped.y - start.y
        const drawX = Math.min(start.x, clamped.x)
        const drawY = Math.min(start.y, clamped.y)
        const drawW = Math.abs(rw)
        const drawH = Math.abs(rh)
        if (drawW >= 3 && drawH >= 3) {
          ctx.strokeStyle = '#4f8cff'
          ctx.strokeRect(drawX, drawY, drawW, drawH)
          const label = `${Math.round(drawW)} × ${Math.round(drawH)}`
          ctx.fillStyle = '#4f8cff'
          ctx.font = 'bold 12px sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'bottom'
          ctx.fillText(label, drawX + drawW / 2, drawY - 4)
        }
        break
      }
      case 'arrow': {
        ctx.beginPath()
        ctx.moveTo(start.x, start.y)
        ctx.lineTo(clamped.x, clamped.y)
        ctx.stroke()
        const angle = Math.atan2(clamped.y - start.y, clamped.x - start.x)
        ctx.beginPath()
        ctx.moveTo(clamped.x, clamped.y)
        ctx.lineTo(clamped.x - 12 * Math.cos(angle - 0.4), clamped.y - 12 * Math.sin(angle - 0.4))
        ctx.moveTo(clamped.x, clamped.y)
        ctx.lineTo(clamped.x - 12 * Math.cos(angle + 0.4), clamped.y - 12 * Math.sin(angle + 0.4))
        ctx.stroke()
        break
      }
      case 'rectangle':
      case 'ellipse': {
        const rw2 = clamped.x - start.x
        const rh2 = clamped.y - start.y
        const dx = Math.min(start.x, clamped.x)
        const dy = Math.min(start.y, clamped.y)
        const dw = Math.abs(rw2)
        const dh = Math.abs(rh2)
        if (currentTool === 'rectangle') {
          ctx.strokeRect(dx, dy, dw, dh)
        } else {
          ctx.beginPath()
          ctx.ellipse(dx + dw / 2, dy + dh / 2, dw / 2, dh / 2, 0, 0, Math.PI * 2)
          ctx.stroke()
        }
        break
      }
    }
    ctx.restore()
  }, [isPanning, isDrawing, currentTool, currentColor, zoom, panX, panY, getCanvasPos, annotations, setPan, updateAnnotationBounds, setSnapLines])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    // ── End drag/resize ──
    if (dragRef.current || resizeRef.current) {
      dragRef.current = null
      resizeRef.current = null
      setSnapLines([])
      return
    }

    if (isPanning) {
      setIsPanning(false)
      return
    }

    if (!isDrawing) return
    setIsDrawing(false)

    const pos = getCanvasPos(e)
    const docPos = screenToDoc(pos.x, pos.y, panX, panY, zoom)
    const docStart = startPointRef.current!
    const docPath = currentPathRef.current

    // Check accidental click
    const isAccidental = (() => {
      switch (currentTool) {
        case 'highlight':
          return docPath.length < 2
        case 'rect':
        case 'rectangle':
        case 'ellipse':
          return Math.abs(docPos.x - docStart.x) < 3 && Math.abs(docPos.y - docStart.y) < 3
        case 'arrow':
          return Math.hypot(docPos.x - docStart.x, docPos.y - docStart.y) < 5
        default:
          return false
      }
    })()

    if (isAccidental) {
      currentPathRef.current = []
      startPointRef.current = null
      // Clear preview canvas
      const pc = previewCanvasRef.current
      if (pc) { const pctx = pc.getContext('2d'); if (pctx) { pctx.setTransform(1,0,0,1,0,0); pctx.clearRect(0,0,pc.width,pc.height) } }
      redraw()
      return
    }

    let annotation: Annotation

    switch (currentTool) {
      case 'highlight':
        annotation = { id: generateId(), type: currentTool, points: docPath, color: currentColor, createdAt: Date.now() }
        break
      case 'rect': {
        const rawW = Math.abs(docPos.x - docStart.x)
        const rawH = Math.abs(docPos.y - docStart.y)
        // Snap to existing rect dimensions (6px threshold)
        let snappedW = Math.max(100, rawW)
        let snappedH = Math.max(100, rawH)
        const existingRects = annotations.filter(a => a.type === 'rect' && a.boundingBox)
        for (const r of existingRects) {
          if (!r.boundingBox) continue
          if (Math.abs(snappedW - r.boundingBox.width) <= 6) snappedW = r.boundingBox.width
          if (Math.abs(snappedH - r.boundingBox.height) <= 6) snappedH = r.boundingBox.height
        }
        annotation = {
          id: generateId(), type: 'rect', points: [docStart, docPos],
          boundingBox: { x: Math.min(docStart.x, docPos.x), y: Math.min(docStart.y, docPos.y), width: snappedW, height: snappedH },
          color: '#4f8cff', createdAt: Date.now(),
        }
        break
      }
      case 'arrow':
        annotation = { id: generateId(), type: 'arrow', points: [docStart, docPos], color: currentColor, createdAt: Date.now() }
        break
      case 'rectangle':
      case 'ellipse': {
        const rawW = Math.abs(docPos.x - docStart.x)
        const rawH = Math.abs(docPos.y - docStart.y)
        annotation = {
          id: generateId(), type: currentTool, points: [docStart, docPos],
          boundingBox: { x: Math.min(docStart.x, docPos.x), y: Math.min(docStart.y, docPos.y), width: rawW, height: rawH },
          color: currentColor, createdAt: Date.now(),
        }
        break
      }
      default:
        currentPathRef.current = []
        startPointRef.current = null
        { const pc = previewCanvasRef.current; if (pc) { const pctx = pc.getContext('2d'); if (pctx) { pctx.setTransform(1,0,0,1,0,0); pctx.clearRect(0,0,pc.width,pc.height) } } }
        redraw()
        return
    }

    // Auto-assign parent
    const parentId = findParentRect(annotation, annotations)
    if (parentId) annotation.parentId = parentId

    addAnnotation(annotation)
    currentPathRef.current = []
    startPointRef.current = null
    // Clear preview canvas
    const pc = previewCanvasRef.current
    if (pc) { const pctx = pc.getContext('2d'); if (pctx) { pctx.setTransform(1,0,0,1,0,0); pctx.clearRect(0,0,pc.width,pc.height) } }
    redraw()

    // Auto-select new rect + switch to cursor (PageSprite behavior)
    if (annotation.type === 'rect') {
      setSelectedRectId(annotation.id)
      setCurrentTool('cursor')
    } else {
      // Show annotation note popup for drawing tools
      const POPUP_H = 130
      let noteX: number, noteY: number
      if (annotation.boundingBox) {
        const screenX = annotation.boundingBox.x * zoom + panX
        const screenY = annotation.boundingBox.y * zoom + panY
        noteX = screenX + annotation.boundingBox.width * zoom / 2 - 100
        const below = screenY + annotation.boundingBox.height * zoom + 10
        const above = screenY - POPUP_H - 5
        noteY = (below + POPUP_H > window.innerHeight && above > 0) ? above : below
      } else if (annotation.points.length > 0) {
        const last = annotation.points[annotation.points.length - 1]
        const sx = last.x * zoom + panX
        const sy = last.y * zoom + panY
        noteX = sx + 10
        const below = sy + 10
        const first = annotation.points[0]
        const above = first.y * zoom + panY - POPUP_H - 5
        noteY = (below + POPUP_H > window.innerHeight && above > 0) ? above : below
      } else {
        noteX = 20
        noteY = 20
      }
      setPendingNote({
        annotationId: annotation.id,
        x: Math.max(0, noteX),
        y: Math.max(0, noteY),
      })
    }
  }, [isPanning, isDrawing, currentTool, currentColor, zoom, panX, panY, getCanvasPos, annotations, addAnnotation, setSelectedRectId, redraw, setSnapLines, setCurrentTool])

  // ── AI generation via local AgentEngine ──

  const handleGenerate = useCallback(async (id: string, prompt: string, contentType: string) => {
    setSelectedRectId(id)
    addGeneratingAnnotationId(id)
    addRevisionEntry(id, prompt)
    setGenerationError((prev) => { const { [id]: _, ...rest } = prev; return rest })

    // Yield to React to process state update and let Grainient WebGL overlay render/animate
    await new Promise((r) => setTimeout(r, 0))

    // Gather dimensions and child annotations for prompt context
    const store = useCanvasStore.getState()
    const ann = store.annotations.find(a => a.id === id)

    // Save prompt as annotation title on first generation
    if (ann && !ann.generatedCode) updateAnnotationText(id, prompt)
    const bb = ann?.boundingBox
    const childAnnotations = store.annotations.filter(a => a.parentId === id)
    let annotationsText = ''
    if (childAnnotations.length > 0) {
      annotationsText = childAnnotations.map((ca) => {
        let posStr = ''
        if (ca.boundingBox) {
          const bx = Math.round(ca.boundingBox.x - (bb?.x || 0))
          const by = Math.round(ca.boundingBox.y - (bb?.y || 0))
          const bw = Math.round(ca.boundingBox.width)
          const bh = Math.round(ca.boundingBox.height)
          posStr = ` bbox=(${bx},${by})-(${bx+bw},${by+bh})`
        } else if (ca.points.length >= 2) {
          const p0 = ca.points[0]
          const p1 = ca.points[ca.points.length - 1]
          const x0 = Math.round(p0.x - (bb?.x || 0))
          const y0 = Math.round(p0.y - (bb?.y || 0))
          const x1 = Math.round(p1.x - (bb?.x || 0))
          const y1 = Math.round(p1.y - (bb?.y || 0))
          posStr = ` range=(${x0},${y0})-(${x1},${y1})`
        } else if (ca.points.length > 0) {
          const p = ca.points[0]
          posStr = ` @(${Math.round(p.x - (bb?.x || 0))}, ${Math.round(p.y - (bb?.y || 0))})`
        }
        const color = ca.color ? `, color=${ca.color}` : ''
        const text = ca.text ? `, note="${ca.text}"` : ''
        return `  ${ca.type}${posStr}${color}${text}`
      }).join('\n')
    }

    // Match annotation positions to iframe elements for precise context
    if (ann?.generatedCode && childAnnotations.length > 0 && bb) {
      const iframe = document.querySelector(`iframe[title="${id}"]`) as HTMLIFrameElement | null
      const iframeWin = iframe?.contentWindow
      if (iframeWin) {
        try {
          const elementMapJson = iframeWin.eval(`(() => {
const results = {};
const all = document.body.querySelectorAll('*');
all.forEach(el => {
  if (el.id) {
    const r = el.getBoundingClientRect();
    results[el.id] = [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)];
  }
});
return JSON.stringify(results);
})()`)
          if (elementMapJson) {
            const elementMap = JSON.parse(elementMapJson) as Record<string, [number, number, number, number]>
            // For each annotation, find which elements overlap with its region
            const matchedGroups: string[] = []
            for (const ca of childAnnotations) {
              let ax: number, ay: number, aw: number, ah: number
              if (ca.boundingBox) {
                ax = ca.boundingBox.x - bb.x
                ay = ca.boundingBox.y - bb.y
                aw = ca.boundingBox.width
                ah = ca.boundingBox.height
              } else if (ca.type === 'arrow' && ca.points.length >= 2) {
                // Only the arrow head (last point) matters — ignore the tail
                const tip = ca.points[ca.points.length - 1]
                ax = tip.x - bb.x - 30
                ay = tip.y - bb.y - 30
                aw = 60
                ah = 60
              } else if ((ca.type === 'pen' || ca.type === 'highlight') && ca.points.length > 0) {
                const xs = ca.points.map(p => p.x - bb.x)
                const ys = ca.points.map(p => p.y - bb.y)
                ax = Math.min(...xs)
                ay = Math.min(...ys)
                aw = Math.max(...xs) - ax
                ah = Math.max(...ys) - ay
              } else if (ca.points.length > 0) {
                const p = ca.points[0]
                ax = p.x - bb.x - 5
                ay = p.y - bb.y - 5
                aw = 10
                ah = 10
              } else continue

              if (aw < 3 || ah < 3) continue

              const annLeft = ax; const annRight = ax + aw; const annTop = ay; const annBottom = ay + ah
              const matchedEls: Array<{ id: string; rect: [number, number, number, number] }> = []
              for (const [elId, coords] of Object.entries(elementMap)) {
                const [elLeft, elTop, elRight, elBottom] = coords
                if (elLeft < annRight && elRight > annLeft && elTop < annBottom && elBottom > annTop) {
                  matchedEls.push({ id: elId, rect: coords })
                }
              }
              if (matchedEls.length > 0) {
                // Sort: most specific (smallest area) first — helps LLM identify the intended target
                matchedEls.sort((a, b) => {
                  const areaA = (a.rect[2] - a.rect[0]) * (a.rect[3] - a.rect[1])
                  const areaB = (b.rect[2] - b.rect[0]) * (b.rect[3] - b.rect[1])
                  return areaA - areaB
                })
                let annInfo = `  Annotation ${ca.type}`
                if (ca.boundingBox) {
                  const bx = Math.round(ca.boundingBox.x - bb.x)
                  const by = Math.round(ca.boundingBox.y - bb.y)
                  const bw = Math.round(ca.boundingBox.width)
                  const bh = Math.round(ca.boundingBox.height)
                  annInfo += ` bbox=(${bx},${by})-(${bx+bw},${by+bh})`
                }
                const note = ca.text ? ` note="${ca.text}"` : ''
                const elLines = matchedEls.map(e => `    <${e.id}> rect=(${e.rect[0]},${e.rect[1]})-(${e.rect[2]},${e.rect[3]})`)
                matchedGroups.push(annInfo + note + ':\n' + elLines.join('\n'))
              }
            }
            if (matchedGroups.length > 0) {
              annotationsText += '\n\nElements at annotation positions:\n' + matchedGroups.join('\n')
            }
          }
        } catch (err) {
          console.warn('[canvas] Failed to collect element coordinates:', err)
        }
      }
    }

    try {
      // Get workDir from main process (fresh per generation)
      // Build user prompt
      const userPrompt = buildUserPrompt({
        prompt,
        annotations: annotationsText || undefined,
        existingCode: ann?.generatedCode || undefined,
        contentType: contentType === 'free' ? 'web' : contentType,
        width: bb ? Math.round(bb.width) : undefined,
        height: bb ? Math.round(bb.height) : undefined,
      })

      // Reuse engine across generations — create once, start() repeatedly
      let handle = canvasEngineMapRef.current.get(id)
      if (!handle) {
        // First generation for this rect: create workDir + engine
        const workDir = await window.electronAPI.canvasPrepareWorkDir(id, ann?.generatedCode, false) as string

        // Check subagent-canvas profile for a referenced LLM profile
        const subProfiles = await window.electronAPI.subagentList()
        const canvasSub = subProfiles.find((p: SubAgentProfile) => p.id === 'subagent-canvas')
        const linkedProfile = canvasSub?.profileId
          ? (await window.electronAPI.getSettings()).profiles.find(p => p.id === canvasSub.profileId)
          : undefined

        // Fetch data paths and platform info
        const [dataPaths, platformInfo] = await Promise.all([
          window.electronAPI.getDataPaths(),
          window.electronAPI.getPlatformInfo(),
        ])

        handle = createCanvasEngine({
          provider: linkedProfile?.provider || activeProfile?.provider,
          apiKey: linkedProfile?.apiKey || (activeProfile?.apiKey ?? ''),
          baseURL: linkedProfile?.baseURL || (activeProfile?.baseURL ?? ''),
          model: linkedProfile?.model || (activeProfile?.model ?? ''),
          maxTokens: linkedProfile?.maxTokens || (activeProfile?.maxTokens ?? 8192),
          workDir,
          rectId: id,
          platformInfo,
          skillsDir: dataPaths.skillsDir,
        }, {
          width: bb ? Math.round(bb.width) : undefined,
          height: bb ? Math.round(bb.height) : undefined,
          contentType: contentType === 'free' ? 'web' : contentType,
        })

        // Wire tool events to React state
        handle.onToolEvent((event) => {
          setToolEvents((prev) => {
            const list = prev[id] || []
            if (event.status === 'done') {
              const idx = list.findIndex(
                (e) => e.toolName === event.toolName && e.args === event.args && e.status === 'running'
              )
              if (idx >= 0) {
                const next = [...list]
                next[idx] = { ...next[idx], status: 'done', summary: event.summary }
                return { ...prev, [id]: next }
              }
            }
            return { ...prev, [id]: [...list, event] }
          })
        })

        canvasEngineMapRef.current.set(id, handle)
      }

      const html = await handle.start(userPrompt)
      setAnnotationCode(id, html)
      // Delete all previous round annotations after successful generation
      const s = useCanvasStore.getState()
      for (const a of s.annotations) {
        if (a.parentId === id) s.removeAnnotation(a.id)
      }
    } catch (err: any) {
      if (err?.message === 'cancelled') return
      const msg = err?.message || '未知错误'
      console.error('[canvas] generation failed:', err)
      setGenerationError((prev) => ({ ...prev, [id]: msg }))
    } finally {
      removeGeneratingAnnotationId(id)
      setToolEvents((prev) => { const { [id]: _, ...rest } = prev; return rest })
    }
  }, [setSelectedRectId, addGeneratingAnnotationId, addRevisionEntry, setAnnotationCode, removeGeneratingAnnotationId, updateAnnotationText, activeProfile])

  // ── Cancel generation ──

  const handleCancelGenerate = useCallback((id: string) => {
    canvasEngineMapRef.current.get(id)?.cancel()
    canvasEngineMapRef.current.delete(id)
    removeGeneratingAnnotationId(id)
    setGenerationError((prev) => { const { [id]: _, ...rest } = prev; return rest })
  }, [removeGeneratingAnnotationId])

  // ── Annotation note popup ──

  const handleNoteSubmit = useCallback((text: string) => {
    if (!pendingNote) return
    if (text.trim()) {
      useCanvasStore.getState().updateAnnotationText(pendingNote.annotationId, text.trim())
    }
    setPendingNote(null)
  }, [pendingNote])

  const handleNoteCancel = useCallback(() => {
    if (pendingNote) {
      useCanvasStore.getState().removeAnnotation(pendingNote.annotationId)
    }
    setPendingNote(null)
  }, [pendingNote])

  // ── Prepare work dir when rect is created ──

  useEffect(() => {
    const rects = annotations.filter(a => a.type === 'rect')
    for (const r of rects) {
      window.electronAPI.canvasPrepareWorkDir(r.id, r.generatedCode).catch(() => {})
    }
  }, [annotations])

  // ── Zoom controls ──

  const handleZoomIn = useCallback(() => {
    const newZoom = Math.min(MAX_ZOOM, zoom * 1.2)
    setZoom(newZoom)
  }, [zoom, setZoom])

  const handleZoomOut = useCallback(() => {
    const newZoom = Math.max(MIN_ZOOM, zoom * 0.8)
    setZoom(newZoom)
  }, [zoom, setZoom])

  const handleZoomReset = useCallback(() => {
    const container = containerRef.current?.getBoundingClientRect()
    if (container) {
      const cx = container.width / 2
      const cy = container.height / 2
      // Keep the current screen center point fixed after zoom reset
      setPan(cx - (cx - panX) / zoom, cy - (cy - panY) / zoom)
    }
    setZoom(1)
  }, [zoom, panX, setZoom, setPan])

  const handleCenterView = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (rect) {
      setPan(rect.width / 2, rect.height / 2)
    }
  }, [setPan])

  // ── Tool change with auto-pan fallback ──

  // ── Text annotation input ──

  const handleTextSubmit = useCallback(() => {
    if (!textInputPos || !textInputValue.trim()) {
      setTextInputPos(null)
      return
    }
    const textAnn: Annotation = {
      id: generateId(),
      type: 'text',
      points: [textInputPos],
      color: currentColor,
      text: textInputValue.trim(),
      createdAt: Date.now(),
    }
    const parentId = findParentRect(textAnn, annotations)
    if (parentId) textAnn.parentId = parentId
    addAnnotation(textAnn)
    setTextInputPos(null)
    setTextInputValue('')
  }, [textInputPos, textInputValue, currentColor, annotations, addAnnotation])

  // Auto-focus text input when shown
  useEffect(() => {
    if (textInputPos && textInputRef.current) {
      textInputRef.current.focus()
    }
  }, [textInputPos])

  const handleToolChange = useCallback((tool: ToolType) => {
    setCurrentTool(tool)
    // PageSprite: deselect rect when switching to pan or rect tool
    if (tool === 'pan' || tool === 'rect') {
      setSelectedRectId(null)
    }
    if (tool === 'pan') {
      containerRef.current?.style.setProperty('cursor', 'grab')
    } else if (tool === 'cursor') {
      containerRef.current?.style.setProperty('cursor', 'default')
    } else {
      containerRef.current?.style.setProperty('cursor', 'crosshair')
    }
  }, [setSelectedRectId])

  // ── Keyboard shortcuts (after handleToolChange so it's in scope) ──
  useEffect(() => {
    const isMod = (e: KeyboardEvent) => e.metaKey || e.ctrlKey
    const KEY_TOOL: Record<string, ToolType> = {
      'v': 'cursor', 'V': 'cursor',
      'm': 'pan', 'M': 'pan',
      'c': 'rect', 'C': 'rect',
      '2': 'arrow', '3': 'highlight',
      '4': 'rectangle', '5': 'ellipse', '6': 'text',
    }
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip when focus is in an input/textarea (e.g. RegionConfig prompt or text annotation)
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (textInputPos) return

      // Undo/redo (industry standard)
      if (isMod(e) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) {
          useCanvasStore.getState().redo()
        } else {
          useCanvasStore.getState().undo()
        }
        return
      }
      if (isMod(e) && e.key === 'y') {
        e.preventDefault()
        useCanvasStore.getState().redo()
        return
      }
      // Don't let other mod+key combos (Ctrl+V, etc.) fall through to tool shortcuts
      if (isMod(e)) return

      if (e.key === 'Escape') {
        setSelectedRectId(null)
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedRectId) {
        removeAnnotation(selectedRectId)
        canvasEngineMapRef.current.get(selectedRectId)?.cancel()
        canvasEngineMapRef.current.delete(selectedRectId)
        window.electronAPI.canvasCleanupRect(selectedRectId).catch((err: unknown) =>
          console.warn('[Canvas] Failed to cleanup rect:', err)
        )
        setSelectedRectId(null)
        return
      }
      const tool = KEY_TOOL[e.key]
      if (tool) {
        e.preventDefault()
        handleToolChange(tool)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [selectedRectId, textInputPos, removeAnnotation, setSelectedRectId, handleToolChange])

  // ── Rect drag/resize with document-level listeners ──
  // Document listeners catch mousemove/mouseup even when the cursor leaves
  // the container, making drag and resize feel smooth and reliable.

  const handleStartDrag = useCallback((rectId: string, e: React.MouseEvent) => {
    useCanvasStore.getState().pushUndoState()
    setSelectedRectId(rectId)
    const ann = useCanvasStore.getState().annotations.find(a => a.id === rectId)
    if (!ann?.boundingBox) return
    dragRef.current = { rectId, startScreen: { x: e.clientX, y: e.clientY }, startBounds: { ...ann.boundingBox }, currentBounds: { ...ann.boundingBox } }
    setIsDragging(true)

    // Clean up any stale listeners
    dragCleanupRef.current?.()
    usingDocListenersRef.current = true

    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const zoom = useCanvasStore.getState().zoom
      const dx = (e.clientX - dragRef.current.startScreen.x) / zoom
      const dy = (e.clientY - dragRef.current.startScreen.y) / zoom
      const newBounds = {
        x: dragRef.current.startBounds.x + dx,
        y: dragRef.current.startBounds.y + dy,
        width: dragRef.current.startBounds.width,
        height: dragRef.current.startBounds.height,
      }
      const all = useCanvasStore.getState().annotations
      const others = all
        .filter(a => a.type === 'rect' && a.boundingBox && a.id !== dragRef.current!.rectId)
        .map(a => a.boundingBox!)
      const result = snapMove(newBounds, others)
      useCanvasStore.getState().updateAnnotationBounds(dragRef.current.rectId, result.bounds)
      // Keep child annotations in sync with the rect's new position
      const prevB = dragRef.current.currentBounds
      const childDx = result.bounds.x - prevB.x
      const childDy = result.bounds.y - prevB.y
      if (childDx !== 0 || childDy !== 0) {
        useCanvasStore.getState().translateChildAnnotations(dragRef.current.rectId, childDx, childDy)
      }
      dragRef.current.currentBounds = { ...result.bounds }
      setSnapLines(result.lines)
    }

    const onUp = () => {
      dragRef.current = null
      setSnapLines([])
      setIsDragging(false)
      usingDocListenersRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      dragCleanupRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    dragCleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [getCanvasPos, setSelectedRectId, setSnapLines])

  const handleStartResize = useCallback((rectId: string, edge: string, e: React.MouseEvent) => {
    useCanvasStore.getState().pushUndoState()
    setSelectedRectId(rectId)
    const ann = useCanvasStore.getState().annotations.find(a => a.id === rectId)
    if (!ann?.boundingBox) return
    resizeRef.current = {
      rectId, edge, startScreen: { x: e.clientX, y: e.clientY },
      startBounds: { ...ann.boundingBox },
      startSize: { w: ann.boundingBox.width, h: ann.boundingBox.height },
    }
    setIsDragging(true)

    // Clean up any stale listeners
    resizeCleanupRef.current?.()
    usingDocListenersRef.current = true

    const onMove = (e: MouseEvent) => {
      if (!resizeRef.current) return
      const zoom = useCanvasStore.getState().zoom
      const dx = (e.clientX - resizeRef.current.startScreen.x) / zoom
      const dy = (e.clientY - resizeRef.current.startScreen.y) / zoom
      const sb = resizeRef.current.startBounds
      let newBounds = { ...sb }
      const edge = resizeRef.current.edge
      const dir = parseEdge(edge)

      if (dir.left) { newBounds.x = sb.x + dx; newBounds.width = sb.width - dx }
      if (dir.right) { newBounds.width = sb.width + dx }
      if (dir.top) { newBounds.y = sb.y + dy; newBounds.height = sb.height - dy }
      if (dir.bottom) { newBounds.height = sb.height + dy }

      // Enforce minimum size
      const minSize = 20
      if (newBounds.width < minSize) {
        if (dir.left) newBounds.x = newBounds.x + newBounds.width - minSize
        newBounds.width = minSize
      }
      if (newBounds.height < minSize) {
        if (dir.top) newBounds.y = newBounds.y + newBounds.height - minSize
        newBounds.height = minSize
      }

      const all = useCanvasStore.getState().annotations
      const others = all
        .filter(a => a.type === 'rect' && a.boundingBox && a.id !== resizeRef.current!.rectId)
        .map(a => a.boundingBox!)
      const snapEdges: ('left'|'right'|'top'|'bottom')[] = []
      if (dir.left) snapEdges.push('left')
      if (dir.right) snapEdges.push('right')
      if (dir.top) snapEdges.push('top')
      if (dir.bottom) snapEdges.push('bottom')
      const result = snapResize(newBounds, snapEdges, others)
      let finalBounds = result.bounds
      if (finalBounds.width < minSize) {
        if (dir.left) finalBounds.x = finalBounds.x + finalBounds.width - minSize
        finalBounds.width = minSize
      }
      if (finalBounds.height < minSize) {
        if (dir.top) finalBounds.y = finalBounds.y + finalBounds.height - minSize
        finalBounds.height = minSize
      }
      useCanvasStore.getState().updateAnnotationBounds(resizeRef.current.rectId, finalBounds)
      setSnapLines(result.lines)
    }

    const onUp = () => {
      resizeRef.current = null
      setSnapLines([])
      setIsDragging(false)
      usingDocListenersRef.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      resizeCleanupRef.current = null
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
  }, [getCanvasPos, setSelectedRectId, setSnapLines])

  const handleResetRect = useCallback((id: string) => {
    setAnnotationCode(id, '')
    useCanvasStore.getState().clearRevisionHistory(id)
  }, [setAnnotationCode])

  // ── Render ──

  const rectAnnotations = annotations.filter(a => a.type === 'rect')

  return (
    <div
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={() => { setIsPanning(false); setIsDrawing(false); dragRef.current = null; resizeRef.current = null; setIsDragging(false); usingDocListenersRef.current = false; dragCleanupRef.current?.(); dragCleanupRef.current = null; resizeCleanupRef.current?.(); resizeCleanupRef.current = null; setSnapLines([]) }}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        overflow: 'hidden',
        background: '#ffffff',
        cursor: currentTool === 'pan' ? 'grab' : currentTool === 'cursor' ? 'default' : 'crosshair',
        userSelect: 'none',
      }}
    >
      {/* Grid background (moves with pan/zoom) */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: 'radial-gradient(circle, #d0d0d0 1px, transparent 1px)',
        backgroundSize: `${GRID_SIZE * zoom}px ${GRID_SIZE * zoom}px`,
        backgroundPosition: `${panX % (GRID_SIZE * zoom)}px ${panY % (GRID_SIZE * zoom)}px`,
        pointerEvents: 'none',
      }} />

      {/* Pan Layer — only snap lines, transformed by pan/zoom */}
      <div style={{
        position: 'absolute',
        inset: 0,
        transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
        transformOrigin: '0 0',
        pointerEvents: 'none',
      }}>
        {/* Snap alignment lines */}
        {snapLines.map((line, i) =>
          line.orientation === 'v' ? (
            <div key={i} style={{
              position: 'absolute',
              left: line.pos,
              top: -5000,
              width: 1,
              height: 10000,
              background: 'rgba(79, 140, 255, 0.8)',
              boxShadow: '0 0 4px rgba(79,140,255,0.4)',
              zIndex: 999,
              pointerEvents: 'none',
            }} />
          ) : (
            <div key={i} style={{
              position: 'absolute',
              left: -5000,
              top: line.pos,
              width: 10000,
              height: 1,
              background: 'rgba(79, 140, 255, 0.8)',
              boxShadow: '0 0 4px rgba(79,140,255,0.4)',
              zIndex: 999,
              pointerEvents: 'none',
            }} />
          )
        )}
      </div>

      {/* RectFrames — outside transform layer so chrome stays at fixed pixel size */}
      {rectAnnotations.map((ann) => (
        <RectFrame
          key={ann.id}
          annotation={ann}
          childAnnotations={annotations.filter(a => a.parentId === ann.id)}
          isSelected={ann.id === selectedRectId && currentTool === 'cursor'}
          isCtrlHeld={isCtrlHeld}
          isDragging={isDragging}
          isGenerating={generatingAnnotationIds.includes(ann.id)}
          generationError={generationError[ann.id]}
          toolCalls={toolEvents[ann.id]}
          onCancelGenerate={handleCancelGenerate}
          onStartDrag={handleStartDrag}
          onStartResize={handleStartResize}
          zoom={zoom}
          panX={panX}
          panY={panY}
        />
      ))}

      {/* Canvas overlay for annotation drawing */}
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 5,
        }}
      />

      {/* Preview canvas — above RectFrames so drawing preview is always visible */}
      <canvas
        ref={previewCanvasRef}
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          zIndex: 100,
        }}
      />

      {/* Left annotation toolbar (always visible when rect selected — pan/rect deselect instead) */}
      {selectedRectId && rectAnnotations.find(a => a.id === selectedRectId) && (
        <LeftAnnotationToolbar
          selectedRectId={selectedRectId}
          allAnnotations={annotations}
          zoom={zoom}
          panX={panX}
          panY={panY}
          currentTool={currentTool}
          onToolChange={handleToolChange}
          currentColor={currentColor}
          onColorChange={setCurrentColor}
          onResetRect={handleResetRect}
          onDeleteRect={removeAnnotation}
          onExportHtml={(id) => window.electronAPI.canvasExportHtml(id)}
          onOpenInBrowser={(id) => window.electronAPI.canvasOpenInBrowser(id)}
          onExportImage={(id) => {
            const ann = annotations.find(a => a.id === id)
            const bb = ann?.boundingBox
            const viewport = bb ? { width: Math.round(bb.width), height: Math.round(bb.height) } : undefined
            window.electronAPI.canvasExportImage(id, viewport, ann?.generatedCode)
          }}
        />
      )}

      {/* Region config panel (right side) */}
      {rectAnnotations.map((ann) => (
        <RegionConfig
          key={ann.id}
          annotationId={ann.id}
          isSelected={ann.id === selectedRectId}
          zoom={zoom}
          panX={panX}
          panY={panY}
          onGenerate={handleGenerate}
          onCancel={handleCancelGenerate}
        />
      ))}

      {/* Zoom controls */}
      <ZoomControls
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onResetZoom={handleZoomReset}
        onCenterView={handleCenterView}
        onZoomSet={setZoom}
      />

      {/* Annotation note popup */}
      {pendingNote && (
        <AnnotationNotePopup
          x={pendingNote.x}
          y={pendingNote.y}
          onSubmit={handleNoteSubmit}
          onCancel={handleNoteCancel}
        />
      )}

      {/* Text annotation input */}
      {textInputPos && (
        <input
          ref={textInputRef}
          value={textInputValue}
          onChange={(e) => setTextInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleTextSubmit() }
            if (e.key === 'Escape') { setTextInputPos(null); setTextInputValue('') }
          }}
          onBlur={() => {
            // Small delay so button clicks can complete
            setTimeout(() => { setTextInputPos(null); setTextInputValue('') }, 150)
          }}
          placeholder="输入文字..."
          style={{
            position: 'absolute',
            left: textInputPos.x * zoom + panX,
            top: textInputPos.y * zoom + panY,
            zIndex: 200,
            minWidth: 120,
            padding: '4px 8px',
            border: `2px solid ${currentColor}`,
            borderRadius: 4,
            fontSize: 14,
            outline: 'none',
            background: '#fff',
            fontFamily: 'inherit',
            lineHeight: 1.5,
          }}
        />
      )}

      {/* CSS animation keyframes */}
      <style>{`
        @keyframes text-breath {
          0%, 100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes toolFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes toolSpin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
