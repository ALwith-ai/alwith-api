import type { RuntimeClient } from "./runtime-client"
import { RuntimeErrorCode } from "./types"
import type {
  RuntimeAgentInfo,
  RuntimeAttachInfo,
    RuntimeEvent,
  RuntimeExitPayload,
  RuntimeAcpAgentRequest,
  RuntimeAcpNotification,
  RuntimeInboundPayload,
  RuntimeResponseError,
  RuntimePromptResult,
  RuntimeSessionResult,
  RuntimeStderrPayload,
  SessionEventFrame,
  SessionLifecycleFrame,
  SessionRunState
} from "./types"

interface RuntimeResponse {
  id: number
  result: unknown
  error: RuntimeResponseError | null
}

type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

/** A request failed: the response's `error` as sent (`code`, `data`), plus the method it was for. */
export class RuntimeRequestError extends Error {
  readonly method: string
  readonly code: number
  readonly data: unknown
  /** The message as the Runtime (or the agent) sent it, without the method prefix. */
  readonly reason: string

  constructor(method: string, error: RuntimeResponseError) {
    super(`${method}: ${error.message}`)
    this.name = "RuntimeRequestError"
    this.method = method
    this.code = error.code
    this.data = error.data
    this.reason = error.message
  }

  /** The transport is gone or refused the write: raised locally, `RuntimeErrorCode.connectionLost`. */
  static connectionLost(method: string, message: string): RuntimeRequestError {
    return new RuntimeRequestError(method, { code: RuntimeErrorCode.connectionLost, message })
  }
}

/**
 * The `alwith-runtime-v1` frame protocol independent of how frames travel. A transport
 * subclass provides two things: `connectTransport` (make `write` possible, deliver every
 * incoming frame to `receive`) and `write` (one frame out). Everything else, request ids,
 * event fan-out, host extension events, reconnect bookkeeping, lives here, so the WebSocket
 * port and a host's stdio port share one envelope.
 */
export abstract class FrameRuntimeClient<Launch = unknown> implements RuntimeClient<Launch> {
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly inboundHandlers = new Set<(payload: RuntimeInboundPayload) => void>()
  private readonly exitHandlers = new Set<(payload: RuntimeExitPayload) => void>()
  private readonly stderrHandlers = new Set<(payload: RuntimeStderrPayload) => void>()
  private readonly runStateHandlers = new Set<(sessions: SessionRunState[]) => void>()
  private readonly acpNotificationHandlers = new Set<(notification: RuntimeAcpNotification) => void>()
  private readonly acpAgentRequestHandlers = new Set<(request: RuntimeAcpAgentRequest) => void>()
  private readonly eventHandlers = new Map<string, Set<(event: Record<string, unknown>) => void>>()
  private readonly reconnectHandlers = new Set<() => void>()

  /** Makes `write` possible and starts delivering frames to `receive`. Idempotent. */
  protected abstract connectTransport(): Promise<void>
  /** One frame out; the transport is connected when this is called. */
  protected abstract write(text: string): void | Promise<void>

  async start(agentId: string, launch: Launch): Promise<void> {
    await this.request("start", { agentId, launch })
  }

  async send(agentId: string, line: string): Promise<void> {
    await this.request("send", { agentId, line })
  }

  async stop(agentId: string): Promise<void> {
    await this.request("stop", { agentId })
  }

  attachSession(sessionId: string): Promise<RuntimeAttachInfo | null> {
    return this.request("attachSession", { sessionId })
  }

  agentForSession(sessionId: string): Promise<string | null> {
    return this.request("agentForSession", { sessionId })
  }

  async releaseSession(sessionId: string): Promise<void> {
    await this.request("releaseSession", { sessionId })
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request("stopSession", { sessionId })
  }

  async markRead(sessionId: string): Promise<void> {
    await this.request("markRead", { sessionId })
  }

  async setSessionTitle(sessionId: string, title: string): Promise<void> {
    await this.request("setSessionTitle", { sessionId, title })
  }

  sessionLifecycle(sessionId: string): Promise<SessionLifecycleFrame[]> {
    return this.request("sessionLifecycle", { sessionId })
  }

  sessionEvents(sessionId: string, afterSequence?: number, limit?: number): Promise<SessionEventFrame[]> {
    return this.request("sessionEvents", { sessionId, afterSequence, limit })
  }

  runStates(): Promise<SessionRunState[]> {
    return this.request("runStates")
  }

  version(): Promise<string> {
    return this.request("version")
  }

  agents(): Promise<RuntimeAgentInfo[]> {
    return this.request("agents")
  }

  async ping(): Promise<void> {
    await this.request("ping")
  }

  // Subscriptions never fail: a Runtime that is down now is connected to in the background,
  // and run-state subscribers get a fresh snapshot after every reconnect.
  async onInbound(handler: (payload: RuntimeInboundPayload) => void): Promise<() => void> {
    this.inboundHandlers.add(handler)
    await this.connectOrRetry()
    return () => this.inboundHandlers.delete(handler)
  }

  async onExit(handler: (payload: RuntimeExitPayload) => void): Promise<() => void> {
    this.exitHandlers.add(handler)
    await this.connectOrRetry()
    return () => this.exitHandlers.delete(handler)
  }

  async onStderr(handler: (payload: RuntimeStderrPayload) => void): Promise<() => void> {
    this.stderrHandlers.add(handler)
    await this.connectOrRetry()
    return () => this.stderrHandlers.delete(handler)
  }

  acpRequest<Result = unknown>(agentId: string, method: string, params?: unknown, options?: { id?: string | number }): Promise<Result> {
    return this.request<Result>("acpRequest", options?.id === undefined ? { agentId, method, params } : { agentId, method, params, id: options.id })
  }

  async acpNotify(agentId: string, method: string, params?: unknown): Promise<void> {
    await this.request("acpNotify", { agentId, method, params })
  }

  async acpRespond(agentId: string, id: unknown, result?: unknown, error?: unknown): Promise<void> {
    await this.request("acpRespond", { agentId, id, result, error })
  }

  initialize(agentId: string, info?: { name: string; version: string }, capabilities?: Record<string, unknown>): Promise<unknown> {
    return this.request("initialize", { agentId, info, capabilities })
  }

  sessionNew(agentId: string, cwd: string, mcpServers: unknown[] = [], meta?: Record<string, unknown>): Promise<RuntimeSessionResult> {
    return this.request("sessionNew", { agentId, cwd, mcpServers, meta })
  }

  sessionLoad(agentId: string, sessionId: string, cwd: string, mcpServers: unknown[] = [], meta?: Record<string, unknown>): Promise<RuntimeSessionResult> {
    return this.request("sessionLoad", { agentId, sessionId, cwd, mcpServers, meta })
  }

  sessionResume(agentId: string, sessionId: string, cwd: string, replayFrom?: unknown, meta?: Record<string, unknown>): Promise<RuntimeSessionResult> {
    return this.request("sessionResume", { agentId, sessionId, cwd, replayFrom, meta })
  }

  sessionFork(agentId: string, sessionId: string, cwd: string, mcpServers: unknown[] = [], meta?: Record<string, unknown>): Promise<RuntimeSessionResult> {
    return this.request("sessionFork", { agentId, sessionId, cwd, mcpServers, meta })
  }

  prompt(agentId: string, sessionId: string, prompt: unknown[], meta?: Record<string, unknown>): Promise<RuntimePromptResult> {
    return this.request("prompt", { agentId, sessionId, prompt, meta })
  }

  async cancel(agentId: string, sessionId: string): Promise<void> {
    await this.request("cancel", { agentId, sessionId })
  }

  async onAcpNotification(handler: (notification: RuntimeAcpNotification) => void): Promise<() => void> {
    this.acpNotificationHandlers.add(handler)
    await this.connectOrRetry()
    return () => this.acpNotificationHandlers.delete(handler)
  }

  async onAcpAgentRequest(handler: (request: RuntimeAcpAgentRequest) => void): Promise<() => void> {
    this.acpAgentRequestHandlers.add(handler)
    await this.connectOrRetry()
    return () => this.acpAgentRequestHandlers.delete(handler)
  }

  async onRunStates(handler: (sessions: SessionRunState[]) => void): Promise<() => void> {
    this.runStateHandlers.add(handler)
    await this.connectOrRetry()
    return () => this.runStateHandlers.delete(handler)
  }

  /** Host events beyond the core protocol, by their `type`. */
  onEvent(type: string, handler: (event: Record<string, unknown>) => void): () => void {
    let handlers = this.eventHandlers.get(type)
    if (!handlers) {
      handlers = new Set()
      this.eventHandlers.set(type, handlers)
    }
    handlers.add(handler)
    return () => handlers.delete(handler)
  }

  /**
   * Events a module emitted. The Runtime wraps them as `{ type: "module", module, event }`; this
   * unwraps and fans out by module name, so an app never sees the envelope.
   */
  onModuleEvent(module: string, handler: (event: Record<string, unknown>) => void): () => void {
    return this.onEvent("module", raw => {
      if (raw.module !== module) return
      const event = raw.event
      if (event && typeof event === "object") handler(event as Record<string, unknown>)
    })
  }

  /** Fires after every reconnect that follows a drop, so callers can re-attach sessions. */
  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler)
    return () => this.reconnectHandlers.delete(handler)
  }

  /** Any method, including host extensions. */
  async request<Result>(method: string, params?: unknown): Promise<Result> {
    await this.connectTransport()
    const id = this.nextRequestId++
    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, { method, resolve: resolve as (result: unknown) => void, reject })
      void Promise.resolve()
        .then(() => this.write(JSON.stringify(params === undefined ? { id, method } : { id, method, params })))
        .catch((error: unknown) => {
          this.pending.delete(id)
          reject(RuntimeRequestError.connectionLost(method, error instanceof Error ? error.message : String(error)))
        })
    })
  }

  /** A subscription's connect attempt: failure is not an error, the transport retries. */
  protected async connectOrRetry(): Promise<void> {
    await this.connectTransport().then(
      () => undefined,
      () => this.scheduleReconnect()
    )
  }

  /** Transports that reconnect override this; the default transport is either up or gone. */
  protected scheduleReconnect(): void {}

  /** Transports extending this port add their own subscription kinds here. */
  protected hasSubscriptions(): boolean {
    return (
      this.inboundHandlers.size > 0 ||
      this.exitHandlers.size > 0 ||
      this.stderrHandlers.size > 0 ||
      this.runStateHandlers.size > 0 ||
      this.acpNotificationHandlers.size > 0 ||
      this.acpAgentRequestHandlers.size > 0 ||
      this.eventHandlers.size > 0
    )
  }

  /** The transport dropped: every in-flight request fails now instead of hanging. */
  protected rejectPending(reason: string): void {
    for (const pending of this.pending.values()) pending.reject(RuntimeRequestError.connectionLost(pending.method, reason))
    this.pending.clear()
  }

  /** After a reconnect: run-state snapshot first, then host `onReconnect` handlers. */
  protected restoreSubscriptions(): void {
    if (this.runStateHandlers.size > 0) {
      void this.runStates()
        .then(states => {
          for (const handler of this.runStateHandlers) handler(states)
        })
        .catch(() => undefined)
    }
    for (const handler of this.reconnectHandlers) handler()
  }

  /** One incoming frame: a response is matched by id, an event is fanned out by type. */
  protected receive(text: string): void {
    const message = JSON.parse(text) as RuntimeResponse | RuntimeEvent
    if ("type" in message) {
      switch (message.type) {
        case "inbound":
          for (const handler of this.inboundHandlers) handler({ agentId: message.agentId, lines: message.lines })
          break
        case "exit":
          for (const handler of this.exitHandlers) handler({ agentId: message.agentId })
          break
        case "stderr":
          for (const handler of this.stderrHandlers) handler({ agentId: message.agentId, line: message.line })
          break
        case "runStates":
          for (const handler of this.runStateHandlers) handler(message.sessions)
          break
        case "acpNotification":
          for (const handler of this.acpNotificationHandlers)
            handler({ agentId: message.agentId, method: message.method, params: message.params })
          break
        case "acpAgentRequest":
          for (const handler of this.acpAgentRequestHandlers)
            handler({ agentId: message.agentId, id: message.id, method: message.method, params: message.params })
          break
        default:
          break
      }
      const handlers = this.eventHandlers.get(message.type)
      if (handlers) for (const handler of handlers) handler(message as unknown as Record<string, unknown>)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new RuntimeRequestError(pending.method, message.error))
    else pending.resolve(message.result)
  }
}
