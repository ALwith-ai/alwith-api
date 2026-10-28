import { afterAll, expect, test } from "bun:test"
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { startTestRuntime } from "../node"

const fixtures = await mkdtemp(join(tmpdir(), "test-runtime-fixtures-"))
const executable = join(fixtures, "runtime")
await writeFile(
  executable,
  `#!${process.execPath}
const respond = (request) => ({id: request.id, error: null, result: request.method === "version"
 ? JSON.stringify({home: process.env.CODEX_HOME, originator: process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, managed: process.env.CODEX_APP_SERVER_MANAGED_CONFIG_PATH, engines: JSON.parse(process.env.ALWITH_RUNTIME_ENGINES), journal: process.env.ALWITH_RUNTIME_JOURNAL, launch: globalThis.launch})
 : (request.method === "start" ? (globalThis.launch = request.params.launch, null) : null)});
if (process.argv.includes("ws://")) {
 const server = Bun.serve({port: 0, hostname: "127.0.0.1", fetch(req, server) {
   if (server.upgrade(req, {headers: {"Sec-WebSocket-Protocol": req.headers.get("sec-websocket-protocol").split(",")[0]}})) return;
   return new Response("bad", {status: 400});
 }, websocket: {message(ws, text) { ws.send(JSON.stringify(respond(JSON.parse(text)))); }}});
 console.log(JSON.stringify({type: "ready", url: "ws://127.0.0.1:" + server.port}));
} else {
 console.log(JSON.stringify({type: "ready"}));
 const readline = await import("node:readline");
 const lines = readline.createInterface({input: process.stdin});
 lines.on("line", line => console.log(JSON.stringify(respond(JSON.parse(line)))));
 lines.on("close", () => process.exit(0));
}
`
)
await chmod(executable, 0o700)
afterAll(() => rm(fixtures, { recursive: true, force: true }))

for (const transport of ["stdio", "ws"] as const) {
  test(`${transport} isolates inherited, engine and launch homes and removes all state on disposal`, async () => {
    const original = process.env.CODEX_HOME
    const runtime = await startTestRuntime({
      binary: executable,
      transport,
      engines: { mock: { command: "unused", env: { CODEX_HOME: "/wrong-engine" } } },
      env: { CODEX_HOME: "/wrong-process", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "wrong", CODEX_APP_SERVER_MANAGED_CONFIG_PATH: "/wrong-config" },
      stderr: "ignore"
    })
    try {
      await runtime.client.start("mock", { engine: "mock", env: { CODEX_HOME: "/wrong-launch" } })
      const state = JSON.parse(await runtime.client.version())
      expect(state.home).toBe(runtime.codexHome)
      expect(state.originator).toBeUndefined()
      expect(state.managed.startsWith(runtime.directory + "/")).toBe(true)
      expect(await readFile(state.managed, "utf8")).toBe("")
      expect(state.engines.mock.env.CODEX_APP_SERVER_MANAGED_CONFIG_PATH).toBe(state.managed)
      expect(state.launch.env.CODEX_APP_SERVER_MANAGED_CONFIG_PATH).toBe(state.managed)
      expect(state.engines.mock.env.CODEX_HOME).toBe(runtime.codexHome)
      expect(state.launch.env.CODEX_HOME).toBe(runtime.codexHome)
      expect(state.journal.startsWith(runtime.directory + "/")).toBe(true)
      expect(await readdir(runtime.codexHome)).toEqual([])
      expect(process.env.CODEX_HOME).toBe(original)
    } finally {
      await runtime.dispose()
    }
    await runtime.dispose()
    expect(await stat(runtime.directory).catch(() => null)).toBeNull()
  })
}

test("explicit live auth copies only auth.json with private permissions and never writes the source", async () => {
  const source = await mkdtemp(join(fixtures, "source-"))
  await writeFile(join(source, "auth.json"), '{"mock":"credential"}')
  await writeFile(join(source, "config.toml"), "must not copy")
  const runtime = await startTestRuntime({ binary: executable, engines: {}, authFrom: source, stderr: "ignore" })
  try {
    expect(await readdir(runtime.codexHome)).toEqual(["auth.json"])
    expect((await stat(join(runtime.codexHome, "auth.json"))).mode & 0o777).toBe(0o600)
    await writeFile(join(runtime.codexHome, "auth.json"), "test refresh")
    expect(await readFile(join(source, "auth.json"), "utf8")).toBe('{"mock":"credential"}')
  } finally {
    await runtime.dispose()
  }
})

for (const transport of ["stdio", "ws"] as const) {
  test(`${transport} failed startup cleans its temporary directory`, async () => {
    const before = (await readdir(tmpdir())).filter((name) => name.startsWith("alwith-test-runtime-"))
    await expect(
      startTestRuntime({ binary: join(fixtures, "missing"), engines: {}, transport, stderr: "ignore" })
    ).rejects.toThrow()
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("alwith-test-runtime-"))
    expect(after.sort()).toEqual(before.sort())
  })
}
