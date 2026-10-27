/**
 * Publishes the latest already-folded snapshot per session once per 16ms window. Protocol folding
 * and the decision to flush immediately belong to the caller.
 *
 * Moved here from `@alwith/module-chat/update-scheduler` (2026-10-27 chat-layer extraction): the
 * client publishes sessions, not the chat UI, so the scheduler lives with the client.
 */
export class UpdateScheduler<Snapshot> {
  private readonly pending = new Map<string, Snapshot>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly publish: (snapshots: Readonly<Record<string, Snapshot>>) => void) {}

  /** Replaces a session's pending snapshot without postponing the current deadline. */
  enqueue(sessionId: string, snapshot: Snapshot): void {
    this.pending.set(sessionId, snapshot)
    this.timer ??= setTimeout(() => this.flush(), 16)
  }

  /** Publish all pending sessions now, including text preceding a lifecycle change. */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (this.pending.size === 0) return
    const snapshots = Object.fromEntries(this.pending)
    this.pending.clear()
    this.publish(snapshots)
  }

  /** Drop a closed session without discarding another session's pending updates. */
  remove(sessionId: string): void {
    this.pending.delete(sessionId)
    if (this.pending.size === 0) this.cancel()
  }

  /** Discard pending snapshots on disconnect or disposal. The scheduler is reusable. */
  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.pending.clear()
  }
}
