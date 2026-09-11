// ── Audit log entry (PLAN-0.4.0 M3.12 / M6.7) ──

export interface AuditEntry {
  id: string
  ts: string
  /** project | tool | routine */
  scope: string
  /** conversationId | toolId | 'scheduler' */
  actor?: string
  /** fs.read | fs.write | exec | http | clipboard | notify | open-external | ... */
  action: string
  /** Path / command summary / URL host */
  target?: string
  /** allowed | denied | approved | rejected | auto | sandboxed */
  decision: string
  policyJson?: string
  metaJson?: string
}
