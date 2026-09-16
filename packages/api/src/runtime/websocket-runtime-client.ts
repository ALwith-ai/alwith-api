import { FrameRuntimeClient } from "./frame-runtime-client"

export { RuntimeRequestError } from "./frame-runtime-client"

export const RUNTIME_PROTOCOL = "alwith-runtime-v1"
export const RUNTIME_AUTH_PREFIX = "alwith-auth."
const RECONNECT_DELAY_MS = 250

/**
 * The frame protocol over one WebSocket (`alwith-runtime --listen ws://`). Reconnects while
 * anything is subscribed; on reconnect the run-state subscribers get a fresh snapshot.
 */
export class WebSocketRuntimeClient<Launch = unknown> extends FrameRuntimeClient<Launch> {
  private socket?: WebSocket
  private connecting?: Promise<WebSocket>
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private connectedOnce = false
  private closed = false
  readonly url: string
  private readonly token: string

  constructor(url: string, token: string) {
    super()
    this.url = url
    this.token = token
  }

  protected async connectTransport(): Promise<void> {
    await this.connect()
  }

  protected write(text: string): void {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("Runtime WebSocket is not open")
    socket.send(text)
  }

  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.socket?.close()
    this.socket = undefined
  }

  connect(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error("Runtime port is closed"))
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve(this.socket)
    if (this.connecting) return this.connecting
    this.connecting = new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url, [RUNTIME_PROTOCOL, `${RUNTIME_AUTH_PREFIX}${this.token}`])
      let opened = false
      socket.addEventListener("open", () => {
        opened = true
        this.socket = socket
        this.connecting = undefined
        resolve(socket)
        if (this.connectedOnce) this.restoreSubscriptions()
        else this.connectedOnce = true
      })
      socket.addEventListener("message", event => this.receive(String(event.data)))
      socket.addEventListener(
        "error",
        () => {
          this.connecting = undefined
          reject(new Error(`Runtime WebSocket connection failed: ${this.url}`))
          this.scheduleReconnect()
        },
        { once: true }
      )
      socket.addEventListener("close", () => {
        this.socket = undefined
        this.connecting = undefined
        if (!opened) reject(new Error(`Runtime WebSocket connection failed: ${this.url}`))
        this.rejectPending("Runtime WebSocket disconnected")
        this.scheduleReconnect()
      })
    })
    return this.connecting
  }

  protected override scheduleReconnect(): void {
    if (this.closed || !this.hasSubscriptions() || this.reconnectTimer !== undefined) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch(() => undefined)
    }, RECONNECT_DELAY_MS)
  }
}
