// Every open session, plus the streaming UTF-8 decoders that terminal output needs.
//
// Terminal blocks are stored separately (not in `items`): their output arrives as a byte stream, a multi-byte character may span two chunks,
// and the same `TextDecoder` must keep decoding it. This is the one piece of state a pure reducer cannot hold.
import type * as acp from "@agentclientprotocol/sdk/experimental/v2"
import {
  acknowledgePrompt,
  addPrompt,
  applyUpdate,
  type FoldPolicy,
  markInterrupted,
  recordLinkOf,
  type Session
} from "./session"
import type { ReplayReceipt } from "./replay"
import { type Turn, turns } from "./turns"

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0))
}

export class SessionStore {
  readonly sessions = new Map<string, Session>()
  private readonly decoders = new Map<string, TextDecoder>()
  /** Linked frames that arrived ahead of what the session applied, by session, keyed `seq:frame`. */
  private readonly pending = new Map<string, Map<string, acp.SessionUpdate>>()
  private readonly gapHandlers = new Set<(id: string, appliedThrough: number) => void>()
  /** The applied position a gap was last reported at, per session: one report per gap, not per frame. */
  private readonly reportedGaps = new Map<string, number>()

  /** The judgments the protocol cannot answer at fold time; see `FoldPolicy`. */
  private readonly policy: FoldPolicy

  constructor(policy: FoldPolicy = {}) {
    this.policy = policy
  }

  get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown session ${id}`)
    return session
  }

  set(session: Session): void {
    this.sessions.set(session.id, session)
  }

  /**
   * A replay is about to stream in. From `"start"` the session is emptied first; from a record position (`after`) what is
   * held stays and the replayed frames extend it, so a session that lost its connection catches up without being rebuilt.
   */
  beginReplay(id: string, from: "start" | number = "start"): void {
    const session = this.get(id)
    this.reportedGaps.delete(id)
    if (from === "start") {
      this.pending.delete(id)
      this.sessions.set(id, {
        ...session,
        items: [],
        terminals: {},
        turnUsage: {},
        turnEndedAt: {},
        clock: 0,
        restoring: true,
        error: null,
        appliedThrough: -1,
        appliedFrame: -1
      })
      for (const key of this.decoders.keys()) if (key.startsWith(`${id}:`)) this.decoders.delete(key)
      return
    }
    this.sessions.set(id, { ...session, restoring: true, error: null })
  }

  /**
   * The resume answered: the session is live again and has the record through the replay's `cut` (when the agent said).
   * Live frames that arrived past the cut while the replay ran were held; they are applied now, in record order.
   */
  endReplay(id: string, receipt: ReplayReceipt | null): void {
    const session = this.get(id)
    const caughtUp = receipt !== null && receipt.cut >= session.appliedThrough
    this.sessions.set(id, {
      ...session,
      attached: true,
      restoring: false,
      appliedThrough: caughtUp ? receipt.cut : session.appliedThrough,
      appliedFrame: caughtUp ? Number.MAX_SAFE_INTEGER : session.appliedFrame
    })
    this.drain(id)
  }

  /**
   * A linked frame arrived whose `prevSeq` is past what the session applied: something between is missing (a frame
   * lost on the way, or live frames running ahead of a replay). The frame is held; the handler backfills with a resume
   * `after: appliedThrough`, after which the held frames apply in order. Reported once per gap.
   */
  onGap(handler: (id: string, appliedThrough: number) => void): () => void {
    this.gapHandlers.add(handler)
    return () => {
      this.gapHandlers.delete(handler)
    }
  }

  /** Frames held for a session because something before them has not arrived (tests, diagnostics). */
  held(id: string): number {
    return this.pending.get(id)?.size ?? 0
  }

  /**
   * Consumes one `session/update` frame. A frame linked into the record (`_meta.alwith.seq` / `prevSeq` / `frame`) is
   * applied only in record order: one whose predecessor is not in yet is held and a gap reported; one at or before the
   * applied position is a repeat (a replay overlapping live frames) and is dropped. Unlinked frames (chunks, older
   * agents) apply as they come.
   */
  accept(id: string, update: acp.SessionUpdate): Session {
    const link = recordLinkOf(update)
    if (link === null) return this.applyNow(id, update)
    const session = this.get(id)
    if (link.prevSeq > session.appliedThrough) {
      let held = this.pending.get(id)
      if (!held) {
        held = new Map()
        this.pending.set(id, held)
      }
      held.set(`${link.seq}:${link.frame}`, update)
      // While a replay runs it is the one filling the gap; a report would only start a second one.
      if (!session.restoring && this.reportedGaps.get(id) !== session.appliedThrough) {
        this.reportedGaps.set(id, session.appliedThrough)
        for (const handler of this.gapHandlers) handler(id, session.appliedThrough)
      }
      return session
    }
    if (link.seq === session.appliedThrough && link.frame <= session.appliedFrame) return session
    const next = this.applyNow(id, update)
    const advanced =
      link.seq > session.appliedThrough || link.seq === session.appliedThrough
        ? { ...next, appliedThrough: Math.max(next.appliedThrough, link.seq), appliedFrame: link.frame }
        : next
    this.sessions.set(id, advanced)
    this.drain(id)
    return this.get(id)
  }

  /** Apply every held frame whose predecessor is now in, in record order, until one still waits. */
  private drain(id: string): void {
    const held = this.pending.get(id)
    if (!held || held.size === 0) return
    for (;;) {
      const session = this.get(id)
      const ready = [...held.entries()]
        .map(([key, update]) => ({
          key,
          update,
          link: recordLinkOf(update) as NonNullable<ReturnType<typeof recordLinkOf>>
        }))
        .filter(entry => entry.link.prevSeq <= session.appliedThrough)
        .sort((left, right) => left.link.seq - right.link.seq || left.link.frame - right.link.frame)
      if (ready.length === 0) break
      for (const entry of ready) {
        held.delete(entry.key)
        const current = this.get(id)
        if (entry.link.seq === current.appliedThrough && entry.link.frame <= current.appliedFrame) continue
        const next = this.applyNow(id, entry.update)
        this.sessions.set(id, {
          ...next,
          appliedThrough: Math.max(next.appliedThrough, entry.link.seq),
          appliedFrame: entry.link.seq >= current.appliedThrough ? entry.link.frame : current.appliedFrame
        })
      }
    }
    if (held.size === 0) this.pending.delete(id)
    else {
      const session = this.get(id)
      if (!session.restoring && this.reportedGaps.get(id) !== session.appliedThrough) {
        this.reportedGaps.set(id, session.appliedThrough)
        for (const handler of this.gapHandlers) handler(id, session.appliedThrough)
      }
    }
  }

  private applyNow(id: string, update: acp.SessionUpdate): Session {
    const session = this.get(id)
    let decoded: string | undefined
    if (update.sessionUpdate === "terminal_update") {
      const frame = update as acp.TerminalUpdate
      if (frame.output) {
        const decoder = new TextDecoder()
        this.decoders.set(`${id}:${frame.terminalId}`, decoder)
        decoded = decoder.decode(decodeBase64(frame.output.data), {
          stream: true
        })
      }
    } else if (update.sessionUpdate === "terminal_output_chunk") {
      const frame = update as acp.TerminalOutputChunk
      const key = `${id}:${frame.terminalId}`
      let decoder = this.decoders.get(key)
      if (!decoder) {
        decoder = new TextDecoder()
        this.decoders.set(key, decoder)
      }
      decoded = decoder.decode(decodeBase64(frame.data), { stream: true })
    }
    const next = applyUpdate(session, update, { text: decoded, policy: this.policy })
    this.sessions.set(id, next)
    return next
  }

  /** Shows the message the user just sent on screen first; see `addPrompt`. Returns its local id (replaced by the agent's once its report arrives). */
  addPrompt(id: string, content: acp.ContentBlock[]): string {
    const promptId = crypto.randomUUID()
    this.sessions.set(id, addPrompt(this.get(id), content, promptId))
    return promptId
  }

  acknowledgePrompt(id: string, localId: string, messageId: string): void {
    this.sessions.set(id, acknowledgePrompt(this.get(id), localId, messageId))
  }

  /** Groups this session by turn, using the store's own criteria. */
  turns(id: string): Turn[] {
    return turns(this.get(id), this.policy)
  }

  /**
   * Reaps the dangling "outlives the turn" tools in this session. Call only after loading a session with **no live process** and consuming its history;
   * never call it for a session attached to a live process. Returns whether anything changed.
   */
  markInterrupted(id: string): boolean {
    const session = this.get(id)
    const next = markInterrupted(session, this.policy)
    if (next === session) return false
    this.sessions.set(id, next)
    return true
  }
}
