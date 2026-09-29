import { describe, expect, test } from "bun:test"
import { applyUpdate, createSession, INTERRUPTED, markInterrupted, type FoldPolicy, type ToolItem } from "../session"
import { SessionStore } from "../store"

function tool(session: ReturnType<typeof createSession>, id: string): ToolItem {
  const item = session.items.find(entry => entry.kind === "tool" && entry.id === id)
  if (!item || item.kind !== "tool") throw new Error(`no tool ${id}`)
  return item
}

function startTool(
  session: ReturnType<typeof createSession>,
  id: string,
  extra: Record<string, unknown> = {},
  policy?: FoldPolicy
) {
  return applyUpdate(
    session,
    { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", ...extra } as never,
    { policy }
  )
}

function idle(session: ReturnType<typeof createSession>, policy?: FoldPolicy) {
  return applyUpdate(
    session,
    { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as never,
    { policy }
  )
}

/** alwith-cli 的判据:后台标在 `_meta.alwith.runInBackground`,Monitor 只能按工具名认。 */
const alwith: FoldPolicy = {
  outlivesTurn: entry => {
    const meta = entry._meta?.alwith
    const background =
      typeof meta === "object" && meta !== null && (meta as { runInBackground?: unknown }).runInBackground === true
    return background || entry.name === "Monitor"
  }
}

describe("回合收口", () => {
  test("回合结束时还停着的工具置 completed —— 协议不保证每个工具都收到终态帧", () => {
    let session = createSession("s", "/tmp")
    session = startTool(session, "t1")
    expect(tool(session, "t1").status).toBe("in_progress")

    session = idle(session)
    expect(tool(session, "t1").status).toBe("completed")
  })

  test("已经收到终态的工具不被改写", () => {
    let session = createSession("s", "/tmp")
    session = startTool(session, "t1", { status: "failed" })
    session = idle(session)
    expect(tool(session, "t1").status).toBe("failed")
  })

  test("活过回合的工具不在回合边界收口 —— 封了真结果就永远出不来", () => {
    let session = createSession("s", "/tmp")
    session = startTool(session, "bg", { _meta: { alwith: { runInBackground: true } } }, alwith)
    session = startTool(session, "watch", { name: "Monitor" }, alwith)
    session = startTool(session, "plain", {}, alwith)

    session = idle(session, alwith)

    expect(tool(session, "bg").status).toBe("in_progress")
    expect(tool(session, "watch").status).toBe("in_progress")
    expect(tool(session, "plain").status).toBe("completed")
  })

  test("不给判据就一视同仁:包不猜方言", () => {
    let session = createSession("s", "/tmp")
    session = startTool(session, "bg", { _meta: { alwith: { runInBackground: true } } })
    session = idle(session)
    expect(tool(session, "bg").status).toBe("completed")
  })
})

describe("装载期收尸", () => {
  test("没有活进程时,悬空的活过回合工具置 interrupted", () => {
    let session = createSession("s", "/tmp")
    session = startTool(session, "bg", { _meta: { alwith: { runInBackground: true } } }, alwith)
    session = startTool(session, "done", { status: "completed" }, alwith)

    session = markInterrupted(session, alwith)

    expect(tool(session, "bg").status).toBe(INTERRUPTED)
    expect(tool(session, "done").status).toBe("completed")
  })

  test("普通工具不归它管 —— 那些已经在回合边界收过口了", () => {
    let session = createSession("s", "/tmp")
    session = startTool(session, "plain", {}, alwith)
    const next = markInterrupted(session, alwith)
    expect(next).toBe(session)
  })

  test("没动过就返回同一个对象,渲染层不必重画", () => {
    const session = createSession("s", "/tmp")
    expect(markInterrupted(session, alwith)).toBe(session)
  })
})

describe("SessionStore 带着判据走", () => {
  test("accept 折叠时用的是 store 的判据,markInterrupted 报有没有动过", () => {
    const store = new SessionStore(alwith)
    store.set(createSession("s", "/tmp"))
    store.accept("s", {
      sessionUpdate: "tool_call_update",
      toolCallId: "bg",
      status: "in_progress",
      _meta: { alwith: { runInBackground: true } }
    } as never)
    store.accept("s", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as never)
    expect(tool(store.get("s"), "bg").status).toBe("in_progress")

    expect(store.markInterrupted("s")).toBe(true)
    expect(tool(store.get("s"), "bg").status).toBe(INTERRUPTED)
    expect(store.markInterrupted("s")).toBe(false)
  })
})

describe("工具产出是增量还是全量", () => {
  const output = (text: string) => [{ type: "content", content: { type: "text", text } }]
  const push = (session: ReturnType<typeof createSession>, text: string, policy?: FoldPolicy) =>
    applyUpdate(
      session,
      { sessionUpdate: "tool_call_update", toolCallId: "t1", content: output(text) } as never,
      { policy }
    )

  test("默认按全量:后一帧替掉前一帧,照 name 那几个字段的替换语义", () => {
    let session = createSession("s", "/tmp")
    session = push(session, "第一行")
    session = push(session, "第二行")
    expect(tool(session, "t1").content).toEqual(output("第二行") as never)
  })

  test("声明了增量就追加 —— alwith-cli 每帧只发新出来的那一段,替换会只剩最后一行", () => {
    const appending: FoldPolicy = { toolContent: "append" }
    let session = createSession("s", "/tmp")
    session = push(session, "第一行", appending)
    session = push(session, "第二行", appending)
    expect(tool(session, "t1").content).toEqual([...output("第一行"), ...output("第二行")] as never)
  })

  test("增量模式下空数组是没有新产出,不是清空", () => {
    const appending: FoldPolicy = { toolContent: "append" }
    let session = createSession("s", "/tmp")
    session = push(session, "第一行", appending)
    session = applyUpdate(
      session,
      { sessionUpdate: "tool_call_update", toolCallId: "t1", content: [] } as never,
      { policy: appending }
    )
    expect(tool(session, "t1").content).toEqual(output("第一行") as never)
  })

  test("两种模式下显式 null 都是清空,字段缺省都是不动", () => {
    for (const policy of [{}, { toolContent: "append" as const }]) {
      let session = createSession("s", "/tmp")
      session = push(session, "第一行", policy)
      session = applyUpdate(
        session,
        { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } as never,
        { policy }
      )
      expect(tool(session, "t1").content).toEqual(output("第一行") as never)
      session = applyUpdate(
        session,
        { sessionUpdate: "tool_call_update", toolCallId: "t1", content: null } as never,
        { policy }
      )
      expect(tool(session, "t1").content).toEqual([])
    }
  })
})

/** alwith-cli 的认亲判据。 */
const alwithWithParents: FoldPolicy = {
  ...alwith,
  parentOf: entry => {
    const meta = entry._meta?.claudeCode
    const parent =
      typeof meta === "object" && meta !== null ? (meta as { parentToolUseId?: unknown }).parentToolUseId : null
    return typeof parent === "string" ? parent : null
  }
}

describe("活过回合沿父子链继承", () => {
  const background = { _meta: { alwith: { runInBackground: true } } }
  const childOf = (parent: string) => ({ _meta: { claudeCode: { parentToolUseId: parent } } })

  test("后台 subagent 派出去的步骤跟它同生共死:回合边界不封", () => {
    let session = startTool(createSession("s", "/tmp"), "agent", { name: "Agent", ...background }, alwithWithParents)
    session = startTool(session, "step", { name: "Read", ...childOf("agent") }, alwithWithParents)
    session = idle(session, alwithWithParents)
    expect(tool(session, "agent").status).toBe("in_progress")
    expect(tool(session, "step").status).toBe("in_progress")
  })

  test("收尸时一并收,连孙辈也收", () => {
    let session = startTool(createSession("s", "/tmp"), "agent", { name: "Agent", ...background }, alwithWithParents)
    session = startTool(session, "step", { name: "Agent", ...childOf("agent") }, alwithWithParents)
    session = startTool(session, "leaf", { name: "Read", ...childOf("step") }, alwithWithParents)
    session = markInterrupted(session, alwithWithParents)
    expect(tool(session, "agent").status).toBe(INTERRUPTED)
    expect(tool(session, "step").status).toBe(INTERRUPTED)
    expect(tool(session, "leaf").status).toBe(INTERRUPTED)
  })

  test("前台 subagent 的步骤照常在回合边界收口", () => {
    let session = startTool(createSession("s", "/tmp"), "agent", { name: "Agent" }, alwithWithParents)
    session = startTool(session, "step", { name: "Read", ...childOf("agent") }, alwithWithParents)
    session = idle(session, alwithWithParents)
    expect(tool(session, "step").status).toBe("completed")
  })

  test("认亲成环不死循环", () => {
    let session = startTool(createSession("s", "/tmp"), "a", { name: "X", ...childOf("b") }, alwithWithParents)
    session = startTool(session, "b", { name: "Y", ...childOf("a") }, alwithWithParents)
    expect(() => idle(session, alwithWithParents)).not.toThrow()
  })
})

describe("活过回合的工具,状态只认同样声明了活过回合的那一帧", () => {
  const flagged = { _meta: { alwith: { runInBackground: true } } }

  test("轮内那条不带标的 completed 只是「已经扔到后台了」,不算终态", () => {
    let session = startTool(createSession("s", "/tmp"), "bg", { name: "Bash", ...flagged }, alwith)
    session = applyUpdate(
      session,
      { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "completed" } as never,
      { policy: alwith }
    )
    expect(tool(session, "bg").status).toBe("in_progress")
    expect(tool(session, "bg").endedAt).toBeNull()
  })

  test("轮后带标的那条才是真终态,failed 也一样", () => {
    let session = startTool(createSession("s", "/tmp"), "bg", { name: "Bash", ...flagged }, alwith)
    session = idle(session, alwith)
    session = applyUpdate(
      session,
      { sessionUpdate: "tool_call_update", toolCallId: "bg", status: "failed", ...flagged } as never,
      { policy: alwith }
    )
    expect(tool(session, "bg").status).toBe("failed")
    expect(tool(session, "bg").endedAt).not.toBeNull()
  })

  test("Monitor 按名字认,它的每一帧都算声明过,状态照常更新", () => {
    let session = startTool(createSession("s", "/tmp"), "m", { name: "Monitor" }, alwith)
    session = applyUpdate(
      session,
      { sessionUpdate: "tool_call_update", toolCallId: "m", status: "failed" } as never,
      { policy: alwith }
    )
    expect(tool(session, "m").status).toBe("failed")
  })

  test("其它字段(产出、标题)不受这条规矩影响,照常收", () => {
    let session = startTool(createSession("s", "/tmp"), "bg", { name: "Bash", ...flagged }, alwith)
    session = applyUpdate(
      session,
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "bg",
        status: "completed",
        title: "launched",
        content: [{ type: "content", content: { type: "text", text: "pid 42" } }]
      } as never,
      { policy: alwith }
    )
    expect(tool(session, "bg").status).toBe("in_progress")
    expect(tool(session, "bg").title).toBe("launched")
    expect(tool(session, "bg").content).toHaveLength(1)
  })
})

describe("结束时刻", () => {
  test("工具进入终态时盖 endedAt,回合边界封掉的也盖", () => {
    let session = startTool(createSession("s", "/tmp"), "a")
    session = startTool(session, "b")
    expect(tool(session, "a").endedAt).toBeNull()
    session = applyUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" } as never)
    expect(tool(session, "a").endedAt).not.toBeNull()
    session = idle(session)
    expect(tool(session, "b").endedAt).not.toBeNull()
  })

  test("已经有 endedAt 的工具再收到终态帧不改时刻", () => {
    let session = startTool(createSession("s", "/tmp"), "a")
    session = applyUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" } as never)
    const first = tool(session, "a").endedAt
    session = applyUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" } as never)
    expect(tool(session, "a").endedAt).toBe(first)
  })

  test("回合收尾时按起这一轮的用户消息记下时刻,turns() 里能读到", async () => {
    const store = new SessionStore()
    store.set(createSession("s", "/tmp"))
    const localId = store.addPrompt("s", [{ type: "text", text: "go" }])
    store.acknowledgePrompt("s", localId, "user")
    store.accept("s", { sessionUpdate: "user_message", messageId: "user", content: [] } as never)
    store.accept("s", { sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "ok" } } as never)
    expect(store.turns("s")[0]?.endedAt).toBeNull()
    store.accept("s", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as never)
    const [turn] = store.turns("s")
    expect(turn?.startedAt).not.toBeNull()
    expect(turn?.endedAt).not.toBeNull()
    expect(turn!.endedAt!).toBeGreaterThanOrEqual(turn!.startedAt!)
  })

  test("重放从头开始时上一世的回合时刻与用量一起清掉", () => {
    const store = new SessionStore()
    store.set(createSession("s", "/tmp"))
    const localId = store.addPrompt("s", [{ type: "text", text: "go" }])
    store.acknowledgePrompt("s", localId, "user")
    store.accept("s", { sessionUpdate: "user_message", messageId: "user", content: [] } as never)
    store.accept("s", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as never)
    store.beginReplay("s")
    expect(store.get("s").turnEndedAt).toEqual({})
    expect(store.get("s").turnUsage).toEqual({})
  })
})

describe("时刻严格递增", () => {
  test("同一毫秒里来的几件事也分得清先后:收尾前的条目 < 收尾时刻 < 收尾后的条目", () => {
    const store = new SessionStore()
    store.set(createSession("s", "/tmp"))
    const localId = store.addPrompt("s", [{ type: "text", text: "go" }])
    store.acknowledgePrompt("s", localId, "user")
    store.accept("s", { sessionUpdate: "user_message", messageId: "user", content: [] } as never)
    store.accept("s", { sessionUpdate: "agent_message_chunk", messageId: "a", content: { type: "text", text: "1" } } as never)
    store.accept("s", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as never)
    store.accept("s", { sessionUpdate: "agent_message_chunk", messageId: "b", content: { type: "text", text: "2" } } as never)
    const [turn] = store.turns("s")
    const [before, after] = turn!.entries
    expect(before!.at).toBeLessThan(turn!.endedAt!)
    expect(after!.at).toBeGreaterThan(turn!.endedAt!)
  })

  test("工具终态时刻不早于它的到达时刻,后面的条目也不早于它", () => {
    let session = startTool(createSession("s", "/tmp"), "a")
    session = applyUpdate(session, { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" } as never)
    session = startTool(session, "b")
    expect(tool(session, "a").endedAt!).toBeGreaterThan(tool(session, "a").at)
    expect(tool(session, "b").at).toBeGreaterThan(tool(session, "a").endedAt!)
  })
})

describe("收尾时刻只记第一次", () => {
  test("用户 Stop 之后 agent 自己的 idle 再来,这一轮仍结束于用户停下的那一刻", () => {
    const store = new SessionStore()
    store.set(createSession("s", "/tmp"))
    const localId = store.addPrompt("s", [{ type: "text", text: "go" }])
    store.acknowledgePrompt("s", localId, "user")
    store.accept("s", { sessionUpdate: "user_message", messageId: "user", content: [] } as never)
    store.accept("s", { sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" } as never)
    const first = store.turns("s")[0]!.endedAt
    store.accept("s", { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as never)
    expect(store.turns("s")[0]!.endedAt).toBe(first)
  })
})
