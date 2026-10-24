import type {
  PromptResponse,
  SessionUpdate,
  StateUpdate,
  UserMessage
} from "@agentclientprotocol/sdk/experimental/v2/unstable"

export type PromptCompletion = Extract<StateUpdate, { state: "idle" }>
type Insertion = { echoed: boolean; completion: PromptCompletion | null }
type Pending = {
  messageId: string | null
  resolve: (completion: PromptCompletion) => void
  reject: (error: Error) => void
}
type SessionPrompts = { pending: Set<Pending>; insertions: Map<string, Insertion> }

/** Connection-scoped prompt receipts and idle boundaries. No transcript or persistent state. */
export class PromptTracker {
  private readonly sessions = new Map<string, SessionPrompts>()
  private readonly maxPending: number
  private readonly maxObserved: number

  constructor(options: { maxPendingPerSession?: number; maxObservedMessagesPerSession?: number } = {}) {
    this.maxPending = options.maxPendingPerSession ?? 256
    this.maxObserved = options.maxObservedMessagesPerSession ?? 4096
    for (const limit of [this.maxPending, this.maxObserved])
      if (!Number.isSafeInteger(limit) || limit < 1)
        throw new RangeError("Prompt tracking limits must be positive safe integers")
  }

  run(
    sessionId: string,
    send: () => Promise<PromptResponse>,
    acknowledge: (response: PromptResponse) => void
  ): Promise<PromptCompletion> {
    let session = this.sessions.get(sessionId)
    if (session === undefined) {
      session = { pending: new Set(), insertions: new Map() }
      this.sessions.set(sessionId, session)
    }
    if (session.pending.size >= this.maxPending)
      return Promise.reject(new Error(`Session ${sessionId} pending prompt capacity exceeded (${this.maxPending})`))
    const current = session
    return new Promise<PromptCompletion>((resolve, reject) => {
      const pending: Pending = { messageId: null, resolve, reject }
      current.pending.add(pending)
      void Promise.resolve()
        .then(() => {
          if (!current.pending.has(pending)) throw new Error("Prompt connection retired before sending")
          return send()
        })
        .then((response) => {
          if (!current.pending.has(pending)) return
          if (typeof response.messageId !== "string" || response.messageId.length === 0) {
            throw new Error("session/prompt returned no messageId")
          }
          acknowledge(response)
          // A receipt callback may synchronously close or replace this session.
          if (!current.pending.has(pending)) return
          pending.messageId = response.messageId
          let insertion = current.insertions.get(response.messageId)
          if (insertion === undefined) {
            if (!this.reserveInsertion(sessionId, current)) return
            insertion = { echoed: false, completion: null }
            current.insertions.set(response.messageId, insertion)
          }
          if (insertion.completion !== null) {
            current.pending.delete(pending)
            resolve(insertion.completion)
          }
          this.prune(sessionId, current)
        })
        .catch((error: unknown) => {
          current.pending.delete(pending)
          reject(error instanceof Error ? error : new Error(String(error)))
          this.prune(sessionId, current)
        })
    })
  }

  accept(sessionId: string, update: SessionUpdate): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    if (update.sessionUpdate === "user_message" || update.sessionUpdate === "user_message_chunk") {
      const { messageId } = update as UserMessage
      const insertion = session.insertions.get(messageId)
      if (insertion) insertion.echoed = true
      else if (this.reserveInsertion(sessionId, session))
        session.insertions.set(messageId, { echoed: true, completion: null })
    } else if (update.sessionUpdate === "state_update" && update.state === "idle") {
      for (const insertion of session.insertions.values()) {
        if (insertion.echoed) insertion.completion ??= update as PromptCompletion
      }
      for (const pending of session.pending) {
        if (pending.messageId === null) continue
        const insertion = session.insertions.get(pending.messageId)!
        if (insertion.completion === null) continue
        session.pending.delete(pending)
        pending.resolve(insertion.completion)
      }
      this.prune(sessionId, session)
    }
  }

  failSession(sessionId: string, error: Error): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    for (const pending of session.pending) pending.reject(error)
    session.pending.clear()
  }

  fail(error: Error): void {
    for (const sessionId of this.sessions.keys()) this.failSession(sessionId, error)
  }

  private reserveInsertion(sessionId: string, session: SessionPrompts): boolean {
    if (session.insertions.size < this.maxObserved) return true
    // Tracking failure cannot prove whether the remote submission was accepted.
    this.failSession(
      sessionId,
      new Error(`Session ${sessionId} prompt evidence capacity exceeded; completion is unknown`)
    )
    return false
  }

  private prune(sessionId: string, session: SessionPrompts): void {
    if (this.sessions.get(sessionId) !== session) return
    if (session.pending.size === 0) {
      this.sessions.delete(sessionId)
      return
    }
    // Before responses arrive, retain IDs across idle so notification-first transports work.
    if ([...session.pending].some((pending) => pending.messageId === null)) return
    const pendingIds = new Set([...session.pending].map((pending) => pending.messageId))
    for (const id of session.insertions.keys()) if (!pendingIds.has(id)) session.insertions.delete(id)
  }
}
