// Ported from ALwith Desktop's web host port tests; only the core protocol cases apply here.
import { afterEach, describe, expect, mock, test } from "bun:test"

import { WebSocketRuntimeClient } from "../websocket-runtime-client"

type Listener = (event: { data?: string }) => void

class MemoryWebSocket {
  static readonly OPEN = 1
  static instance: MemoryWebSocket
  static instances: MemoryWebSocket[] = []
  readonly sent: string[] = []
  readonly protocols: string[]
  readyState = 0
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(
    readonly url: string,
    protocols: string[]
  ) {
    this.protocols = protocols
    MemoryWebSocket.instance = this
    MemoryWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MemoryWebSocket.OPEN
    this.emit("open", {})
  }

  receive(payload: unknown): void {
    this.emit("message", { data: JSON.stringify(payload) })
  }

  close(): void {
    this.readyState = 3
    this.emit("close", {})
  }

  private emit(type: string, event: { data?: string }): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

const realWebSocket = globalThis.WebSocket

function stubWebSocket(): void {
  globalThis.WebSocket = MemoryWebSocket as unknown as typeof WebSocket
}

async function waitFor(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      check()
      return
    } catch (error) {
      if (Date.now() > deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

afterEach(() => {
  MemoryWebSocket.instances = []
  globalThis.WebSocket = realWebSocket
})

describe("WebSocketRuntimeClient", () => {
  test("会话标题交给 Runtime 同步，拒绝时保留错误", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const request = port.setSessionTitle("session-1", "券核销")
    const socket = MemoryWebSocket.instance
    socket.open()
    await waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      id: 1,
      method: "setSessionTitle",
      params: { sessionId: "session-1", title: "券核销" }
    })
    socket.receive({ id: 1, result: null, error: null })
    await expect(request).resolves.toBeUndefined()
    const rejected = port.setSessionTitle("session-1", "退款")
    rejected.catch(() => undefined)
    await waitFor(() => expect(socket.sent).toHaveLength(2))
    socket.receive({ id: 2, result: null, error: { code: -32000, message: "title rejected" } })
    await expect(rejected).rejects.toThrow("title rejected")
  })

  test("使用鉴权子协议发送请求并按 id 配对响应", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const request = port.runStates()
    const socket = MemoryWebSocket.instance
    expect(socket.protocols).toEqual(["alwith-runtime-v1", "alwith-auth.secret"])
    socket.open()
    await waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({ id: 1, method: "runStates" })
    socket.receive({ id: 1, result: [], error: null })
    await expect(request).resolves.toEqual([])
  })

  test("sessionEvents 带分页参数发送", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const request = port.sessionEvents("session-1", 7, 50)
    const socket = MemoryWebSocket.instance
    socket.open()
    await waitFor(() => expect(socket.sent).toHaveLength(1))
    expect(JSON.parse(socket.sent[0]!)).toEqual({
      id: 1,
      method: "sessionEvents",
      params: { sessionId: "session-1", afterSequence: 7, limit: 50 }
    })
    socket.receive({ id: 1, result: [], error: null })
    await expect(request).resolves.toEqual([])
  })

  test("批量分发 lines、exit、stderr 与 runStates 事件", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const lines = mock()
    const exits = mock()
    const stderr = mock()
    const runStates = mock()
    const linesListener = port.onInbound(lines)
    MemoryWebSocket.instance.open()
    await linesListener
    await port.onExit(exits)
    await port.onStderr(stderr)
    await port.onRunStates(runStates)

    MemoryWebSocket.instance.receive({ type: "inbound", agentId: "agent", lines: ["one", "two"] })
    MemoryWebSocket.instance.receive({ type: "exit", agentId: "agent" })
    MemoryWebSocket.instance.receive({ type: "stderr", agentId: "agent", line: "warn" })
    MemoryWebSocket.instance.receive({ type: "runStates", sessions: [] })

    expect(lines).toHaveBeenCalledWith({ agentId: "agent", lines: ["one", "two"] })
    expect(exits).toHaveBeenCalledWith({ agentId: "agent" })
    expect(stderr).toHaveBeenCalledWith({ agentId: "agent", line: "warn" })
    expect(runStates).toHaveBeenCalledWith([])
  })

  test("宿主扩展事件按 type 分发给 onEvent", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const custom = mock()
    const unsubscribe = port.onEvent("fsChanged", custom)
    const subscription = port.onRunStates(mock())
    MemoryWebSocket.instance.open()
    await subscription
    MemoryWebSocket.instance.receive({ type: "fsChanged", watcherId: "w", paths: ["/a"] })
    expect(custom).toHaveBeenCalledWith({ type: "fsChanged", watcherId: "w", paths: ["/a"] })
    unsubscribe()
    MemoryWebSocket.instance.receive({ type: "fsChanged", watcherId: "w", paths: ["/b"] })
    expect(custom).toHaveBeenCalledTimes(1)
  })

  test("连接断开会拒绝全部在飞请求", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const request = port.runStates()
    request.catch(() => undefined)
    MemoryWebSocket.instance.open()
    await waitFor(() => expect(MemoryWebSocket.instance.sent).toHaveLength(1))
    MemoryWebSocket.instance.close()
    await expect(request).rejects.toThrow("Runtime WebSocket disconnected")
  })

  test("Runtime 重启后自动重连并恢复 runStates 订阅", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const runStates = mock()
    const reconnected = mock()
    port.onReconnect(reconnected)
    const subscription = port.onRunStates(runStates)
    MemoryWebSocket.instance.open()
    await subscription

    MemoryWebSocket.instance.close()
    await waitFor(() => expect(MemoryWebSocket.instances).toHaveLength(2))
    const replacement = MemoryWebSocket.instance
    replacement.open()
    await waitFor(() => expect(replacement.sent).toHaveLength(1))
    expect(JSON.parse(replacement.sent[0]!)).toEqual({ id: 1, method: "runStates" })
    replacement.receive({ id: 1, result: [], error: null })
    await waitFor(() => expect(runStates).toHaveBeenCalledWith([]))
    expect(reconnected).toHaveBeenCalledTimes(1)
    port.close()
  })

  test("没有订阅时断开不重连", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    const request = port.runStates()
    MemoryWebSocket.instance.open()
    await waitFor(() => expect(MemoryWebSocket.instance.sent).toHaveLength(1))
    MemoryWebSocket.instance.receive({ id: 1, result: [], error: null })
    await request
    MemoryWebSocket.instance.close()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(MemoryWebSocket.instances).toHaveLength(1)
  })

  test("close 之后拒绝新请求", async () => {
    stubWebSocket()
    const port = new WebSocketRuntimeClient("ws://127.0.0.1", "secret")
    port.close()
    const request = port.runStates()
    request.catch(() => undefined)
    await expect(request).rejects.toThrow("Runtime port is closed")
  })
})
