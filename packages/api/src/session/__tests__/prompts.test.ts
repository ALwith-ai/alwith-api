import { expect, test } from "bun:test"
import type { PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2"
import { PromptTracker } from "../prompts"

const idle = { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } as const
function echo(tracker: PromptTracker, id: string) {
  tracker.accept("s", { sessionUpdate: "user_message", messageId: id, content: [] } as unknown as SessionUpdate)
}
function request() {
  return Promise.withResolvers<PromptResponse>()
}
const receipt = (id: string) => ({ messageId: id }) as PromptResponse

test("a receipt does not finish a turn", async () => {
  const tracker = new PromptTracker()
  const sent = request()
  const acknowledged = Promise.withResolvers<void>()
  let finished = false
  const turn = tracker.run("s", () => sent.promise, () => acknowledged.resolve()).then(result => {
    finished = true
    return result
  })
  sent.resolve(receipt("m"))
  await acknowledged.promise
  expect(finished).toBe(false)
  tracker.accept("s", idle)
  expect(await turn).toEqual(idle)
})

test("echo and idle can both precede the response", async () => {
  const tracker = new PromptTracker()
  const sent = request()
  let acknowledged = ""
  const turn = tracker.run("s", () => sent.promise, response => { acknowledged = response.messageId })
  echo(tracker, "m")
  tracker.accept("s", idle)
  sent.resolve(receipt("m"))
  expect(await turn).toEqual(idle)
  expect(acknowledged).toBe("m")
})

test("queued prompts do not finish at the previous idle boundary", async () => {
  const tracker = new PromptTracker()
  const first = request()
  const second = request()
  const a = tracker.run("s", () => first.promise, () => {})
  let secondDone = false
  const b = tracker.run("s", () => second.promise, () => {}).then(value => { secondDone = true; return value })
  echo(tracker, "first")
  tracker.accept("s", idle)
  first.resolve(receipt("first"))
  await a
  expect(secondDone).toBe(false)
  echo(tracker, "second")
  const cancelled = { ...idle, stopReason: "cancelled" } as const
  tracker.accept("s", cancelled)
  second.resolve(receipt("second"))
  expect(await b).toEqual(cancelled)
})

test("multiple messages inserted into one turn share its idle boundary", async () => {
  const tracker = new PromptTracker()
  const first = request()
  const second = request()
  const a = tracker.run("s", () => first.promise, () => {})
  const b = tracker.run("s", () => second.promise, () => {})
  echo(tracker, "a")
  echo(tracker, "b")
  tracker.accept("s", idle)
  second.resolve(receipt("b"))
  first.resolve(receipt("a"))
  expect(await Promise.all([a, b])).toEqual([idle, idle])
})

test("notice and another session's idle cannot complete a prompt", async () => {
  const tracker = new PromptTracker()
  const acknowledged = Promise.withResolvers<void>()
  let completed = false
  const turn = tracker.run("s", async () => receipt("m"), () => acknowledged.resolve()).then(value => { completed = true; return value })
  await acknowledged.promise
  tracker.accept("s", { sessionUpdate: "notice", severity: "warning", title: "advisory" } as SessionUpdate)
  tracker.accept("other", idle)
  await Promise.resolve()
  expect(completed).toBe(false)
  tracker.accept("s", idle)
  await turn
})

test("disconnect rejects completion after a successful receipt", async () => {
  const tracker = new PromptTracker()
  const acknowledged = Promise.withResolvers<void>()
  const turn = tracker.run("s", async () => receipt("m"), () => acknowledged.resolve())
  const rejected = turn.catch((error: unknown) => error)
  await acknowledged.promise
  tracker.fail(new Error("disconnected"))
  expect(await rejected).toBeInstanceOf(Error)
})

test("a late response after failure cannot acknowledge or finish a replacement request", async () => {
  const tracker = new PromptTracker()
  const old = request()
  let acknowledged = false
  const oldTurn = tracker.run("s", () => old.promise, () => { acknowledged = true })
  const rejected = oldTurn.catch((error: unknown) => error)
  tracker.fail(new Error("retired"))
  expect(await rejected).toBeInstanceOf(Error)
  const current = tracker.run("s", async () => receipt("new"), () => {})
  old.resolve(receipt("old"))
  echo(tracker, "new")
  tracker.accept("s", idle)
  await current
  expect(acknowledged).toBe(false)
})

test("pre-insertion errors reject without waiting for idle", async () => {
  const tracker = new PromptTracker()
  await expect(tracker.run("s", async () => { throw new Error("rejected") }, () => {})).rejects.toThrow("rejected")
})
