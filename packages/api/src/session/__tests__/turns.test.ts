import { describe, expect, test } from "bun:test"
import { applyUpdate, createSession, type FoldPolicy, type Session } from "../session"
import { turns } from "../turns"

function feed(session: Session, update: Record<string, unknown>): Session {
  return applyUpdate(session, update as never)
}

function ask(session: Session, messageId: string, text: string): Session {
  return feed(session, {
    sessionUpdate: "user_message",
    messageId,
    content: [{ type: "text", text }]
  })
}

function say(session: Session, messageId: string, text: string): Session {
  return feed(session, {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text }
  })
}

function run(session: Session, toolCallId: string, extra: Record<string, unknown> = {}): Session {
  return feed(session, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", ...extra })
}

/** alwith-cli 把派工具的人放在 `_meta.claudeCode.parentToolUseId`。 */
const alwith: FoldPolicy = {
  parentOf: tool => {
    const claudeCode = tool._meta?.claudeCode
    const parent =
      typeof claudeCode === "object" && claudeCode !== null
        ? (claudeCode as { parentToolUseId?: unknown }).parentToolUseId
        : null
    return typeof parent === "string" ? parent : null
  }
}

const launchedBy = (id: string) => ({ _meta: { claudeCode: { parentToolUseId: id } } })

describe("按回合分组", () => {
  test("一条用户消息起一轮,它之后的东西都归这一轮", () => {
    let session = createSession("s", "/tmp")
    session = ask(session, "u1", "做个页面")
    session = say(session, "a1", "好")
    session = run(session, "t1")
    session = ask(session, "u2", "再改一下")
    session = say(session, "a2", "改好了")

    const result = turns(session)
    expect(result).toHaveLength(2)
    expect(result[0]!.prompt?.id).toBe("u1")
    expect(result[0]!.entries.map(entry => entry.id)).toEqual(["a1", "t1"])
    expect(result[1]!.prompt?.id).toBe("u2")
    expect(result[1]!.entries.map(entry => entry.id)).toEqual(["a2"])
  })

  test("历史从 agent 的话开头时,第一轮没有用户消息", () => {
    let session = createSession("s", "/tmp")
    session = say(session, "a0", "接着上次说")
    session = ask(session, "u1", "继续")

    const result = turns(session)
    expect(result).toHaveLength(2)
    expect(result[0]!.prompt).toBeNull()
    expect(result[0]!.entries.map(entry => entry.id)).toEqual(["a0"])
  })

  test("空会话没有回合", () => {
    expect(turns(createSession("s", "/tmp"))).toEqual([])
  })

  test("这一轮的用量挂在这一轮上", () => {
    let session = createSession("s", "/tmp")
    session = ask(session, "u1", "算一下")
    session = say(session, "a1", "好")
    session = feed(session, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: "end_turn",
      usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46 }
    })

    const [turn] = turns(session)
    expect(turn!.usage).toEqual({ inputTokens: 12, outputTokens: 34, totalTokens: 46 })
  })
})

describe("工具认亲", () => {
  test("subagent 派出去的子步骤收进它的 children,不在顶层重复出现", () => {
    let session = createSession("s", "/tmp")
    session = ask(session, "u1", "查一下")
    session = run(session, "agent-1", { name: "Agent" })
    session = run(session, "grep-1", launchedBy("agent-1"))
    session = run(session, "read-1", launchedBy("agent-1"))
    session = run(session, "solo", {})

    const [turn] = turns(session, alwith)
    expect(turn!.entries.map(entry => entry.id)).toEqual(["agent-1", "solo"])
    const parent = turn!.entries[0]!
    expect(parent.kind === "tool" && parent.children.map(child => child.id)).toEqual(["grep-1", "read-1"])
  })

  test("不给判据就全是平的 —— 包不猜方言", () => {
    let session = createSession("s", "/tmp")
    session = ask(session, "u1", "查一下")
    session = run(session, "agent-1")
    session = run(session, "grep-1", launchedBy("agent-1"))

    const [turn] = turns(session)
    expect(turn!.entries.map(entry => entry.id)).toEqual(["agent-1", "grep-1"])
  })

  test("父亲不在这份历史里时按顶层处理 —— 凭空消失比放错地方更糟", () => {
    let session = createSession("s", "/tmp")
    session = ask(session, "u1", "继续")
    session = run(session, "grep-1", launchedBy("裁掉的那个"))

    const [turn] = turns(session, alwith)
    expect(turn!.entries.map(entry => entry.id)).toEqual(["grep-1"])
  })

  test("子工具跨回合也认得到父亲:后台 subagent 的结果迟到时不会另起一条", () => {
    let session = createSession("s", "/tmp")
    session = ask(session, "u1", "起个后台任务")
    session = run(session, "agent-1", { name: "Agent" })
    session = ask(session, "u2", "同时做点别的")
    session = run(session, "late", launchedBy("agent-1"))

    const result = turns(session, alwith)
    expect(result[1]!.entries).toHaveLength(0)
    const parent = result[0]!.entries[0]!
    expect(parent.kind === "tool" && parent.children.map(child => child.id)).toEqual(["late"])
  })

  test("认亲不改动 session.items —— 平铺那一份还是协议原样", () => {
    let session = createSession("s", "/tmp")
    session = run(session, "agent-1")
    session = run(session, "grep-1", launchedBy("agent-1"))
    const before = session.items

    turns(session, alwith)

    expect(session.items).toBe(before)
    expect(session.items.map(item => item.id)).toEqual(["agent-1", "grep-1"])
  })
})
