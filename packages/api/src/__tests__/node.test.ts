import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { engineFromManifest, ProcessRuntimeClient } from "../node"

const root = resolve(import.meta.dirname, "../../../..")
const candidates = [
  resolve(root, "../alwith-runtime/target/release/alwith-runtime"),
  resolve(root, "../alwith-runtime/target/debug/alwith-runtime"),
  join(root, "src-tauri/binaries", `alwith-runtime-${process.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`)
]
const binary = candidates.find(existsSync)

describe("engineFromManifest", () => {
  const manifest = (contents: string) => {
    const path = join(mkdtempSync(join(tmpdir(), "engine-manifest-")), "engine.json")
    writeFileSync(path, contents)
    return path
  }

  test("every placeholder becomes the supplied path", () => {
    const path = manifest(
      JSON.stringify({
        command: "${bun}",
        args: ["--no-install", "${adapter}"],
        env: { CODEX_PATH: "${codex}", CODEX_CONFIG: '{"features":{}}' }
      })
    )
    expect(
      engineFromManifest(path, {
        bun: "C:\\Program Files\\App\\bun.exe",
        adapter: "/app/adapter.mjs",
        codex: "/app/codex"
      })
    ).toEqual({
      command: "C:\\Program Files\\App\\bun.exe",
      args: ["--no-install", "/app/adapter.mjs"],
      env: { CODEX_PATH: "/app/codex", CODEX_CONFIG: '{"features":{}}' }
    })
  })

  test("a path the host did not supply is an error", () => {
    const path = manifest(JSON.stringify({ command: "${bun}", env: { CODEX_PATH: "${codex}" } }))
    expect(() => engineFromManifest(path, { bun: "/app/bun" })).toThrow(
      "names a path the host did not supply: ${codex}"
    )
  })
})

describe.skipIf(!binary)("ProcessRuntimeClient", () => {
  test("spawns alwith-runtime over stdio, answers requests, forwards agent events", async () => {
    const directory = mkdtempSync(join(tmpdir(), "runtime-client-"))
    const port = new ProcessRuntimeClient({
      binary: binary!,
      engines: { cat: { command: "/bin/cat" } },
      journalRoot: join(directory, "journal"),
      env: { ALWITH_RUNTIME_ATTENTION: join(directory, "attention") },
      stderr: "ignore"
    })
    const exited = new Promise((resolve) => port.onProcessExit(resolve))
    try {
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
    } finally {
      port.close()
      await exited
      rmSync(directory, { recursive: true, force: true })
    }
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
