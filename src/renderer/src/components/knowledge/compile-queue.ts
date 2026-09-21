// ── Knowledge compile queue (module-level) ──
//
// The queue's state is module-level on purpose: it survives the panel's
// mount/unmount, so a compile loop that is mid-flight when the user leaves the
// knowledge center keeps running and notifies the panel when it remounts.
//
// It lives in its own module — NOT in KnowledgePanel — because two of its three
// producers are not the panel: App's startup auto-compile and a chat message
// card's 编译 button. Importing those functions from the panel put the panel's
// whole subtree into the first-paint chunk for every user, including the ones
// who never open the knowledge center. The compile LOOP stays in the panel
// (it needs the KnowledgeManager, the i18n strings and React state); this
// module holds only what has to outlive it.

export const compileQueue = {
  /** FIFO of file ids — producers append, the panel's loop shifts. */
  pending: [] as string[],
  /** The loop's own reentrancy gate (it is async and runs across awaits). */
  running: false,
  /** The id the loop is on right now — makes a re-enqueue of it a no-op. */
  compilingFileId: null as string | null,
  /** Startup auto-compile is once per app run, not once per panel mount. */
  startupEnqueued: false,
  /** Wakes a loop parked on an empty queue; registered by the panel. */
  wake: null as (() => void) | null,
  /** Registered by the panel on mount, cleared on unmount. A queue with no
   *  mounted panel keeps its work instead of dropping it. */
  sinks: {
    onMarkQueued: null as ((fileId: string) => void) | null,
    onFileStatusChange: null as ((fileId: string, status: 'compiling' | 'compiled' | 'raw') => void) | null,
    onRefresh: null as (() => void) | null
  }
}

/** All producers share the existing queue; preserve work until a panel mounts. */
export function enqueueCompileForFile(fileId: string): void {
  if (!fileId.trim()) return
  if (compileQueue.compilingFileId !== fileId && !compileQueue.pending.includes(fileId)) {
    compileQueue.pending.push(fileId)
    compileQueue.sinks.onMarkQueued?.(fileId)
  }
  compileQueue.sinks.onRefresh?.()
  compileQueue.wake?.()
}

// Enqueue uncompiled raw files on startup. A mounted panel wakes immediately;
// otherwise the queue is retained until the panel registers its processor.
export async function enqueueStartupCompile(): Promise<void> {
  if (compileQueue.startupEnqueued) return
  compileQueue.startupEnqueued = true
  try {
    const rawFiles = await window.electronAPI.knowledgeListFiles('raw') as Array<{ id: string }>
    if (rawFiles.length === 0) return
    for (const f of rawFiles) enqueueCompileForFile(f.id)
  } catch { /* ignore */ }
}
