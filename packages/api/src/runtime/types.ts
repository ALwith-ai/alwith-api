// Wire types of the alwith-runtime-v1 protocol. Field names and order follow the Runtime's
// Rust definitions (serde camelCase); this file is the public contract.

/** Session run state. The first three are ACP v2 `state_update` values reported by the
 *  agent; `done` (finished, nobody looked) is synthesised by the Runtime and cleared only by
 *  `markRead`. */
export type RunState = "running" | "requires_action" | "done" | "idle"

export interface SessionTask {
  id: string
  title: string
  background: boolean
  since: number
}

export interface SessionRunState {
  sessionId: string
  state: RunState
  reusableDraft: boolean
  /** 属主 id:连接(或它的子属主 `<连接>:<label>`)。 */
  owner: string
  cwd: string
  title: string
  since: number
  tasks: SessionTask[]
  listeningPorts: number[]
  executionId: string | null
  executionRole: string | null
  lastActivityAt: number
}

export interface SessionLifecycleFrame {
  sequence: number
  recordedAt: number
  line: string
}

export type FrameDirection = "in" | "out"

/** One journaled ACP frame. `line` is the raw JSON-RPC text before the Runtime envelope. */
export interface SessionEventFrame {
  sequence: number
  recordedAt: number
  direction: FrameDirection
  line: string
}

/** The `error` of a response frame, JSON-RPC shaped. The Runtime's own errors use `RuntimeErrorCode`; an agent's ACP error passes through as is. */
export interface RuntimeResponseError {
  code: number
  message: string
  /** What the agent attached (`{details}`, `{authMethods}`…); null when there is none. */
  data?: unknown
}

export const RuntimeErrorCode = {
  /** The Runtime could not do it: no such agent, not the owner, the agent exited… */
  runtime: -32000,
  /** The connection is gone: the Runtime exited, the write failed. Raised locally, never sent by the Runtime. */
  connectionLost: -32001,
  methodNotFound: -32601,
  invalidParams: -32602
} as const

/** A request the agent made that nobody answered yet; answer it with `acpRespond` and the same `id`. */
export interface RuntimePendingAgentRequest {
  id: unknown
  method: string
  params: unknown
}

export interface RuntimeAttachInfo {
  agentId: string
  engine: string
  provider: string
  /** Unanswered agent requests (`session/request_permission`…) for the new owner to answer. */
  pendingAgentRequests: RuntimePendingAgentRequest[]
}

export interface RuntimeInboundPayload {
  agentId: string
  lines: string[]
}

export interface RuntimeExitPayload {
  agentId: string
}

export interface RuntimeStderrPayload {
  agentId: string
  line: string
}


export interface RuntimeAgentInfo {
  agentId: string
  pid: number | null
  provider: string
  model: string
  connection: string
  cpu: number
  memMb: number
  uptimeSecs: number
}

/** Events the Runtime pushes on the socket, discriminated by `type`. */
/** An ACP notification the agent sent (`session/update` and friends), already split out of the frame. */
export interface RuntimeAcpNotification {
  agentId: string
  method: string
  params: unknown
}

/** An ACP request the agent sent (`session/request_permission`, `elicitation/create`, `fs/*`…); answer with `acpRespond` and the same `id`. */
export interface RuntimeAcpAgentRequest {
  agentId: string
  id: unknown
  method: string
  params: unknown
}

/** What `sessionNew` / `sessionLoad` / `sessionResume` / `sessionFork` give back: ACP's result, `sessionId` inside. */
export interface RuntimeSessionResult {
  sessionId: string
  [key: string]: unknown
}

/** What `prompt` gives back once the turn ends. */
export interface RuntimePromptResult {
  stopReason: string
  _meta?: Record<string, unknown>
  [key: string]: unknown
}

export type RuntimeEvent =
  | ({ type: "inbound" } & RuntimeInboundPayload)
  | ({ type: "exit" } & RuntimeExitPayload)
  | ({ type: "stderr" } & RuntimeStderrPayload)
  | ({ type: "outbound" } & { agentId: string; line: string })
  | ({ type: "wire" } & { agentId: string; outbound: boolean; lines: string[] })
  | ({ type: "acpNotification" } & RuntimeAcpNotification)
  | ({ type: "acpAgentRequest" } & RuntimeAcpAgentRequest)
  | { type: "runStates"; sessions: SessionRunState[] }

