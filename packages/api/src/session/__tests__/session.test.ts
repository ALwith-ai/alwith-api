import { describe, expect, test } from "bun:test"
import { isText, textOf } from "../blocks"
import { addPrompt, applyUpdate, createSession, terminalOf } from "../session"
import { SessionStore } from "../store"

function text(session: ReturnType<typeof createSession>, index = 0): string {
  const item = session.items[index]
  if (!item || (item.kind !== "assistant" && item.kind !== "user" && item.kind !== "thought")) return ""
  const block = item.content[0]
  return block !== undefined && isText(block) ? block.text : ""
}

describe("ACP transcript", () => {
  test("same item IDs remain isolated across interleaved sessions", () => {
    const store = new SessionStore()
    for (const id of ["a", "b"]) store.set(createSession(id, "/tmp"))
    for (const [id, value] of [
      ["a", "A"],
      ["b", "B"],
      ["a", "1"],
      ["b", "2"]
    ] as const) {
      store.accept(id, {
        sessionUpdate: "agent_message_chunk",
        messageId: "same",
        content: { type: "text", text: value }
      })
    }
    expect(text(store.get("a"))).toBe("A1")
    expect(text(store.get("b"))).toBe("B2")
    store.accept("a", {
      sessionUpdate: "state_update",
      state: "requires_action"
    })
    expect(store.get("b").state).toBe("idle")
  })

  test("a full agent_message replaces accumulated chunks and later chunks append", () => {
    let session = createSession("a", "/tmp")
    session = applyUpdate(session, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m",
      content: { type: "text", text: "par" }
    })
    session = applyUpdate(session, {
      sessionUpdate: "agent_message",
      messageId: "m",
      content: [{ type: "text", text: "partial" }]
    })
    session = applyUpdate(session, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m",
      content: { type: "text", text: "!" }
    })
    expect(session.items).toHaveLength(1)
    expect(text(session)).toBe("partial!")
  })

  test("updates never mutate the previous session object", () => {
    const before = createSession("a", "/tmp")
    const after = applyUpdate(before, {
      sessionUpdate: "agent_message_chunk",
      messageId: "m",
      content: { type: "text", text: "x" }
    })
    expect(before.items).toHaveLength(0)
    expect(after.items).toHaveLength(1)
    expect(after).not.toBe(before)
  })

  test("tool upserts keep omitted fields and clear explicit nulls", () => {
    let session = createSession("a", "/tmp")
    session = applyUpdate(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      name: "shell",
      title: "ls -la",
      kind: "execute",
      status: "in_progress",
      rawInput: { command: "ls" }
    })
    session = applyUpdate(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      status: "completed",
      rawOutput: "ok"
    })
    const tool = session.items[0]
    if (tool?.kind !== "tool") throw new Error("expected a tool item")
    expect(tool.title).toBe("ls -la")
    expect(tool.status).toBe("completed")
    expect(tool.rawInput).toEqual({ command: "ls" })
    expect(tool.rawOutput).toBe("ok")
    session = applyUpdate(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      title: null
    })
    expect((session.items[0] as typeof tool).title).toBeNull()
  })

  test("失败的回合保留 stopReason 与原始 _meta,直到下一轮开跑", () => {
    let session = createSession("a", "/tmp")
    session = applyUpdate(session, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "_error",
      _meta: {
        codex: {
          error: { message: "boom", category: "network", retryable: true }
        }
      }
    })
    // 包只说协议知道的那件事:这一轮以 `_error` 收尾,`_meta` 原样带出。
    // 「boom / network / 可重试」是 codex 的方言,由应用自己去读。
    expect(session.error).toEqual({
      stopReason: "_error",
      meta: { codex: { error: { message: "boom", category: "network", retryable: true } } }
    })
    session = applyUpdate(session, {
      sessionUpdate: "state_update",
      state: "running"
    })
    expect(session.error).toBeNull()
  })

  test("plans upsert by id and can be removed", () => {
    let session = createSession("a", "/tmp")
    session = applyUpdate(session, {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "p",
        entries: [{ content: "step", priority: "medium", status: "pending" }]
      }
    })
    session = applyUpdate(session, {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "p",
        entries: [{ content: "step", priority: "medium", status: "completed" }]
      }
    })
    expect(session.items).toHaveLength(1)
    session = applyUpdate(session, {
      sessionUpdate: "plan_removed",
      planId: "p"
    })
    expect(session.items).toHaveLength(0)
  })
})

describe("没带 messageId 的 chunk", () => {
  test("紧挨着的同类消息并进去,中间隔了别的就另起一条 —— 后面的话不能跑到工具前面去", () => {
    let session = createSession("s", "/tmp")
    const feed = (update: Record<string, unknown>) => (session = applyUpdate(session, update as never))
    feed({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "先读" } })
    feed({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "文件" } })
    feed({ sessionUpdate: "tool_call_update", toolCallId: "t", name: "Read", status: "completed" })
    feed({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "再搜" } })
    feed({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } })
    const shape = session.items.map(item =>
      item.kind === "user" || item.kind === "assistant" || item.kind === "thought"
        ? `${item.kind}:${textOf(item.content)}`
        : item.kind
    )
    expect(shape).toEqual([
      "thought:先读文件",
      "tool",
      "thought:再搜",
      "assistant:完成"
    ])
  })

  test("不并进本地先上屏的那条用户消息", () => {
    let session = addPrompt(createSession("s", "/tmp"), [{ type: "text", text: "hi" }], "local")
    session = applyUpdate(session, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "x" } } as never)
    expect(session.items).toHaveLength(2)
    expect(session.items[0]?.id).toBe("local")
  })
})

describe("工具的终端", () => {
  test("按产出里的 terminal 引用找,不按工具 id 猜", () => {
    let session = createSession("s", "/tmp")
    const feed = (update: Record<string, unknown>) => (session = applyUpdate(session, update as never))
    feed({ sessionUpdate: "tool_call_update", toolCallId: "call-1", name: "Bash", content: [{ type: "terminal", terminalId: "term-9" }] })
    feed({ sessionUpdate: "terminal_update", terminalId: "term-9", command: "ls" })
    feed({ sessionUpdate: "terminal_update", terminalId: "call-1", command: "decoy" })
    const tool = session.items.find(item => item.kind === "tool")
    expect(tool?.kind === "tool" ? terminalOf(tool, session.terminals)?.command : null).toBe("ls")
  })

  test("没有引用、或引用的终端还没到,就是 null", () => {
    let session = createSession("s", "/tmp")
    session = applyUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "call-1", name: "Read" } as never)
    const tool = session.items[0]
    expect(tool?.kind === "tool" ? terminalOf(tool, session.terminals) : undefined).toBeNull()
  })
})
