import { describe, expect, test } from "bun:test"
import { addPrompt, applyUpdate, createSession, type MessageItem, type ToolItem } from "../session"
import { SessionStore } from "../store"

function apply(session: ReturnType<typeof createSession>, update: Record<string, unknown>) {
  return applyUpdate(session, update as never)
}

function item<T extends MessageItem | ToolItem>(session: ReturnType<typeof createSession>, id: string): T {
  const found = session.items.find(entry => entry.id === id)
  if (!found) throw new Error(`no item ${id}`)
  return found as T
}

describe("_meta 跨帧累积", () => {
  test("同一条目多帧的 _meta 逐层合并,后到的键覆盖先到的 —— 芯把条目级的事实摊在不同帧上发", () => {
    let session = createSession("s", "/tmp")
    session = apply(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      name: "Bash",
      status: "pending",
      _meta: { alwith: { runInBackground: true }, claudeCode: { toolName: "Bash" } }
    })
    session = apply(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      _meta: { alwith: { terminalDisplay: { command: "sleep 5" } } }
    })
    expect(item<ToolItem>(session, "t")._meta).toEqual({
      alwith: { runInBackground: true, terminalDisplay: { command: "sleep 5" } },
      claudeCode: { toolName: "Bash" }
    })
  })

  test("消息的多个 chunk 同样累积:uuid 在末帧、model 在首帧,两样都留下", () => {
    let session = createSession("s", "/tmp")
    const chunk = (text: string, _meta: Record<string, unknown>) =>
      apply(session, {
        sessionUpdate: "agent_message_chunk",
        messageId: "m",
        content: { type: "text", text },
        _meta
      })
    session = chunk("你", { alwith: { model: "opus" } })
    session = chunk("好", { alwith: { uuid: "u-1" } })
    expect(item<MessageItem>(session, "m")._meta).toEqual({ alwith: { model: "opus", uuid: "u-1" } })
  })

  test("帧上缺省或显式 null 都不动已有的 _meta;标量与数组整个替换", () => {
    let session = createSession("s", "/tmp")
    session = apply(session, {
      sessionUpdate: "tool_call_update",
      toolCallId: "t",
      name: "Read",
      _meta: { alwith: { tags: ["a"], n: 1 } }
    })
    session = apply(session, { sessionUpdate: "tool_call_update", toolCallId: "t", status: "in_progress" })
    session = apply(session, { sessionUpdate: "tool_call_update", toolCallId: "t", _meta: null })
    expect(item<ToolItem>(session, "t")._meta).toEqual({ alwith: { tags: ["a"], n: 1 } })
    session = apply(session, { sessionUpdate: "tool_call_update", toolCallId: "t", _meta: { alwith: { tags: ["b"], n: 2 } } })
    expect(item<ToolItem>(session, "t")._meta).toEqual({ alwith: { tags: ["b"], n: 2 } })
  })

  test("计划与压缩条目也带 _meta —— alwith-cli 把落盘的时间戳与 compact_metadata 放在那里", () => {
    let session = createSession("s", "/tmp")
    session = apply(session, {
      sessionUpdate: "compaction_update",
      compactionId: "c",
      status: "completed",
      _meta: { alwith: { timestamp: "2026-09-14T00:00:00Z", compactMetadata: { pre_tokens: 120000 } } }
    })
    expect(item(session, "c")._meta).toEqual({
      alwith: { timestamp: "2026-09-14T00:00:00Z", compactMetadata: { pre_tokens: 120000 } }
    })
  })
})

describe("本地先上屏的用户消息与 agent 回报的认领", () => {
  test("addPrompt 立刻放一条 pending 的用户消息,内容就是用户发的", () => {
    const session = addPrompt(createSession("s", "/tmp"), [{ type: "text", text: "hi" }], "local-1")
    const prompt = item<MessageItem>(session, "local-1")
    expect(prompt.kind).toBe("user")
    expect(prompt.echo).toBe("pending")
    expect(prompt.replayed).toBe(false)
  })

  test("agent 回报时只认领 id,不另起一条,本地内容是权威(mention / 图片形态都对)", () => {
    let session = addPrompt(createSession("s", "/tmp"), [{ type: "text", text: "@file hi" }], "local-1")
    session = apply(session, {
      sessionUpdate: "user_message",
      messageId: "agent-7",
      content: [{ type: "text", text: "Resource link: name=file, uri=file:///f\nhi" }],
      _meta: { alwith: { uuid: "u-7" } }
    })
    expect(session.items).toHaveLength(1)
    const prompt = item<MessageItem>(session, "agent-7")
    expect(prompt.echo).toBe("adopted")
    expect(prompt.content).toEqual([{ type: "text", text: "@file hi" }])
    expect(prompt._meta).toEqual({ alwith: { uuid: "u-7" } })
  })

  test("认领之后同 id 的帧只收 _meta —— 拆成多个 chunk 回报的也不会把本地内容改掉", () => {
    let session = addPrompt(createSession("s", "/tmp"), [{ type: "text", text: "hi" }], "local-1")
    session = apply(session, { sessionUpdate: "user_message_chunk", messageId: "a", content: { type: "text", text: "hi" } })
    session = apply(session, {
      sessionUpdate: "user_message_chunk",
      messageId: "a",
      content: { type: "image", data: "…", mimeType: "image/png" },
      _meta: { alwith: { timestamp: "t" } }
    })
    expect(session.items).toHaveLength(1)
    const prompt = item<MessageItem>(session, "a")
    expect(prompt.content).toEqual([{ type: "text", text: "hi" }])
    expect(prompt._meta).toEqual({ alwith: { timestamp: "t" } })
  })

  test("没有 pending 的本地消息时,agent 的用户消息照常另起一条 —— 历史回放就是这样", () => {
    let session = createSession("s", "/tmp")
    session = apply(session, { sessionUpdate: "user_message_chunk", messageId: "h1", content: { type: "text", text: "old" } })
    session = apply(session, { sessionUpdate: "user_message_chunk", messageId: "h1", content: { type: "text", text: "er" } })
    const prompt = item<MessageItem>(session, "h1")
    expect(prompt.echo).toBeNull()
    // 用户消息的 chunk 是整块回放,不是流式增量:各是各的块
    expect(prompt.content).toEqual([
      { type: "text", text: "old" },
      { type: "text", text: "er" }
    ])
  })

  test("用户消息回放时每个内容块各是一帧,资源链接不会粘成一行", () => {
    let session = createSession("s", "/tmp")
    const chunk = (text: string) =>
      apply(session, { sessionUpdate: "user_message_chunk", messageId: "h", content: { type: "text", text } })
    session = chunk("Resource link: name=a.ts, uri=file:///p/a.ts")
    session = chunk("Resource link: name=b.ts, uri=file:///p/b.ts")
    session = chunk("hi")
    expect(item<MessageItem>(session, "h").content).toHaveLength(3)
  })

  test("agent 从不回报(alwith-cli)时 pending 一直挂着,不影响后面的回合", () => {
    let session = addPrompt(createSession("s", "/tmp"), [{ type: "text", text: "one" }], "l1")
    session = apply(session, { sessionUpdate: "agent_message_chunk", messageId: "a1", content: { type: "text", text: "1" } })
    session = apply(session, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" })
    session = addPrompt(session, [{ type: "text", text: "two" }], "l2")
    expect(session.items.map(entry => entry.id)).toEqual(["l1", "a1", "l2"])
    expect(item<MessageItem>(session, "l1").echo).toBe("pending")
  })

  test("SessionStore.addPrompt 返回本地 id,回报到达后 items 里换成 agent 的 id", () => {
    const store = new SessionStore()
    store.set(createSession("s", "/tmp"))
    const localId = store.addPrompt("s", [{ type: "text", text: "hi" }])
    expect(store.get("s").items[0]?.id).toBe(localId)
    store.accept("s", { sessionUpdate: "user_message", messageId: "agent-1", content: [] } as never)
    expect(store.get("s").items.map(entry => entry.id)).toEqual(["agent-1"])
  })
})
