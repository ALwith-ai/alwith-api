import { expect, test } from "bun:test"

import { observeRunStates } from "../run-states"
import type { SessionRunState } from "../types"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function fixture() {
  const snapshot = deferred<SessionRunState[]>()
  const subscribed = deferred<() => void>()
  let handler!: (states: SessionRunState[]) => void
  let stopped = 0
  const events: string[] = []
  const watcher = observeRunStates(
    {
      onRunStates: (receive) => {
        handler = receive
        return subscribed.promise
      },
      runStates: () => snapshot.promise
    },
    (_, source) => events.push(source)
  )
  return {
    snapshot,
    subscribed,
    events,
    watcher,
    emit: () => handler([]),
    release: () => {
      stopped++
    },
    stopped: () => stopped
  }
}

test("a late initial snapshot cannot overwrite a live status update", async () => {
  const f = fixture()
  f.subscribed.resolve(f.release)
  await Promise.resolve()
  f.emit()
  f.snapshot.resolve([])
  await f.watcher.ready
  expect(f.events).toEqual(["event"])
  f.watcher.dispose()
  f.emit()
  expect(f.events).toEqual(["event"])
  expect(f.stopped()).toBe(1)
})
test("disposing during subscription releases a late listener without loading a snapshot", async () => {
  const f = fixture()
  f.watcher.dispose()
  f.subscribed.resolve(f.release)
  await f.watcher.ready
  expect(f.stopped()).toBe(1)
  expect(f.events).toEqual([])
})
test("snapshot failure releases the listener", async () => {
  const f = fixture()
  f.subscribed.resolve(f.release)
  const result = f.watcher.ready.catch((error: unknown) => error)
  f.snapshot.reject(new Error("offline"))
  expect(await result).toBeInstanceOf(Error)
  expect(f.stopped()).toBe(1)
})
test("the baseline applies once and dispose is idempotent", async () => {
  const f = fixture()
  f.subscribed.resolve(f.release)
  f.snapshot.resolve([])
  await f.watcher.ready
  expect(f.events).toEqual(["snapshot"])
  f.watcher.dispose()
  f.watcher.dispose()
  expect(f.stopped()).toBe(1)
})
