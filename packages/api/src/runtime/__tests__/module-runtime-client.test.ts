import { expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { createInterface } from "node:readline"
import { ModuleRequestError, ModuleRuntimeClient, type ModuleRequestHandler } from "../../module"

function harness(handle: ModuleRequestHandler) {
  const input = new PassThrough()
  const output = new PassThrough()
  const frames: Array<Record<string, any>> = []
  const readers: Array<(frame: Record<string, any>) => void> = []
  createInterface({ input: output }).on("line", line => {
    const value = JSON.parse(line)
    const reader = readers.shift()
    if (reader) reader(value)
    else frames.push(value)
  })
  const client = new ModuleRuntimeClient({ input, output, handle })
  return { client, input, output, frames,
    send: (value: unknown) => input.write(JSON.stringify(value) + "\n"),
    next: (): Promise<Record<string, any>> => frames.length ? Promise.resolve(frames.shift()!) : new Promise(resolve => readers.push(resolve)) }
}

test("a host call can await a reverse Runtime request with the same ID", async () => {
  const port = harness(async (method, params) => {
    expect(method).toBe("board/read")
    return port.client.request("lookup", params)
  })
  try {
    port.send({ id: 1, method: "board/read", params: { node: "one" } })
    expect(await port.next()).toEqual({ id: 1, method: "lookup", params: { node: "one" } })
    port.send({ id: 1, result: { found: true } })
    expect(await port.next()).toEqual({ id: 1, result: { found: true } })
  } finally { port.client.close() }
})

test("a failed handler preserves structured errors and does not poison later requests", async () => {
  const port = harness(method => {
    if (method === "unknown") throw new ModuleRequestError(-32601, "Unknown method", { method })
    if (method === "crash") throw new Error("secret request content")
    return "ok"
  })
  try {
    port.send({ id: 1, method: "unknown" })
    expect(await port.next()).toEqual({ id: 1, error: { code: -32601, message: "Unknown method", data: { method: "unknown" } } })
    port.send({ id: 2, method: "crash" })
    expect(await port.next()).toEqual({ id: 2, error: { code: -32603, message: "Module request failed" } })
    port.send({ id: 3, method: "ok" })
    expect(await port.next()).toEqual({ id: 3, result: "ok" })
  } finally { port.client.close() }
})

test("EOF rejects pending Runtime calls, aborts handlers and suppresses late results", async () => {
  let finish!: (value: string) => void
  let signal!: AbortSignal
  const port = harness((_, __, current) => {
    signal = current
    return new Promise<string>(resolve => { finish = resolve })
  })
  port.send({ id: 2, method: "slow" })
  const pending = port.client.request("ping").catch(error => error)
  await port.next()
  port.input.end()
  expect(await pending).toBeInstanceOf(Error)
  expect(signal.aborted).toBe(true)
  finish("late")
  await new Promise(resolve => setImmediate(resolve))
  expect(port.frames).toEqual([])
  await expect(port.client.request("ping")).rejects.toThrow("closed")
})

test("module events and Runtime events share the pipe without becoming requests", async () => {
  const port = harness(() => { throw new Error("not a request") })
  const events: unknown[] = []
  port.client.onEvent("module", event => events.push(event))
  try {
    port.send({ type: "module", event: { type: "progress" } })
    expect(events).toEqual([{ type: "module", event: { type: "progress" } }])
    await port.client.emit({ type: "ready", port: 1234 })
    expect(await port.next()).toEqual({ type: "ready", port: 1234 })
  } finally { port.client.close() }
})

test("request cancellation aborts only its handler and suppresses a late result", async () => {
  let signal!: AbortSignal
  let finish!: (value: string) => void
  const port = harness((method, _, current) => {
    if (method === "healthy") return "ok"
    signal = current
    return new Promise<string>(resolve => { finish = resolve })
  })
  try {
    port.send({ id: 1, method: "slow" })
    port.send({ method: "_runtime/cancel", params: { id: 1 } })
    expect(signal.aborted).toBe(true)
    finish("late")
    port.send({ id: 2, method: "healthy" })
    expect(await port.next()).toEqual({ id: 2, result: "ok" })
    await new Promise(resolve => setImmediate(resolve))
    expect(port.frames).toEqual([])
    expect(port.client.signal.aborted).toBe(false)
  } finally { port.client.close() }
})
