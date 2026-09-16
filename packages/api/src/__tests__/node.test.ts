import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, test } from "bun:test"
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
    await port.onInbound(payload => seen.push(...payload.lines))
    await port.ping()
    expect(await port.runStates()).toEqual([])
    await port.start("cat", { engine: "cat" })
    const prompt = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: [] } })
    await port.send("cat", prompt)
    const deadline = Date.now() + 5000
    while (seen.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
    expect(seen[0]).toContain("session/prompt")
    const exited = new Promise(resolve => port.onProcessExit(resolve))
    port.close()
    await exited
    await expect(port.ping()).rejects.toThrow("exited")
  })
})
