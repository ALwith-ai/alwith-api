// 这个应用手里的 agent:Runtime 里的一个进程,由这里起(start)或接管(attachSession),握手一次,
// 收它的通知与请求,向它发请求,直到它退出或被放手。
//
// 每个 WorkBuddy 都要做、做错就出事故的几件事收在这里:
// - 起进程前先问 Runtime 有没有活的(接管而不是再起一个);
// - 换芯 = stop → 等 exit → start(同一个 agentId 同时只能有一个进程,Runtime 拒绝并发);
// - 进程退出 / 被停 / 被放手时,还在等答的请求立刻失败,不让调用方的 await 永挂;
// - stop 要等到 exit 事件,否则切芯的 resume 会重新接到旧进程。
import { type AgentRequest, REQUEST_CANCELLED } from "./requests"

/** `attachSession` 交回来的最少三样:哪个 agent、哪颗芯、还没答的请求。端口自己的类型可以更多(provider…)。 */
export interface AttachInfo {
  agentId: string
  engine: string
  pendingAgentRequests: AgentRequest[]
}

/**
 * `Agents` 对端口的全部要求 —— `RuntimeClient` 的一个子集,应用自己的宿主端口(如桌面的 Tauri 中转)
 * 只要有这几条就能用。
 */
export interface AgentPort<Launch, Info extends AttachInfo = AttachInfo> {
  start(agentId: string, launch: Launch): Promise<void>
  stop(agentId: string): Promise<void>
  agents(): Promise<Array<{ agentId: string }>>
  attachSession(sessionId: string): Promise<Info | null>
  releaseSession(sessionId: string): Promise<void>
  acpRequest<Result = unknown>(agentId: string, method: string, params?: unknown, options?: { id?: string | number }): Promise<Result>
  acpNotify(agentId: string, method: string, params?: unknown): Promise<void>
  acpRespond(agentId: string, id: unknown, result?: unknown, error?: unknown): Promise<void>
  onAcpNotification(handler: (notification: { agentId: string; method: string; params: unknown }) => void): Promise<() => void>
  onAcpAgentRequest(handler: (request: { agentId: string; id: unknown; method: string; params: unknown }) => void): Promise<() => void>
  onExit(handler: (payload: { agentId: string }) => void): Promise<() => void>
}

export type Handshake = {
  /** ACP v2 必填 name 与 version;title 之类给人看的照协议随意加。 */
  info: { name: string; version: string; [key: string]: unknown }
  capabilities?: Record<string, unknown>
}

/** 请求还没等到答复,agent 就没了(退出、被停、被放手)。 */
export class AgentGoneError extends Error {
  readonly agentId: string
  constructor(agentId: string, reason: string) {
    super(`${reason}: agent ${agentId}`)
    this.name = "AgentGoneError"
    this.agentId = agentId
  }
}

/** 带 signal 的请求被调用方取消:已按协议发了 `$/cancel_request`,本地立即失败。 */
export class RequestCancelledError extends Error {
  readonly code = REQUEST_CANCELLED
  constructor() {
    super("Request cancelled")
    this.name = "RequestCancelledError"
  }
}

/**
 * 一个活的 agent。由 `Agents.start` / `Agents.attach` 建,不直接 new。
 */
export class Agent {
  readonly agentId: string
  /** Runtime 报的芯(接管时)或起它时给的;应用自己认。 */
  readonly engine: string | null
  /** initialize 的结果:agent 的身份、能力、登录方式。 */
  readonly initialized: unknown
  /** 进程没了(exit 事件)之后 resolve;放手(detach)不算。 */
  readonly exited: Promise<void>

  private _alive = true
  private readonly port: AgentPort<unknown>
  private readonly inflight = new Set<(error: Error) => void>()
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>()
  private readonly requestHandlers = new Set<(request: AgentRequest) => void>()
  private readonly idPrefix = `app-${Math.random().toString(36).slice(2, 8)}`
  private nextId = 1
  private unlisten: (() => void) | null = null
  private readonly resolveExited: () => void
  private readonly goneListeners = new Set<() => void>()
  private readonly failureListeners = new Set<(error: Error) => void>()

  /** @internal */
  constructor(port: AgentPort<unknown>, agentId: string, engine: string | null, initialized: unknown) {
    this.port = port
    this.agentId = agentId
    this.engine = engine
    this.initialized = initialized
    let resolve: () => void = () => {}
    this.exited = new Promise<void>(r => {
      resolve = r
    })
    this.resolveExited = resolve
  }

  get alive(): boolean {
    return this._alive
  }

  /** 还在等 agent 答复的请求数。停 / 放手前看一眼:大于零说明有一轮工作被硬生生打断。 */
  get inflightCount(): number {
    return this.inflight.size
  }

  /**
   * Runtime 报了这个 agent 的故障(`_alwith/runtimeError` 之类):它的答复不会再来了,在飞的立刻失败。
   * agent 本身仍持有 —— 进程没退出,退没退由 exit 事件说。
   */
  fail(reason: string): void {
    this.failInflight(new AgentGoneError(this.agentId, reason))
  }

  /** Requests and receipt-completed turns both terminate when this connection becomes unavailable. */
  onFailure(listener: (error: Error) => void): () => void {
    this.failureListeners.add(listener)
    return () => this.failureListeners.delete(listener)
  }

  /** @internal 进程没了的那一刻同步通知(exit 事件到达的同一个调用栈里),`exited` 是它的 Promise 版。 */
  onGone(listener: () => void): () => void {
    this.goneListeners.add(listener)
    return () => this.goneListeners.delete(listener)
  }

  /** @internal 挂上 Runtime 的三条订阅;只挂一次。 */
  async listen(): Promise<void> {
    if (this.unlisten) return
    const offNotification = await this.port.onAcpNotification(notification => {
      if (notification.agentId !== this.agentId) return
      for (const handler of this.notificationHandlers) handler(notification.method, notification.params)
    })
    const offRequest = await this.port.onAcpAgentRequest(request => {
      if (request.agentId !== this.agentId) return
      for (const handler of this.requestHandlers) handler({ id: request.id, method: request.method, params: request.params })
    })
    const offExit = await this.port.onExit(exit => {
      if (exit.agentId === this.agentId) this.gone("agent exited")
    })
    this.unlisten = () => {
      offNotification()
      offRequest()
      offExit()
    }
  }

  /**
   * 发一条 ACP 请求,等 agent 的答复(Runtime 编 id、配对)。
   * `signal` abort = 取消这条请求:按规范发 `$/cancel_request`(agent MAY 取消,MUST 对原请求回 -32800
   * 或有效响应),本地立即以 `RequestCancelledError` 失败,不等 agent 配不配合。为此带 signal 的请求
   * 由这里自选 id 交给 Runtime,撤回时才有 id 可指。
   */
  request<T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
    const signal = options?.signal
    if (signal?.aborted) return Promise.reject(new RequestCancelledError())
    if (!this._alive) return Promise.reject(new AgentGoneError(this.agentId, "agent is gone"))
    const id = signal ? `${this.idPrefix}-${this.nextId++}` : undefined
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const settle = () => {
        settled = true
        this.inflight.delete(fail)
        signal?.removeEventListener("abort", onAbort)
      }
      const fail = (error: Error) => {
        if (settled) return
        settle()
        reject(error)
      }
      const onAbort = () => {
        if (settled) return
        settle()
        void this.notify("$/cancel_request", { requestId: id })
        reject(new RequestCancelledError())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.inflight.add(fail)
      this.port.acpRequest<T>(this.agentId, method, params, id === undefined ? undefined : { id }).then(
        result => {
          if (settled) return
          settle()
          resolve(result)
        },
        (error: unknown) => fail(error instanceof Error ? error : new Error(String(error)))
      )
    })
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.port.acpNotify(this.agentId, method, params)
  }

  /** 回答 agent 发来的请求,带原来的 id。 */
  respond(id: unknown, result?: unknown, error?: { code: number; message: string }): Promise<void> {
    return this.port.acpRespond(this.agentId, id, result, error)
  }

  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  onAgentRequest(handler: (request: AgentRequest) => void): () => void {
    this.requestHandlers.add(handler)
    return () => this.requestHandlers.delete(handler)
  }

  /**
   * 停掉进程,等到它真的没了。Runtime 的 stop 只发终止信号,exit 事件在会话解绑、进程清理之后才来;
   * 不等,换芯的 start 会撞上「still running」。进程可能在订阅前就已退出,那时不会再有 exit,用
   * Runtime 当前的进程表确认。
   */
  async stop(): Promise<void> {
    if (!this._alive) return
    const exited = this.exited
    try {
      await this.port.stop(this.agentId)
      const agents = await this.port.agents()
      if (agents.some(agent => agent.agentId === this.agentId)) await exited
    } finally {
      this.gone("agent stopped")
    }
  }

  /** 放手:卸订阅、在飞的失败,进程留在 Runtime 里给下一个接管的(跨窗口交接)。 */
  detach(): void {
    if (!this._alive) return
    this._alive = false
    this.unlisten?.()
    this.unlisten = null
    this.failInflight(new AgentGoneError(this.agentId, "agent detached"))
  }

  private gone(reason: string): void {
    const wasAlive = this._alive
    this._alive = false
    this.unlisten?.()
    this.unlisten = null
    this.failInflight(new AgentGoneError(this.agentId, reason))
    if (!wasAlive) return
    this.resolveExited()
    for (const listener of [...this.goneListeners]) listener()
  }

  private failInflight(error: Error): void {
    for (const listener of this.failureListeners) listener(error)
    for (const fail of [...this.inflight]) fail(error)
    this.inflight.clear()
  }
}

export type Attached<Info extends AttachInfo = AttachInfo> = { agent: Agent; info: Info }

/**
 * 这个应用持有的 agent 们。一个 Runtime 连接一份。
 */
export class Agents<Launch = unknown, Info extends AttachInfo = AttachInfo> {
  private readonly port: AgentPort<Launch, Info>
  private readonly handshake: Handshake
  private readonly held = new Map<string, Agent>()
  private readonly exitHandlers = new Set<(agent: Agent) => void>()

  constructor(port: AgentPort<Launch, Info>, handshake: Handshake) {
    this.port = port
    this.handshake = handshake
  }

  /** 已持有的那个;没有(从没起过、退出了、放手了)是 undefined。 */
  get(agentId: string): Agent | undefined {
    return this.held.get(agentId)
  }

  /** 持有的 agent 进程没了 —— 不管是崩了还是被 `stop` 的(放手不算)。是不是自己停的应用自己知道。 */
  onExit(handler: (agent: Agent) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  /**
   * 起一个新进程。同一个 agentId 还活着时 Runtime 直接拒绝 —— 换芯是 `replace`。
   * 握手在这里做一次;之后 Runtime 用缓存答重复的 initialize。
   */
  async start(agentId: string, launch: Launch, engine: string | null = null): Promise<Agent> {
    await this.port.start(agentId, launch)
    return this.hold(agentId, engine)
  }

  /**
   * 接管一条会话的活 agent:Runtime 里有就直连它(进程、上下文、没答的请求都还在),没有返回 null。
   * `info.pendingAgentRequests` 是 agent 还在等答的请求,交给待办簿当作刚收到。
   */
  async attach(sessionId: string): Promise<Attached<Info> | null> {
    const info = await this.port.attachSession(sessionId)
    if (info === null) return null
    const existing = this.held.get(info.agentId)
    if (existing?.alive) return { agent: existing, info }
    try {
      return { agent: await this.hold(info.agentId, info.engine), info }
    } catch (error) {
      // 认领了却没握上手:把认领退掉,不让别的窗口再也接不上
      await this.port.releaseSession(sessionId).catch(() => undefined)
      throw error
    }
  }

  /** 换芯:停掉旧的、等它真的没了、再起新的。 */
  async replace(agentId: string, launch: Launch, engine: string | null = null): Promise<Agent> {
    await this.held.get(agentId)?.stop()
    return this.start(agentId, launch, engine)
  }

  private async hold(agentId: string, engine: string | null): Promise<Agent> {
    // ACP v2 同一连接只握手一次;接管时这条由 Runtime 用缓存的握手结果回答,不打扰引擎
    const initialized = await this.port.acpRequest(agentId, "initialize", {
      protocolVersion: 2,
      info: this.handshake.info,
      capabilities: this.handshake.capabilities ?? {}
    })
    const agent = new Agent(this.port as unknown as AgentPort<unknown>, agentId, engine, initialized)
    await agent.listen()
    this.held.set(agentId, agent)
    // 同步:exit 事件到达的同一个调用栈里就把持有表清掉、通知应用 —— 收尸与崩溃提示不能落后一个微任务
    agent.onGone(() => {
      if (this.held.get(agentId) === agent) this.held.delete(agentId)
      for (const handler of this.exitHandlers) handler(agent)
    })
    return agent
  }

  /** @internal 放手后从持有表里摘掉。 */
  release(agent: Agent): void {
    agent.detach()
    if (this.held.get(agent.agentId) === agent) this.held.delete(agent.agentId)
  }
}
