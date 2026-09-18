// The Runtime as a webview reaches it inside Tauri: the host's Rust spawns `alwith-runtime`
// over stdio and relays frames both ways (`runtime_send` command in, `runtime:lines` event
// batches out). The application owns one process; each webview connection has a unique
// identity. Hosts echo connectionId on replies and reject writes from replaced connections.
// Events retain their shared Runtime identity. A process exit requires a fresh client.
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { FrameRuntimeClient } from "./runtime/frame-runtime-client"

export const LINES_EVENT = "runtime:lines"
export const EXIT_EVENT = "runtime:exit"

export type RuntimeExit = { code: number | null; signal: number | null }

export class TauriRuntimeClient<Launch = unknown> extends FrameRuntimeClient<Launch> {
  private connecting?: Promise<void>
  private unlisten: UnlistenFn[] = []
  private exited = false
  private readonly connectionId = crypto.randomUUID()

  protected connectTransport(): Promise<void> {
    if (this.exited) return Promise.reject(new Error("Runtime exited"))
    this.connecting ??= (async () => {
      // Subscribe before start so no batch emitted during startup is missed.
      const stopLines = await listen<string[]>(LINES_EVENT, event => {
        for (const line of event.payload) {
          const frame = JSON.parse(line) as { type?: string; id?: unknown; connectionId?: string }
          if (frame.type === undefined && frame.id !== undefined && frame.connectionId !== this.connectionId) continue
          this.receive(line)
        }
      })
      const stopExit = await listen<RuntimeExit>(EXIT_EVENT, () => this.markExited())
      this.unlisten = [stopLines, stopExit]
      try {
        await invoke("runtime_start", { connectionId: this.connectionId })
      } catch (error) {
        this.connecting = undefined
        for (const stop of this.unlisten) stop()
        this.unlisten = []
        throw error
      }
    })()
    return this.connecting
  }

  protected async write(text: string): Promise<void> {
    await invoke("runtime_send", { line: text, connectionId: this.connectionId })
  }

  /** The Runtime process is gone: everything in flight fails, nothing reconnects. */
  markExited(): void {
    if (this.exited) return
    this.exited = true
    this.rejectPending("Runtime exited")
    this.close()
  }

  close(): void {
    for (const stop of this.unlisten) stop()
    this.unlisten = []
    this.connecting = undefined
  }
}
