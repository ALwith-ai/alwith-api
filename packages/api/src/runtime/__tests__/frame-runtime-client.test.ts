import { describe, expect, test } from "bun:test"
import { FrameRuntimeClient } from "../frame-runtime-client"
import { RuntimeErrorCode } from "../types"

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

/** A transport that records writes and lets the test push frames back. */
class MemoryPort extends FrameRuntimeClient<{ engine: string }> {
  readonly written: string[] = []
  connects = 0
  failWrites = false

  protected async connectTransport(): Promise<void> {
    this.connects += 1
  }

  protected write(text: string): void {
    if (this.failWrites) throw new Error("pipe closed")
    this.written.push(text)
  }

  push(frame: unknown): void {
    this.receive(JSON.stringify(frame))
  }

  drop(): void {
    this.rejectPending("runtime exited")
  }
}

describe("FrameRuntimeClient", () => {
  test("请求按 id 配对响应，params 缺省不发送", async () => {
    const port = new MemoryPort()
    const pong = port.ping()
    const events = port.sessionEvents("s1", 7, 10)
    await flush()
    expect(port.written).toEqual([
      JSON.stringify({ id: 1, method: "ping" }),
      JSON.stringify({ id: 2, method: "sessionEvents", params: { sessionId: "s1", afterSequence: 7, limit: 10 } })
    ])
    port.push({ id: 2, result: [{ sequence: 8 }], error: null })
    port.push({ id: 1, result: "pong", error: null })
    await pong
    expect(await events).toMatchObject([{ sequence: 8 }])
    expect(port.connects).toBe(2)
  })

  test("agentForSession 是只读查询:一帧问、一帧答,不认领", async () => {
    const port = new MemoryPort()
    const lookup = port.agentForSession("s1")
    await flush()
    expect(port.written).toEqual([JSON.stringify({ id: 1, method: "agentForSession", params: { sessionId: "s1" } })])
    port.push({ id: 1, result: "agent-1", error: null })
    expect(await lookup).toBe("agent-1")
  })

  test("错误响应变成 RuntimeRequestError，写失败也一样", async () => {
    const port = new MemoryPort()
    const denied = port.send("a", "x")
    await flush()
    port.push({ id: 1, result: null, error: { code: -32000, message: "not owned" } })
    await expect(denied).rejects.toMatchObject({ name: "RuntimeRequestError", method: "send", code: -32000, reason: "not owned" })
    port.failWrites = true
    await expect(port.ping()).rejects.toMatchObject({ code: RuntimeErrorCode.connectionLost, message: "ping: pipe closed" })
  })

  test("事件按 type 分发，传输断开拒绝全部在飞请求", async () => {
    const port = new MemoryPort()
    const lines: unknown[] = []
    const states: unknown[] = []
    const custom: unknown[] = []
    await port.onInbound(payload => lines.push(payload))
    await port.onRunStates(sessions => states.push(sessions))
    port.onEvent("lagged", event => custom.push(event))
    port.push({ type: "inbound", agentId: "a", lines: ["{}"] })
    port.push({ type: "runStates", sessions: [] })
    port.push({ type: "lagged", dropped: 3 })
    expect(lines).toEqual([{ agentId: "a", lines: ["{}"] }])
    expect(states).toEqual([[]])
    expect(custom).toEqual([{ type: "lagged", dropped: 3 }])
    const hanging = port.runStates()
    await flush()
    port.drop()
    await expect(hanging).rejects.toThrow("runStates: runtime exited")
  })

  test("the ACP layer: sessionNew / prompt are one frame each, agent notifications and requests fan out", async () => {
    const port = new MemoryPort()
    const notifications: unknown[] = []
    const requests: unknown[] = []
    await port.onAcpNotification(n => notifications.push(n))
    await port.onAcpAgentRequest(r => requests.push(r))
    const session = port.sessionNew("a", "/work", [], { alwith: { maxBudgetUsd: 1 } })
    const turn = port.prompt("a", "s-1", [{ type: "text", text: "hi" }])
    await flush()
    expect(port.written.map(line => JSON.parse(line))).toEqual([
      { id: 1, method: "sessionNew", params: { agentId: "a", cwd: "/work", mcpServers: [], meta: { alwith: { maxBudgetUsd: 1 } } } },
      { id: 2, method: "prompt", params: { agentId: "a", sessionId: "s-1", prompt: [{ type: "text", text: "hi" }] } }
    ])
    port.push({ type: "acpNotification", agentId: "a", method: "session/update", params: { sessionId: "s-1" } })
    port.push({ type: "acpAgentRequest", agentId: "a", id: 77, method: "session/request_permission", params: {} })
    port.push({ id: 1, result: { sessionId: "s-1" }, error: null })
    port.push({ id: 2, result: { stopReason: "end_turn" }, error: null })
    expect(await session).toEqual({ sessionId: "s-1" })
    expect(await turn).toEqual({ stopReason: "end_turn" })
    expect(notifications).toEqual([{ agentId: "a", method: "session/update", params: { sessionId: "s-1" } }])
    expect(requests).toEqual([{ agentId: "a", id: 77, method: "session/request_permission", params: {} }])
    const answered = port.acpRespond("a", 77, { outcome: { outcome: "selected", optionId: "ok" } })
    await flush()
    expect(JSON.parse(port.written[2])).toEqual({
      id: 3,
      method: "acpRespond",
      params: { agentId: "a", id: 77, result: { outcome: { outcome: "selected", optionId: "ok" } } }
    })
    port.push({ id: 3, result: null, error: null })
    await answered
  })
})

describe("按序、不重复:漏帧从日志补齐", () => {
  const update = (sequence: number, text = `t${sequence}`) => ({
    type: "acpNotification",
    agentId: "a",
    method: "session/update",
    params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
    sessionId: "s-1",
    sequence
  })
  const journaled = (sequence: number, text = `t${sequence}`) => ({
    sequence,
    recordedAt: 1,
    direction: "in",
    line: JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }
    })
  })
  const sequencesOf = (events: Array<{ sequence?: number }>) => events.map(event => event.sequence)

  test("序号跳了:先向 Runtime 要中间那段,补完再投后面的", async () => {
    const port = new MemoryPort()
    const seen: Array<{ sequence?: number }> = []
    await port.onAcpNotification(n => seen.push(n))
    port.push(update(0))
    port.push(update(1))
    port.push(update(3))
    await flush()
    expect(sequencesOf(seen)).toEqual([0, 1])
    expect(JSON.parse(port.written[0])).toEqual({ id: 1, method: "sessionEvents", params: { sessionId: "s-1", afterSequence: 1, limit: 2000 } })
    port.push({ id: 1, result: [journaled(2)], error: null })
    await flush()
    await flush()
    expect(sequencesOf(seen)).toEqual([0, 1, 2, 3])
    port.push(update(4))
    expect(sequencesOf(seen)).toEqual([0, 1, 2, 3, 4])
  })

  test("补齐期间到的活帧排在后面,不插队", async () => {
    const port = new MemoryPort()
    const seen: Array<{ sequence?: number }> = []
    await port.onAcpNotification(n => seen.push(n))
    port.push(update(0))
    port.push(update(2))
    await flush()
    port.push(update(3))
    port.push({ id: 1, result: [journaled(1)], error: null })
    await flush()
    await flush()
    expect(sequencesOf(seen)).toEqual([0, 1, 2, 3])
  })

  test("日志里也没有了:报 gap,不装作连续", async () => {
    const port = new MemoryPort()
    const seen: Array<{ sequence?: number }> = []
    const gaps: unknown[] = []
    await port.onAcpNotification(n => seen.push(n))
    port.onGap(gap => gaps.push(gap))
    port.push(update(0))
    port.push(update(5))
    await flush()
    port.push({ id: 1, result: [journaled(4)], error: null })
    await flush()
    await flush()
    expect(gaps).toEqual([{ sessionId: "s-1", from: 1, to: 3 }])
    expect(sequencesOf(seen)).toEqual([0, 4, 5])
  })

  test("lagged:Runtime 说丢了,跟着的每条会话都从最后见到的序号补", async () => {
    const port = new MemoryPort()
    const seen: Array<{ sequence?: number }> = []
    await port.onAcpNotification(n => seen.push(n))
    port.push(update(0))
    port.push({ type: "lagged", dropped: 2 })
    await flush()
    expect(JSON.parse(port.written[0])).toMatchObject({ method: "sessionEvents", params: { sessionId: "s-1", afterSequence: 0 } })
    port.push({ id: 1, result: [journaled(1), journaled(2)], error: null })
    await flush()
    await flush()
    port.push(update(3))
    expect(sequencesOf(seen)).toEqual([0, 1, 2, 3])
  })

  test("重复的丢掉;序号从 0 重来是引擎重放了历史,照收", () => {
    const port = new MemoryPort()
    const seen: Array<{ sequence?: number }> = []
    void port.onAcpNotification(n => seen.push(n))
    port.push(update(0))
    port.push(update(1))
    port.push(update(1))
    port.push(update(0))
    port.push(update(1))
    expect(sequencesOf(seen)).toEqual([0, 1, 0, 1])
  })

  test("日志里的 out 帧与请求帧按原样投给对应的订阅", async () => {
    const port = new MemoryPort()
    const outbound: unknown[] = []
    const requests: unknown[] = []
    await port.onAcpNotification(() => undefined)
    await port.onOutbound(line => outbound.push(line))
    await port.onAcpAgentRequest(r => requests.push(r))
    port.push(update(0))
    port.push(update(3))
    await flush()
    const prompt = JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } })
    const permission = JSON.stringify({ jsonrpc: "2.0", id: 10, method: "session/request_permission", params: { sessionId: "s-1" } })
    port.push({
      id: 1,
      result: [
        { sequence: 1, recordedAt: 1, direction: "out", line: prompt },
        { sequence: 2, recordedAt: 1, direction: "in", line: permission }
      ],
      error: null
    })
    await flush()
    await flush()
    expect(outbound).toEqual([{ agentId: "a", line: prompt, sessionId: "s-1", sequence: 1 }])
    expect(requests).toEqual([{ agentId: "a", id: 10, method: "session/request_permission", params: { sessionId: "s-1" }, sessionId: "s-1", sequence: 2 }])
  })
})
