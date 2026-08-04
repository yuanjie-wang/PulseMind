import { create } from 'zustand'
import type { Annotation, BoundingBox, ToolType } from '../types/canvas'

interface CanvasState {
  // Canvas state
  annotations: Annotation[]
  selectedRectId: string | null
  generatingAnnotationIds: string[]
  revisionHistory: Record<string, string[]>

  // Tool state (shared between header toolbar and canvas)
  currentTool: ToolType
  currentColor: string

  // Canvas navigation
  zoom: number
  panX: number
  panY: number

  // Undo/redo stacks
  undoStack: Annotation[][]
  redoStack: Annotation[][]
  canUndo: boolean
  canRedo: boolean

  // Actions
  setCurrentTool: (tool: ToolType) => void
  setCurrentColor: (color: string) => void
  setZoom: (zoom: number) => void
  setPan: (x: number, y: number) => void
  addAnnotation: (annotation: Annotation) => void
  removeAnnotation: (id: string) => void
  updateAnnotationBounds: (id: string, bounds: Partial<BoundingBox>) => void
  updateAnnotationText: (id: string, text: string) => void
  setAnnotationCode: (id: string, code: string) => void
  updateAnnotationColor: (id: string, color: string) => void
  updateAnnotationPromptSize: (id: string, width: string, height: string) => void
  setSelectedRectId: (id: string | null) => void
  addGeneratingAnnotationId: (id: string) => void
  removeGeneratingAnnotationId: (id: string) => void
  addRevisionEntry: (id: string, prompt: string) => void
  clearRevisionHistory: (id: string) => void
  translateChildAnnotations: (parentId: string, dx: number, dy: number) => void
  scaleChildAnnotations: (parentId: string, oldBounds: BoundingBox, newBounds: BoundingBox) => void
  persistCanvas: () => void
  loadCanvas: () => void
  reset: () => void
  clearAllAnnotations: () => void
  pushUndoState: () => void
  undo: () => void
  redo: () => void
}

const initialState = {
  annotations: [] as Annotation[],
  selectedRectId: null as string | null,
  generatingAnnotationIds: [] as string[],
  revisionHistory: {} as Record<string, string[]>,
  currentTool: 'cursor' as ToolType,
  currentColor: '#ff0000',
  zoom: 0.6,
  panX: 0,
  panY: 0,
  undoStack: [] as Annotation[][],
  redoStack: [] as Annotation[][],
  canUndo: false,
  canRedo: false,
}

const CANVAS_VERSION = 2

export const useCanvasStore = create<CanvasState>((set, get) => ({
  ...initialState,

  setCurrentTool: (tool) => set({ currentTool: tool }),
  setCurrentColor: (color) => set({ currentColor: color }),
  setZoom: (zoom) => set({ zoom }),
  setPan: (x, y) => set({ panX: x, panY: y }),

  addAnnotation: (annotation) =>
    set((s) => ({
      annotations: [...s.annotations, annotation],
      undoStack: [...s.undoStack, [...s.annotations]],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    })),

  removeAnnotation: (id) =>
    set((s) => ({
      annotations: s.annotations.filter((a) => a.id !== id && a.parentId !== id),
      selectedRectId: s.selectedRectId === id ? null : s.selectedRectId,
      undoStack: [...s.undoStack, [...s.annotations]],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    })),

  updateAnnotationBounds: (id, bounds) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id && a.boundingBox
          ? { ...a, boundingBox: { ...a.boundingBox, ...bounds } }
          : a
      ),
    })),

  updateAnnotationText: (id, text) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, text } : a
      ),
    })),

  setAnnotationCode: (id, code) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, generatedCode: code } : a
      ),
      undoStack: [...s.undoStack, [...s.annotations]],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    })),

  updateAnnotationColor: (id, color) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, color } : a
      ),
    })),

  updateAnnotationPromptSize: (id, width, height) =>
    set((s) => ({
      annotations: s.annotations.map((a) =>
        a.id === id ? { ...a, promptWidth: width, promptHeight: height } : a
      ),
    })),

  setSelectedRectId: (id) => set({ selectedRectId: id }),

  addGeneratingAnnotationId: (id) =>
    set((s) => ({
      generatingAnnotationIds: [...s.generatingAnnotationIds, id],
    })),

  removeGeneratingAnnotationId: (id) =>
    set((s) => ({
      generatingAnnotationIds: s.generatingAnnotationIds.filter((g) => g !== id),
    })),

  addRevisionEntry: (id, prompt) =>
    set((s) => ({
      revisionHistory: {
        ...s.revisionHistory,
        [id]: [...(s.revisionHistory[id] || []), prompt],
      },
    })),

  clearRevisionHistory: (id) =>
    set((s) => {
      const { [id]: _, ...rest } = s.revisionHistory
      return { revisionHistory: rest }
    }),

  translateChildAnnotations: (parentId, dx, dy) =>
    set((s) => ({
      annotations: s.annotations.map((a) => {
        if (a.parentId !== parentId) return a
        const movedPoints = a.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
        const movedBbox = a.boundingBox
          ? {
              ...a.boundingBox,
              x: a.boundingBox.x + dx,
              y: a.boundingBox.y + dy,
            }
          : undefined
        return { ...a, points: movedPoints, boundingBox: movedBbox }
      }),
    })),

  scaleChildAnnotations: (parentId, oldBounds, newBounds) =>
    set((s) => {
      const scaleX = newBounds.width / oldBounds.width
      const scaleY = newBounds.height / oldBounds.height
      return {
        annotations: s.annotations.map((a) => {
          if (a.parentId !== parentId) return a
          const movedPoints = a.points.map((p) => ({
            x: (p.x - oldBounds.x) * scaleX + newBounds.x,
            y: (p.y - oldBounds.y) * scaleY + newBounds.y,
          }))
          const movedBbox = a.boundingBox
            ? {
                x: (a.boundingBox.x - oldBounds.x) * scaleX + newBounds.x,
                y: (a.boundingBox.y - oldBounds.y) * scaleY + newBounds.y,
                width: a.boundingBox.width * scaleX,
                height: a.boundingBox.height * scaleY,
              }
            : undefined
          return { ...a, points: movedPoints, boundingBox: movedBbox }
        }),
      }
    }),

  persistCanvas: () => {
    const s = get()
    const data = {
      annotations: s.annotations,
      revisionHistory: s.revisionHistory,
      panX: s.panX,
      panY: s.panY,
      _version: CANVAS_VERSION,
    }
    try {
      localStorage.setItem('pulsemind-canvas-workspace', JSON.stringify(data))
    } catch (e) {
      console.warn('[canvas] persist failed:', e)
    }
  },

  loadCanvas: () => {
    try {
      const raw = localStorage.getItem('pulsemind-canvas-workspace')
      if (!raw) return
      const data = JSON.parse(raw)
      // Migrate old defaults (reset pan to allow centering)
      if ((data._version ?? 1) < CANVAS_VERSION) {
        set({
          annotations: data.annotations || [],
          revisionHistory: data.revisionHistory || {},
          panX: 0,
          panY: 0,
        })
        return
      }
      set({
        annotations: data.annotations || [],
        revisionHistory: data.revisionHistory || {},
        panX: data.panX ?? 0,
        panY: data.panY ?? 0,
      })
    } catch (e) {
      console.warn('[canvas] load failed:', e)
    }
  },

  reset: () => set(initialState),

  clearAllAnnotations: () => {
    set({
      annotations: [],
      undoStack: [],
      redoStack: [],
      canUndo: false,
      canRedo: false,
    })
  },

  pushUndoState: () => {
    const s = get()
    set({
      undoStack: [...s.undoStack, [...s.annotations]],
      redoStack: [],
      canUndo: true,
      canRedo: false,
    })
  },

  undo: () => {
    const s = get()
    if (s.undoStack.length === 0) return
    const prev = s.undoStack[s.undoStack.length - 1]
    set({
      annotations: prev,
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, [...s.annotations]],
      canUndo: s.undoStack.length > 1,
      canRedo: true,
    })
  },

  redo: () => {
    const s = get()
    if (s.redoStack.length === 0) return
    const next = s.redoStack[s.redoStack.length - 1]
    set({
      annotations: next,
      undoStack: [...s.undoStack, [...s.annotations]],
      redoStack: s.redoStack.slice(0, -1),
      canUndo: true,
      canRedo: s.redoStack.length > 1,
    })
  },
}))
