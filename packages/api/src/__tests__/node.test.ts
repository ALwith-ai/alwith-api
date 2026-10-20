import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { ProcessRuntimeClient } from "../node"

const root = resolve(import.meta.dirname, "../../../..")
const candidates = [
  resolve(root, "../alwith-runtime/target/release/alwith-runtime"),
  resolve(root, "../alwith-runtime/target/debug/alwith-runtime"),
  join(root, "src-tauri/binaries", `alwith-runtime-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`)
]
const binary = candidates.find(existsSync)

describe.skipIf(!binary)("ProcessRuntimeClient", () => {
  test("spawns alwith-runtime over stdio, answers requests, forwards agent events", async () => {
    const port = new ProcessRuntimeClient({
      binary: binary!,
      engines: { cat: { command: "/bin/cat" } },
      journalRoot: mkdtempSync(join(tmpdir(), "runtime-client-")),
      stderr: "ignore"
    })
    const seen: string[] = []
    await port.onInbound((payload) => seen.push(...payload.lines))
    await port.ping()
    expect(await port.runStates()).toEqual([])
    await port.start("cat", { engine: "cat" })
    const prompt = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: { sessionId: "s1", prompt: [] }
    })
    await port.send("cat", prompt)
    const deadline = Date.now() + 5000
    while (seen.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
    expect(seen[0]).toContain("session/prompt")
    const exited = new Promise((resolve) => port.onProcessExit(resolve))
    port.close()
    await exited
    await expect(port.ping()).rejects.toThrow("exited")
  })
})

describe("ProcessRuntimeClient failed spawn", () => {
  for (const failure of ["missing", "not-executable"] as const) {
    test(`${failure} rejects readiness and settles process cleanup once`, async () => {
      const directory = mkdtempSync(join(tmpdir(), "runtime-spawn-failure-"))
      const executable = join(directory, "runtime")
      if (failure === "not-executable") {
        writeFileSync(executable, "#!/bin/sh\nexit 0\n")
        chmodSync(executable, 0o600)
      }
      const port = new ProcessRuntimeClient({ binary: executable, engines: {}, stderr: "ignore" })
      let notifications = 0
      const exited = new Promise<void>((resolve) =>
        port.onProcessExit(() => {
          notifications++
          resolve()
        })
      )
      try {
        await expect(port.ping()).rejects.toThrow()
        await exited
        await new Promise((resolve) => setTimeout(resolve, 20))
        expect(notifications).toBe(1)
        await expect(port.ping()).rejects.toThrow()
      } finally {
        port.close()
        port.kill()
        rmSync(directory, { recursive: true, force: true })
      }
    }, 3000)
  }
})
