// 待办簿:agent 发来、等这个应用回答的请求(权限、问卷)。
//
// 协议规定的那几件事每个 WorkBuddy 都要做、而且做错用户看得见:回答要带原来的 id;用户点 Stop 时
// 这条会话所有没答的权限 MUST 回 cancelled(不回,请求在 agent 与 Runtime 里永远挂着,下次接管
// 被重放成僵尸弹窗);agent 自己撤回的(`$/cancel_request`)要回 -32800 并把弹窗撤下;不认识的
// 请求回 -32601 而不是让 agent 干等。这里只管簿子和答复,弹什么框是应用的事。
import type * as acp from "@agentclientprotocol/sdk/experimental/v2"

/** agent 发来的一条请求,同 Runtime `pendingAgentRequests` 的形状。 */
export type AgentRequest = { id: unknown; method: string; params: unknown }

/** 把答复送回 agent:`acpRespond` 那一条,带原来的 `id`。 */
export type Reply = (id: unknown, result?: unknown, error?: { code: number; message: string }) => void

export type PendingPermission = {
  kind: "permission"
  /** 簿子里的键:JSON-RPC id 的比较键(`9` 与 `"9"` 是两个 id)。 */
  key: string
  id: unknown
  sessionId: string
  /** 要授权的那次工具调用;不是工具调用的授权为 null。 */
  toolCallId: string | null
  params: acp.RequestPermissionRequest
  at: number
}

export type PendingElicitation = {
  kind: "elicitation"
  key: string
  id: unknown
  /** 协议里问卷不一定属于某条会话;alwith-cli 会带 sessionId。 */
  sessionId: string | null
  /** url 模式必有;form 模式协议没有,alwith-cli 顺手带一个。没有就按 key 回答。 */
  elicitationId: string | null
  params: acp.CreateElicitationRequest
  at: number
}

export type PendingRequest = PendingPermission | PendingElicitation

/** JSON-RPC:对已被 `$/cancel_request` 撤回的请求 MUST 回这个(或有效响应)。 */
export const REQUEST_CANCELLED = -32800
export const METHOD_NOT_FOUND = -32601

export function requestKey(id: unknown): string {
  return JSON.stringify(id) ?? String(id)
}

export class AgentRequests {
  private readonly items = new Map<string, PendingRequest>()
  private readonly changed = new Set<(pending: PendingRequest[]) => void>()
  private readonly received = new Set<(request: PendingRequest) => void>()
  private readonly withdrawn = new Set<(request: PendingRequest) => void>()
  private readonly reply: Reply

  constructor(reply: Reply) {
    this.reply = reply
  }

  list(): PendingRequest[] {
    return [...this.items.values()]
  }

  forSession(sessionId: string): PendingRequest[] {
    return this.list().filter(request => request.sessionId === sessionId)
  }

  get(key: string): PendingRequest | undefined {
    return this.items.get(key)
  }

  permissionFor(toolCallId: string): PendingPermission | undefined {
    for (const request of this.items.values()) {
      if (request.kind === "permission" && request.toolCallId === toolCallId) return request
    }
    return undefined
  }

  elicitation(elicitationId: string): PendingElicitation | undefined {
    for (const request of this.items.values()) {
      if (request.kind === "elicitation" && request.elicitationId === elicitationId) return request
    }
    return undefined
  }

  /** 簿子变了(新到、答了、撤了、放了):应用据此渲染。 */
  onChange(listener: (pending: PendingRequest[]) => void): () => void {
    this.changed.add(listener)
    return () => this.changed.delete(listener)
  }

  /** 新进簿的一条(刚收到,或接管时重放的):应用据此弹框、开授权页。 */
  onReceived(listener: (request: PendingRequest) => void): () => void {
    this.received.add(listener)
    return () => this.received.delete(listener)
  }

  /** 被 agent 撤回的一条(`$/cancel_request`):原请求已回 -32800,应用把弹窗撤下。 */
  onWithdrawn(listener: (request: PendingRequest) => void): () => void {
    this.withdrawn.add(listener)
    return () => this.withdrawn.delete(listener)
  }

  /**
   * 收一条 agent 请求。权限与问卷记进簿子;其它(fs、terminal…)本应用不做,回 -32601 —— 不回
   * agent 就卡在那条请求上。接管时 Runtime 交来的 `pendingAgentRequests` 也从这里进,当作刚收到。
   */
  receive(request: AgentRequest): void {
    const key = requestKey(request.id)
    if (request.method === "session/request_permission") {
      const params = request.params as acp.RequestPermissionRequest
      // sessionId 协议必填:缺了没法按会话整批取消,直接炸出来而不是记一条无主的
      if (typeof params?.sessionId !== "string") throw new Error(`session/request_permission 缺 sessionId: ${key}`)
      const subject = params.subject as { type?: string; toolCall?: { toolCallId?: unknown } } | undefined
      const toolCallId = typeof subject?.toolCall?.toolCallId === "string" ? subject.toolCall.toolCallId : null
      const pending: PendingPermission = { kind: "permission", key, id: request.id, sessionId: params.sessionId, toolCallId, params, at: Date.now() }
      this.items.set(key, pending)
      this.emit()
      for (const listener of [...this.received]) listener(pending)
      return
    }
    if (request.method === "elicitation/create") {
      const params = request.params as acp.CreateElicitationRequest & { sessionId?: unknown; elicitationId?: unknown }
      const pending: PendingElicitation = {
        kind: "elicitation",
        key,
        id: request.id,
        sessionId: typeof params?.sessionId === "string" ? params.sessionId : null,
        elicitationId: typeof params?.elicitationId === "string" ? params.elicitationId : null,
        params,
        at: Date.now()
      }
      this.items.set(key, pending)
      this.emit()
      for (const listener of [...this.received]) listener(pending)
      return
    }
    this.reply(request.id, undefined, { code: METHOD_NOT_FOUND, message: `method not found: ${request.method}` })
  }

  receiveAll(requests: AgentRequest[]): void {
    for (const request of requests) this.receive(request)
  }

  /** 回答一条,按簿子里的键。已经不在簿子上(答过、被撤、被放)返回 false,什么都不发。 */
  answer(key: string, result: unknown): boolean {
    const request = this.items.get(key)
    if (request === undefined) return false
    this.items.delete(key)
    this.reply(request.id, result)
    this.emit()
    return true
  }

  answerPermission(
    toolCallId: string,
    outcome: acp.RequestPermissionOutcome,
    meta?: Record<string, unknown> | null
  ): boolean {
    const request = this.permissionFor(toolCallId)
    if (request === undefined) return false
    return this.answer(request.key, meta ? { outcome, _meta: meta } : { outcome })
  }

  /**
   * agent 的通知里与簿子有关的两条:
   * - `$/cancel_request`:agent 撤回自己发的请求(session/cancel 会级联撤权限与问卷)。规范:接收方
   *   MUST 对原请求回有效响应或 -32800。这里回 -32800、出簿、通知应用撤弹窗。认不出的 id 是空操作
   *   (原请求可能已经答过了 —— Stop 路径先回 cancelled 再发 session/cancel 时就是这样)。
   * - `elicitation/complete`:url 模式的问卷在 agent 那边完成了。还挂在簿子上的(应用没答)就替它
   *   收掉 —— 用户已经在浏览器里做完了,再问是对着空气问。
   */
  onNotification(method: string, params: unknown): void {
    if (method === "$/cancel_request") {
      const requestId = (params as { requestId?: unknown } | undefined)?.requestId
      if (requestId === undefined) throw new Error("$/cancel_request 缺 requestId")
      const key = requestKey(requestId)
      const request = this.items.get(key)
      if (request === undefined) return
      this.items.delete(key)
      this.reply(request.id, undefined, { code: REQUEST_CANCELLED, message: "Request cancelled" })
      for (const listener of this.withdrawn) listener(request)
      this.emit()
      return
    }
    if (method === "elicitation/complete") {
      const elicitationId = (params as { elicitationId?: unknown } | undefined)?.elicitationId
      if (typeof elicitationId !== "string") return
      const request = this.elicitation(elicitationId)
      if (request !== undefined) this.answer(request.key, { action: "cancel" })
    }
  }

  /**
   * 用户停了这一轮(Stop):这条会话所有没答的权限回 cancelled(规范原文 "The Client MUST respond
   * to all pending session/request_permission requests with the cancelled outcome"),问卷回 cancel
   * —— cancel 是「客户端自己没法继续了」,decline 是「用户不想答」,协议分开两个词。
   */
  cancelSession(sessionId: string): void {
    for (const request of this.forSession(sessionId)) {
      this.items.delete(request.key)
      this.reply(request.id, request.kind === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" })
    }
    this.emit()
  }

  /**
   * 不再持有这些请求,一条都不回答:进程交给别的窗口接管(它会从 Runtime 拿到同一批重放),或者
   * 进程已经没了(答了也送不到)。返回放掉的那些,应用据此撤弹窗。
   */
  release(): PendingRequest[] {
    const released = this.list()
    this.items.clear()
    this.emit()
    return released
  }

  private emit(): void {
    const pending = this.list()
    for (const listener of this.changed) listener(pending)
  }
}
