import { afterEach, expect, test } from "bun:test"

import { emit } from "@tauri-apps/api/event"
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks"

import { LINES_EVENT, TauriRuntimeClient } from "../tauri"

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const clients: TauriRuntimeClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
  clearMocks()
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow)
  else Reflect.deleteProperty(globalThis, "window")
})

test("reloaded windows with identical request ids ignore each other's replies but retain agent requests", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { crypto: globalThis.crypto } })
  const requests: { connectionId: string; line: string }[] = []
  const connections: string[] = []
  mockIPC(
    (cmd, args) => {
      const payload = args as Record<string, unknown>
      if (cmd === "runtime_start") connections.push(payload.connectionId as string)
      if (cmd === "runtime_send") requests.push(payload as (typeof requests)[number])
    },
    { shouldMockEvents: true }
  )
  const first = new TauriRuntimeClient()
  const second = new TauriRuntimeClient()
  clients.push(first, second)
  const pending = first.version()
  const fresh = second.version()
  const seen: unknown[] = []
  await second.onAcpAgentRequest((value) => seen.push(value))
  for (let i = 0; requests.length < 2 && i < 100; i++) await Bun.sleep(1)
  expect(requests).toHaveLength(2)
  expect(connections[0]).not.toBe(connections[1])
  const oldFrame = JSON.parse(requests[0].line)
  const newFrame = JSON.parse(requests[1].line)
  expect(oldFrame.id).toBe(newFrame.id)
  let resolved = false
  void fresh.then(() => {
    resolved = true
  })
  await emit(LINES_EVENT, [
    JSON.stringify({ id: oldFrame.id, connectionId: requests[0].connectionId, result: "old", error: null })
  ])
  expect(await pending).toBe("old")
  await Promise.resolve()
  expect(resolved).toBe(false)
  await emit(LINES_EVENT, [
    JSON.stringify({
      type: "acpAgentRequest",
      agentId: "codex",
      id: 7,
      method: "session/request_permission",
      params: {}
    })
  ])
  expect(seen).toHaveLength(1)
  await emit(LINES_EVENT, [
    JSON.stringify({ id: newFrame.id, connectionId: requests[1].connectionId, result: "new", error: null })
  ])
  expect(await fresh).toBe("new")
})

test("closing a connection rejects pending work and cannot restart its transport", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { crypto: globalThis.crypto } })
  let sent = false
  mockIPC(
    (cmd) => {
      if (cmd === "runtime_send") sent = true
    },
    { shouldMockEvents: true }
  )
  const client = new TauriRuntimeClient()
  clients.push(client)
  const pending = client.version()
  const rejected = pending.catch((error: unknown) => error)
  for (let i = 0; !sent && i < 100; i++) await Bun.sleep(1)
  expect(sent).toBe(true)
  client.close()
  expect(String(await rejected)).toContain("closed")
  await expect(client.version()).rejects.toThrow("exited")
})

test("closing during event subscription cannot start an orphan transport", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: { crypto: globalThis.crypto } })
  let starts = 0
  mockIPC(
    (cmd) => {
      if (cmd === "runtime_start") starts++
    },
    { shouldMockEvents: true }
  )
  const client = new TauriRuntimeClient()
  clients.push(client)
  const pending = client.version()
  client.close()
  await expect(pending).rejects.toThrow("closed")
  expect(starts).toBe(0)
})
