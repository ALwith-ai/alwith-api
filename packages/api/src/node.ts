// The Runtime as a Node or Bun process reaches it: spawn `alwith-runtime --listen stdio://`
// and speak frames over its pipes. This is what a headless host (a connector, a script, a
// module written in TypeScript) uses; a Tauri app uses the `./tauri` port instead.
import { type ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"

import { FrameRuntimeClient } from "./runtime/frame-runtime-client"

/** Deployment configuration, not a CLI implementation or model-provider registry. */
export type ProviderAdapter =
  | { kind: "raw" | "alwith" | "dsh" }
  | {
      kind: "environment"
      env: Record<string, "providerId" | "modelId" | "fastModelId" | "apiKey" | "baseUrl">
      args?: string[]
      envRemove?: string[]
    }

export type RuntimeEngineSpec = {
  command: string
  args?: string[]
  env?: Record<string, string>
  providerAdapter?: ProviderAdapter
}

/**
 * Reads the manifest staged with an engine and replaces every `${name}` in its strings with the path of
 * that name. Whoever packages the engine knows how it starts; the host only supplies where the files are.
 */
export function engineFromManifest(manifest: string, paths: Record<string, string>): RuntimeEngineSpec {
  const resolve = (value: unknown): unknown => {
    if (typeof value === "string") {
      const resolved = Object.entries(paths).reduce((text, [name, path]) => text.replaceAll(`\${${name}}`, path), value)
      if (resolved.includes("${"))
        throw new Error(`engine manifest ${manifest} names a path the host did not supply: ${resolved}`)
      return resolved
    }
    if (Array.isArray(value)) return value.map(resolve)
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, resolve(field)]))
    return value
  }
  return resolve(JSON.parse(readFileSync(manifest, "utf8"))) as RuntimeEngineSpec
}

export type ProcessRuntimeOptions = {
  /** Path to the alwith-runtime binary. */
  binary: string
  /** `ALWITH_RUNTIME_ENGINES` as an object; the Runtime spawns agents from this table. */
  engines: Record<string, RuntimeEngineSpec>
  /** `ALWITH_RUNTIME_JOURNAL`; omit for the platform default. */
  journalRoot?: string
  /** Extra environment for the Runtime process. */
  env?: Record<string, string | undefined>
  /** Where the Runtime's stderr goes; default inherits this process's stderr. */
  stderr?: "inherit" | "ignore"
}

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null }

/** `FrameRuntimeClient` over a child `alwith-runtime`. `ready` resolves once the Runtime printed its ready line. */
export class ProcessRuntimeClient<Launch = unknown> extends FrameRuntimeClient<Launch> {
  private child?: ChildProcess
  private ready?: Promise<void>
  private exited: ProcessExit | null = null
  private readonly processExitHandlers = new Set<(exit: ProcessExit) => void>()
  private readonly options: ProcessRuntimeOptions

  constructor(options: ProcessRuntimeOptions) {
    super()
    this.options = options
  }

  /** The Runtime's pid once spawned. */
  get pid(): number | undefined {
    return this.child?.pid
  }

  onProcessExit(handler: (exit: ProcessExit) => void): () => void {
    this.processExitHandlers.add(handler)
    return () => this.processExitHandlers.delete(handler)
  }

  protected connectTransport(): Promise<void> {
    if (this.exited) return Promise.reject(new Error(`alwith-runtime exited (${describeExit(this.exited)})`))
    this.ready ??= new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.binary, ["--listen", "stdio://"], {
        stdio: ["pipe", "pipe", this.options.stderr ?? "inherit"],
        env: {
          ...process.env,
          ...this.options.env,
          ALWITH_RUNTIME_ENGINES: JSON.stringify(this.options.engines),
          ...(this.options.journalRoot ? { ALWITH_RUNTIME_JOURNAL: this.options.journalRoot } : {}),
          ALWITH_RUNTIME_PARENT_PID: String(process.pid)
        }
      })
      this.child = child
      let settled = false
      const lines = createInterface({ input: child.stdout })
      lines.on("line", (line) => {
        if (!settled) {
          try {
            const value = JSON.parse(line) as { type?: string }
            if (value.type === "ready") {
              settled = true
              resolve()
            }
          } catch {
            // the ready line is the first JSON line; nothing else is expected before it
          }
          return
        }
        this.receive(line)
      })
      child.once("error", (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
      })
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (this.exited) return
        this.exited = { code, signal }
        if (!settled) {
          settled = true
          reject(new Error(`alwith-runtime exited before ready (${describeExit(this.exited)})`))
        }
        this.rejectPending(`alwith-runtime exited (${describeExit(this.exited)})`)
        for (const handler of this.processExitHandlers) handler(this.exited)
      }
      child.once("exit", finish)
      // Failed spawn emits error + close, without exit. Notify shutdown waiters
      // on either terminal event, once; keep exit prompt if descendants hold pipes.
      child.once("close", finish)
    })
    return this.ready
  }

  protected write(text: string): void {
    const stdin = this.child?.stdin
    if (!stdin || stdin.destroyed) throw new Error("alwith-runtime stdin is closed")
    stdin.write(`${text}\n`)
  }

  /** Closes stdin: the Runtime kills its agents and exits. */
  close(): void {
    this.child?.stdin?.end()
  }

  /** Hard kill for shutdown paths that cannot wait. */
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child?.kill(signal)
  }
}

function describeExit(exit: ProcessExit): string {
  return exit.signal ? `signal ${exit.signal}` : `code ${exit.code ?? "?"}`
}

export { startTestRuntime } from "./test-runtime"
export type { TestRuntimeOptions } from "./test-runtime"
