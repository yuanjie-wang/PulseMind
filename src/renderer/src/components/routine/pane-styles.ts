// ── Shared pane-row styles ──
// The list-row look shared by RoutineWorkspace and RoutineEditorPage's task
// lists. The codebase styles components with inline style + embedded <style>
// blocks; this is the row part of that idiom, kept in one place so the two
// panes never drift apart.

export const PANE_ROW_STYLES = `
  .pane-row { padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s, border-color 0.15s; }
  .pane-row:hover { background: rgba(0,0,0,0.03); }
  .pane-row--active { background: rgba(0,0,0,0.06); border-color: #d9d9d9; }
  .pane-row--active:hover { background: rgba(0,0,0,0.09); }
  /* Row actions stay out of the way until the row is under the pointer
     (or keyboard focus is inside it). */
  .pane-row-action { opacity: 0; pointer-events: none; transition: opacity 0.15s; }
  .pane-row:hover .pane-row-action, .pane-row:focus-within .pane-row-action { opacity: 1; pointer-events: auto; }
`
