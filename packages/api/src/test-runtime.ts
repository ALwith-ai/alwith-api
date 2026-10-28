import { type ChildProcess, spawn } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"

import { ProcessRuntimeClient, type ProcessRuntimeOptions } from "./node"
import { WebSocketRuntimeClient } from "./runtime/websocket-runtime-client"

export type TestRuntimeOptions = Omit<ProcessRuntimeOptions, "journalRoot"> & {
  transport?: "stdio" | "ws"
  /** Explicit live-test opt-in. Only auth.json is copied; never settings or session data. */
  authFrom?: string
}

/** Owns a disposable Runtime and its complete test state, including an isolated Codex home. */
export async function startTestRuntime(options: TestRuntimeOptions) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "alwith-test-runtime-")))
  const codexHome = join(directory, "codex")
  const workspace = join(directory, "workspace")
  const managedConfig = join(directory, "managed-config.toml")
  const engineEnvironment = (value: Record<string, string> = {}) => ({
    ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "CODEX_INTERNAL_ORIGINATOR_OVERRIDE")),
    CODEX_HOME: codexHome,
    CODEX_APP_SERVER_MANAGED_CONFIG_PATH: managedConfig
  })
  let client: ProcessRuntimeClient | WebSocketRuntimeClient | undefined
  let child: ChildProcess | undefined
  let started = false
  let ended = false
  let resolveExit!: () => void
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  const finish = () => {
    ended = true
    resolveExit()
  }
  let disposal: Promise<void> | undefined
  const dispose = () =>
    (disposal ??= (async () => {
      client?.close()
      if (child && !ended) child.kill("SIGTERM")
      if (started && !ended) {
        const timer = setTimeout(() => {
          if (client instanceof ProcessRuntimeClient) client.kill("SIGKILL")
          else child?.kill("SIGKILL")
        }, 2000)
        try {
          await exited
        } finally {
          clearTimeout(timer)
        }
      }
      await rm(directory, { recursive: true, force: true })
    })())
  try {
    await mkdir(codexHome, { mode: 0o700 })
    await mkdir(workspace)
    await writeFile(managedConfig, "", { mode: 0o600 })
    if (options.authFrom) {
      const destination = join(codexHome, "auth.json")
      await copyFile(join(options.authFrom, "auth.json"), destination)
      await chmod(destination, 0o600)
    }
    const env = {
      ...options.env,
      CODEX_HOME: codexHome,
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
      CODEX_APP_SERVER_MANAGED_CONFIG_PATH: managedConfig,
      ALWITH_RUNTIME_ATTENTION: join(directory, "attention")
    }
    const engines = Object.fromEntries(
      Object.entries(options.engines).map(([name, engine]) => [
        name,
        { ...engine, env: engineEnvironment(engine.env) }
      ])
    )
    const journalRoot = join(directory, "journal")
    if (options.transport === "ws") {
      const token = crypto.randomUUID()
      child = spawn(options.binary, ["--listen", "ws://"], {
        stdio: ["ignore", "pipe", options.stderr ?? "inherit"],
        env: {
          ...process.env,
          ...env,
          ALWITH_RUNTIME_TOKEN: token,
          ALWITH_RUNTIME_ENGINES: JSON.stringify(engines),
          ALWITH_RUNTIME_JOURNAL: journalRoot,
          ALWITH_RUNTIME_PARENT_PID: String(process.pid)
        }
      })
      started = true
      child.once("exit", finish)
      child.once("close", finish)
      const runtimeProcess = child
      const url = await deadline(
        new Promise<string>((resolve, reject) => {
          const lines = createInterface({ input: runtimeProcess.stdout! })
          runtimeProcess.once("error", reject)
          runtimeProcess.once("exit", () => reject(new Error("Test Runtime exited before ready")))
          runtimeProcess.once("close", () => lines.close())
          lines.on("line", (line) => {
            try {
              const value = JSON.parse(line)
              if (value.type === "ready" && typeof value.url === "string") resolve(value.url)
            } catch {
              /* Runtime may print diagnostics before readiness. */
            }
          })
        })
      )
      client = new WebSocketRuntimeClient(url, token)
    } else {
      client = new ProcessRuntimeClient({ binary: options.binary, engines, env, journalRoot, stderr: options.stderr })
      client.onProcessExit(finish)
      started = true
    }
    // A launch-specific environment cannot escape the fixture's Codex home either.
    const start = client.start.bind(client)
    client.start = (agentId, launch) => {
      if (typeof launch !== "object" || launch === null || Array.isArray(launch))
        return Promise.reject(new Error("Test Runtime launch must be an object"))
      const value = launch as Record<string, unknown>
      return start(agentId, {
        ...value,
        env: engineEnvironment(value.env as Record<string, string> | undefined)
      })
    }
    await deadline(client.ping())
    return { client, directory, workspace, codexHome, dispose, [Symbol.asyncDispose]: dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function deadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Test Runtime startup timed out")), 10_000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
