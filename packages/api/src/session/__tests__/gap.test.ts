import { describe, expect, test } from "bun:test"
import type * as acp from "@agentclientprotocol/sdk/experimental/v2"
import { createSession } from "../session"
import { SessionStore } from "../store"

function linked(seq: number, prevSeq: number, frame: number, text = `m${seq}`): acp.SessionUpdate {
  return {
    sessionUpdate: "agent_message",
    messageId: `message-${seq}`,
    content: [{ type: "text", text }],
    _meta: { alwith: { seq, prevSeq, frame } }
  } as acp.SessionUpdate
}

function texts(store: SessionStore): string[] {
  return store
    .get("s")
    .items.flatMap(item =>
      item.kind === "assistant"
        ? item.content.flatMap(block => (block.type === "text" ? [(block as { text: string }).text] : []))
        : []
    )
}

function fresh(): { store: SessionStore; gaps: number[] } {
  const store = new SessionStore()
  store.set(createSession("s", "/tmp"))
  const gaps: number[] = []
  store.onGap((_id, appliedThrough) => gaps.push(appliedThrough))
  return { store, gaps }
}

describe("forwarding chain", () => {
  test("linked frames apply in record order; one whose predecessor is missing is held and the gap reported once", () => {
    const { store, gaps } = fresh()
    store.accept("s", linked(3, -1, 0))
    expect(store.get("s").appliedThrough).toBe(3)
    store.accept("s", linked(9, 7, 0))
    store.accept("s", linked(12, 9, 0))
    expect(texts(store)).toEqual(["m3"])
    expect(store.held("s")).toBe(2)
    expect(gaps).toEqual([3])
    store.accept("s", linked(7, 3, 0))
    expect(texts(store)).toEqual(["m3", "m7", "m9", "m12"])
    expect(store.get("s").appliedThrough).toBe(12)
    expect(store.held("s")).toBe(0)
    expect(gaps).toEqual([3])
  })

  test("frames of one line number themselves and a repeat at or before the applied position is dropped", () => {
    const { store } = fresh()
    store.accept("s", linked(5, -1, 0, "first"))
    store.accept("s", { ...linked(5, -1, 1), sessionUpdate: "tool_call", toolCallId: "t", title: "tool" } as never)
    expect(store.get("s").appliedFrame).toBe(1)
    store.accept("s", linked(5, -1, 0, "replayed again"))
    expect(texts(store)).toEqual(["first"])
    store.accept("s", linked(5, -1, 2, "a later frame of the same line"))
    expect(store.get("s").appliedFrame).toBe(2)
  })

  test("live frames that run ahead of a replay wait for its cut and then apply in order", () => {
    const { store, gaps } = fresh()
    store.accept("s", linked(2, -1, 0))
    store.beginReplay("s", 2)
    store.accept("s", linked(40, 30, 0, "live after the cut"))
    expect(texts(store)).toEqual(["m2"])
    store.accept("s", {
      ...linked(10, 2, 0, "replayed"),
      _meta: { alwith: { seq: 10, prevSeq: 2, frame: 0 }, replay: { id: "r" } }
    } as never)
    store.accept("s", {
      ...linked(30, 10, 0, "replayed too"),
      _meta: { alwith: { seq: 30, prevSeq: 10, frame: 0 }, replay: { id: "r" } }
    } as never)
    expect(texts(store)).toEqual(["m2", "replayed", "replayed too", "live after the cut"])
    store.endReplay("s", { replayId: "r", after: 2, cut: 30 })
    expect(store.get("s").appliedThrough).toBe(40)
    expect(store.held("s")).toBe(0)
    // the replay was filling it; no second backfill
    expect(gaps).toEqual([])
  })

  test("a full replay forgets what was held", () => {
    const { store } = fresh()
    store.accept("s", linked(9, 7, 0))
    expect(store.held("s")).toBe(1)
    store.beginReplay("s", "start")
    expect(store.held("s")).toBe(0)
    expect(store.get("s").appliedThrough).toBe(-1)
  })
})
