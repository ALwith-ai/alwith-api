import { describe, expect, test } from "bun:test"
import { AgentGoneError, Agents, RequestCancelledError } from "../agents"
import type {
  RuntimeAcpAgentRequest,
  RuntimeAcpNotification,
  RuntimeAgentInfo,
  RuntimeAttachInfo,
  RuntimeClient,
  RuntimeExitPayload
} from "../../runtime"

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** 只做 Agents 会碰的那几条:起停、接管、握手、ACP 三个动词、三条订阅。其余不实现。 */
class FakeRuntime implements Partial<RuntimeClient<{ engine: string }>> {
  readonly calls: string[] = []
  running = new Set<string>()
  attachable = new Map<string, RuntimeAttachInfo>()
  /** 请求 → 答复;按 method 脚本化,默认原样回 params。 */
  answer: (method: string, params: unknown) => unknown = (_method, params) => params
  private readonly notificationHandlers = new Set<(n: RuntimeAcpNotification) => void>()
  private readonly requestHandlers = new Set<(r: RuntimeAcpAgentRequest) => void>()
  private readonly exitHandlers = new Set<(e: RuntimeExitPayload) => void>()
  readonly responded: Array<{ agentId: string; id: unknown; result?: unknown; error?: unknown }> = []
  readonly notified: Array<{ agentId: string; method: string; params: unknown }> = []
  /** 悬着不答的请求,测试自己决定何时答。 */
  hang = new Set<string>()
  private readonly hung: Array<{ resolve: (v: unknown) => void }> = []

  async start(agentId: string): Promise<void> {
    this.calls.push(`start ${agentId}`)
    if (this.running.has(agentId)) throw new Error(`agent ${agentId} is still running`)
    this.running.add(agentId)
  }
  async stop(agentId: string): Promise<void> {
    this.calls.push(`stop ${agentId}`)
    this.running.delete(agentId)
    // Runtime 的 exit 事件在清理之后才来
    queueMicrotask(() => this.exit(agentId))
  }
  exit(agentId: string): void {
    this.running.delete(agentId)
    for (const handler of this.exitHandlers) handler({ agentId })
  }
  async agents(): Promise<RuntimeAgentInfo[]> {
    return [...this.running].map(agentId => ({ agentId, pid: 1, provider: "", model: "", connection: "", cpu: 0, memMb: 0, uptimeSecs: 0 }))
  }
  async attachSession(sessionId: string): Promise<RuntimeAttachInfo | null> {
    this.calls.push(`attach ${sessionId}`)
    return this.attachable.get(sessionId) ?? null
  }
  async releaseSession(sessionId: string): Promise<void> {
    this.calls.push(`release ${sessionId}`)
  }
  acpRequest<T>(agentId: string, method: string, params?: unknown): Promise<T> {
    if (method === "initialize") {
      this.calls.push(`initialize ${agentId} ${(params as { info: { name: string } }).info.name}`)
      return Promise.resolve({ protocolVersion: 2, info: { name: "fake-agent", version: "1" } } as T)
    }
    this.calls.push(`request ${agentId} ${method}`)
    if (this.hang.has(method)) return new Promise<T>(resolve => this.hung.push({ resolve: resolve as (v: unknown) => void }))
    return Promise.resolve(this.answer(method, params) as T)
  }
  async acpNotify(agentId: string, method: string, params?: unknown): Promise<void> {
    this.notified.push({ agentId, method, params })
  }
  async acpRespond(agentId: string, id: unknown, result?: unknown, error?: unknown): Promise<void> {
    this.responded.push({ agentId, id, result, error })
  }
  async onAcpNotification(handler: (n: RuntimeAcpNotification) => void): Promise<() => void> {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }
  async onAcpAgentRequest(handler: (r: RuntimeAcpAgentRequest) => void): Promise<() => void> {
    this.requestHandlers.add(handler)
    return () => this.requestHandlers.delete(handler)
  }
  async onExit(handler: (e: RuntimeExitPayload) => void): Promise<() => void> {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }
  emitNotification(agentId: string, method: string, params: unknown): void {
    for (const handler of this.notificationHandlers) handler({ agentId, method, params })
  }
  emitRequest(agentId: string, id: unknown, method: string, params: unknown): void {
    for (const handler of this.requestHandlers) handler({ agentId, id, method, params })
  }
  answerHung(value: unknown): void {
    this.hung.shift()?.resolve(value)
  }
  get listeners(): number {
    return this.notificationHandlers.size + this.requestHandlers.size + this.exitHandlers.size
  }
}

const handshake = { info: { name: "test-app", version: "0" } }

function make() {
  const runtime = new FakeRuntime()
  const agents = new Agents<{ engine: string }>(runtime as unknown as RuntimeClient<{ engine: string }>, handshake)
  return { runtime, agents }
}

describe("起与接管", () => {
  test("start:起进程、握手一次、只收自己这个 agent 的通知与请求", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" }, "alwith")
    expect(runtime.calls).toEqual(["start a1", "initialize a1 test-app"])
    expect(agent.initialized).toMatchObject({ info: { name: "fake-agent" } })
    const seen: string[] = []
    agent.onNotification(method => seen.push(method))
    agent.onAgentRequest(request => seen.push(`req ${request.method}`))
    runtime.emitNotification("a1", "session/update", {})
    runtime.emitNotification("other", "session/update", {})
    runtime.emitRequest("a1", 1, "session/request_permission", {})
    expect(seen).toEqual(["session/update", "req session/request_permission"])
  })

  test("同一个 agentId 还活着时再 start 被 Runtime 拒绝;replace 是停、等退出、再起", async () => {
    const { runtime, agents } = make()
    const first = await agents.start("a1", { engine: "alwith" })
    await expect(agents.start("a1", { engine: "dsh" })).rejects.toThrow("still running")
    const second = await agents.replace("a1", { engine: "dsh" }, "dsh")
    expect(first.alive).toBe(false)
    expect(second.alive).toBe(true)
    expect(second.engine).toBe("dsh")
    // 被拒的那次 start 也到了 Runtime(是它拒的),所以记了两笔 start 再 stop
    expect(runtime.calls.filter(c => !c.startsWith("initialize"))).toEqual(["start a1", "start a1", "stop a1", "start a1"])
  })

  test("attach:Runtime 里有活的就接管,握手走缓存,交回没答的请求;没有就是 null", async () => {
    const { runtime, agents } = make()
    const pending = [{ id: 7, method: "session/request_permission", params: {} }]
    runtime.attachable.set("s1", { agentId: "live", engine: "alwith", provider: "anthropic", pendingAgentRequests: pending })
    runtime.running.add("live")
    const attached = await agents.attach("s1")
    expect(attached?.agent.agentId).toBe("live")
    expect(attached?.agent.engine).toBe("alwith")
    expect(attached?.info.pendingAgentRequests).toBe(pending)
    expect(agents.get("live")).toBe(attached?.agent)
    expect(await agents.attach("nobody")).toBeNull()
  })

  test("接管到已经持有的 agent 不重复握手", async () => {
    const { runtime, agents } = make()
    runtime.attachable.set("s1", { agentId: "live", engine: "alwith", provider: "", pendingAgentRequests: [] })
    runtime.attachable.set("s2", { agentId: "live", engine: "alwith", provider: "", pendingAgentRequests: [] })
    const one = await agents.attach("s1")
    const two = await agents.attach("s2")
    expect(two?.agent).toBe(one?.agent)
    expect(runtime.calls.filter(c => c.startsWith("initialize"))).toHaveLength(1)
  })
})

describe("请求", () => {
  test("agent 退出时在飞的请求立刻失败,不永挂;之后不再收它的事件", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" })
    runtime.hang.add("session/prompt")
    const turn = agent.request("session/prompt", {})
    const exits: string[] = []
    agents.onExit(a => exits.push(a.agentId))
    runtime.exit("a1")
    await expect(turn).rejects.toBeInstanceOf(AgentGoneError)
    await flush()
    expect(exits).toEqual(["a1"])
    expect(agent.alive).toBe(false)
    expect(agents.get("a1")).toBeUndefined()
    expect(runtime.listeners).toBe(0)
  })

  test("stop 等到 exit 才算停完;停掉的不算崩溃", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" })
    const exits: string[] = []
    agents.onExit(a => exits.push(a.agentId))
    await agent.stop()
    expect(agent.alive).toBe(false)
    expect(runtime.running.has("a1")).toBe(false)
    await flush()
    // 自己停的也算进程没了:exited resolve、持有表里摘掉、onExit 照发 —— 是不是主动的应用自己知道
    expect(agents.get("a1")).toBeUndefined()
    expect(exits).toEqual(["a1"])
  })

  test("detach:放手不停进程,在飞的失败,进程还在 Runtime 里", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" })
    runtime.hang.add("session/prompt")
    const turn = agent.request("session/prompt", {})
    agents.release(agent)
    await expect(turn).rejects.toBeInstanceOf(AgentGoneError)
    expect(runtime.running.has("a1")).toBe(true)
    expect(runtime.calls).not.toContain("stop a1")
    expect(agents.get("a1")).toBeUndefined()
  })

  test("带 signal 的请求:abort 后发 $/cancel_request 并本地立即失败,迟到的答复被丢", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" })
    runtime.hang.add("_alwith/login")
    const controller = new AbortController()
    const login = agent.request("_alwith/login", {}, { signal: controller.signal })
    controller.abort()
    await expect(login).rejects.toBeInstanceOf(RequestCancelledError)
    expect(runtime.notified).toEqual([{ agentId: "a1", method: "$/cancel_request", params: { requestId: expect.stringMatching(/^app-/) } }])
    runtime.answerHung({ ok: true })
    await flush()
  })

  test("respond 带原来的 id 回给 agent", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" })
    await agent.respond(9, { outcome: { outcome: "cancelled" } })
    expect(runtime.responded).toEqual([{ agentId: "a1", id: 9, result: { outcome: { outcome: "cancelled" } }, error: undefined }])
  })
})

describe("Runtime 故障", () => {
  test("fail:在飞的立刻失败,agent 仍持有,之后还能发", async () => {
    const { runtime, agents } = make()
    const agent = await agents.start("a1", { engine: "alwith" })
    runtime.hang.add("session/prompt")
    const turn = agent.request("session/prompt", {})
    expect(agent.inflightCount).toBe(1)
    agent.fail("disk full")
    await expect(turn).rejects.toThrow("disk full")
    expect(agent.alive).toBe(true)
    expect(agent.inflightCount).toBe(0)
    runtime.hang.delete("session/prompt")
    await expect(agent.request("session/prompt", { ok: 1 })).resolves.toEqual({ ok: 1 })
  })
})
