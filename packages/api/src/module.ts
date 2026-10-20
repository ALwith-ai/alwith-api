/** A module connects to its parent's pipes; it never spawns another Runtime. */
import { createInterface, type Interface } from "node:readline"
import type { Readable, Writable } from "node:stream"

import { FrameRuntimeClient } from "./runtime/frame-runtime-client"

export class ModuleRequestError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
  }
}

export type ModuleRequestHandler = (method: string, params: unknown, signal: AbortSignal) => unknown | Promise<unknown>

export type ModuleRuntimeOptions = {
  input: Readable
  output: Writable
  handle: ModuleRequestHandler
}

/** Both directions have independent request IDs. Incoming requests are never awaited by the reader. */
export class ModuleRuntimeClient<Launch = unknown> extends FrameRuntimeClient<Launch> {
  private readonly lines: Interface
  private readonly lifetime = new AbortController()
  private readonly incoming = new Map<number, AbortController>()

  constructor(private readonly options: ModuleRuntimeOptions) {
    super()
    this.lines = createInterface({ input: options.input, crlfDelay: Infinity })
    this.lines.on("line", (line) => this.accept(line))
    this.lines.once("close", () => this.close(new Error("Runtime module input closed")))
    options.input.on("error", this.streamError)
    options.output.on("error", this.streamError)
    options.output.once("close", this.outputClosed)
  }

  /** Abort work owned by this pipe on EOF, stream failure or explicit close. */
  get signal(): AbortSignal {
    return this.lifetime.signal
  }

  protected connectTransport(): Promise<void> {
    return this.signal.aborted ? Promise.reject(this.signal.reason) : Promise.resolve()
  }

  protected write(text: string): Promise<void> {
    if (this.signal.aborted) return Promise.reject(this.signal.reason)
    return new Promise((resolve, reject) => {
      this.options.output.write(`${text}\n`, (error) => (error ? reject(error) : resolve()))
    })
  }

  emit(event: { type: string; [key: string]: unknown }): Promise<void> {
    return this.write(JSON.stringify(event))
  }

  close(reason = new Error("Runtime module endpoint closed")): void {
    if (this.signal.aborted) return
    this.lifetime.abort(reason)
    for (const controller of this.incoming.values()) controller.abort(reason)
    this.incoming.clear()
    this.rejectPending(reason.message)
    this.lines.close()
    this.options.input.off("error", this.streamError)
    this.options.output.off("close", this.outputClosed)
    // Keep the error listener until the last queued write finishes.
    this.options.output.end(() => this.options.output.off("error", this.streamError))
  }

  private readonly streamError = (error: Error): void => this.close(error)
  private readonly outputClosed = (): void => this.close(new Error("Runtime module output closed"))

  private accept(line: string): void {
    if (this.signal.aborted || !line.trim()) return
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Runtime module frame")
      const frame = value as Record<string, unknown>
      if (frame.method === "_runtime/cancel" && !("id" in frame)) {
        const params = frame.params as { id?: unknown } | undefined
        if (!Number.isSafeInteger(params?.id)) throw new Error("Invalid Runtime cancellation")
        const id = params!.id as number
        this.incoming.get(id)?.abort(new Error("Runtime request cancelled"))
        this.incoming.delete(id)
        return
      }
      if ("method" in frame && !("type" in frame)) {
        if (
          typeof frame.method !== "string" ||
          !Number.isSafeInteger(frame.id) ||
          this.incoming.has(frame.id as number)
        ) {
          throw new Error("Invalid or duplicate Runtime module request")
        }
        const id = frame.id as number
        const controller = new AbortController()
        this.incoming.set(id, controller)
        void this.dispatch(id, frame.method, frame.params, controller)
      } else {
        this.receive(line)
      }
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async dispatch(id: number, method: string, params: unknown, controller: AbortController): Promise<void> {
    let response: Record<string, unknown>
    try {
      const result = await this.options.handle(method, params, controller.signal)
      response = { id, result: result === undefined ? null : result }
    } catch (error) {
      // Unexpected exceptions must not expose credentials or request content to callers.
      response = {
        id,
        error:
          error instanceof ModuleRequestError
            ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
            : { code: -32603, message: "Module request failed" }
      }
    }
    if (controller.signal.aborted || this.incoming.get(id) !== controller) return
    try {
      await this.write(JSON.stringify(response))
    } catch (error) {
      this.close(error instanceof Error ? error : new Error(String(error)))
    } finally {
      if (this.incoming.get(id) === controller) this.incoming.delete(id)
    }
  }
}
