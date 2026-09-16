// The Runtime as a webview reaches it inside Tauri: the host's Rust spawns `alwith-runtime`
// over stdio and relays frames both ways (`runtime_send` command in, `runtime:lines` event
// batches out). One process, one connection; there is no reconnect, an exit is final until
// the host starts a fresh Runtime. The host side of this contract is ~150 lines of Rust
// (see alwith-u `src-tauri/src/runtime.rs`).
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

  protected connectTransport(): Promise<void> {
    if (this.exited) return Promise.reject(new Error("Runtime exited"))
    this.connecting ??= (async () => {
      // Subscribe before start so no batch emitted during startup is missed.
      const stopLines = await listen<string[]>(LINES_EVENT, event => {
        for (const line of event.payload) this.receive(line)
      })
      const stopExit = await listen<RuntimeExit>(EXIT_EVENT, () => this.markExited())
      this.unlisten = [stopLines, stopExit]
      try {
        await invoke("runtime_start")
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
    await invoke("runtime_send", { line: text })
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
