import type {
  RuntimeGap,
  RuntimeOutbound,
  RuntimeAgentInfo,
  RuntimeAttachInfo,
  RuntimeExitPayload,
  RuntimeAcpAgentRequest,
  RuntimeAcpNotification,
  RuntimeInboundPayload,
  RuntimePromptResult,
  RuntimeSessionResult,
  RuntimeStderrPayload,
  SessionEventFrame,
  SessionLifecycleFrame,
  SessionRunState
} from "./types"

/**
 * The Runtime as seen by a client. `Launch` is whatever the Runtime's launcher accepts for
 * `start` (alwith-runtime: `{ engine, cwd?, args?, env?, provider?, model? }`).
 *
 * Ownership: the connection that `start`s or `attachSession`s an agent owns it; `send`,
 * `stop` and `releaseSession` only succeed for the owner. Reads (`runStates`,
 * `sessionEvents`, `sessionLifecycle`, `agentForSession`) and `markRead` work for every connection.
 */
export interface RuntimeClient<Launch = unknown> {
  /** `launch` is what the Runtime's engine table is extended with: `{engine, cwd, args, env, provider, model, connection}`. */
  /** Start an agent process. Refused while one is still running under this id: switching engines is stop, wait for `onExit`, start. */
  start(agentId: string, launch: Launch): Promise<void>
  send(agentId: string, line: string): Promise<void>
  stop(agentId: string): Promise<void>
  attachSession(sessionId: string): Promise<RuntimeAttachInfo | null>
  /** Which live agent runs this session, without claiming it: observers pair it with the broadcast
   *  `acpNotification` / `acpAgentRequest` events. `null` when no live agent has the session. */
  agentForSession(sessionId: string): Promise<string | null>
  releaseSession(sessionId: string): Promise<void>
  stopSession(sessionId: string): Promise<void>
  markRead(sessionId: string): Promise<void>
  setSessionTitle(sessionId: string, title: string): Promise<void>
  sessionLifecycle(sessionId: string): Promise<SessionLifecycleFrame[]>
  /** Frames after `afterSequence` (exclusive); omit it to read from the start. */
  sessionEvents(sessionId: string, afterSequence?: number, limit?: number): Promise<SessionEventFrame[]>
  runStates(): Promise<SessionRunState[]>
  /** Lines any connection `send`s to an agent (journaled ones carry `sessionId` + `sequence`). */
  onOutbound(handler: (line: RuntimeOutbound) => void): Promise<() => void>
  /** Frames the client could not refill because the journal had dropped them: reload that session. */
  onGap(handler: (gap: RuntimeGap) => void): () => void
  /** The Runtime's own version, the same number `alwith-runtime --version` prints. */
  version(): Promise<string>
  agents(): Promise<RuntimeAgentInfo[]>
  ping(): Promise<void>
  onInbound(handler: (payload: RuntimeInboundPayload) => void): Promise<() => void>
  onExit(handler: (payload: RuntimeExitPayload) => void): Promise<() => void>
  onStderr(handler: (payload: RuntimeStderrPayload) => void): Promise<() => void>
  onRunStates(handler: (sessions: SessionRunState[]) => void): Promise<() => void>

  // ---- ACP: the Runtime speaks ACP v2 for you. `send` / `onInbound` stay as the escape hatch. ----

  /** Any ACP request; the Runtime numbers it and waits for the answer. Pass your own `id` only when you may withdraw it with `$/cancel_request`. */
  acpRequest<Result = unknown>(
    agentId: string,
    method: string,
    params?: unknown,
    options?: { id?: string | number }
  ): Promise<Result>
  /** Any ACP notification (no id). */
  acpNotify(agentId: string, method: string, params?: unknown): Promise<void>
  /** Answer a request the agent made (`onAcpAgentRequest`), by its `id`. */
  acpRespond(agentId: string, id: unknown, result?: unknown, error?: unknown): Promise<void>
  /** ACP handshake with your own client info / capabilities (e.g. elicitation); cached after the first time. Optional: session methods handshake with defaults. */
  initialize(
    agentId: string,
    info?: { name: string; version: string },
    capabilities?: Record<string, unknown>
  ): Promise<unknown>
  /** New session; the first call on an agent also performs the ACP handshake. `meta` becomes `_meta`. */
  sessionNew(
    agentId: string,
    cwd: string,
    mcpServers?: unknown[],
    meta?: Record<string, unknown>
  ): Promise<RuntimeSessionResult>
  sessionLoad(
    agentId: string,
    sessionId: string,
    cwd: string,
    mcpServers?: unknown[],
    meta?: Record<string, unknown>
  ): Promise<RuntimeSessionResult>
  sessionResume(
    agentId: string,
    sessionId: string,
    cwd: string,
    replayFrom?: unknown,
    meta?: Record<string, unknown>
  ): Promise<RuntimeSessionResult>
  sessionFork(
    agentId: string,
    sessionId: string,
    cwd: string,
    mcpServers?: unknown[],
    meta?: Record<string, unknown>
  ): Promise<RuntimeSessionResult>
  /** One turn; resolves when the turn ends. Content arrives through `onAcpNotification` meanwhile. */
  prompt(
    agentId: string,
    sessionId: string,
    prompt: unknown[],
    meta?: Record<string, unknown>
  ): Promise<RuntimePromptResult>
  /** Cancel the running turn (`session/cancel`). */
  cancel(agentId: string, sessionId: string): Promise<void>
  onAcpNotification(handler: (notification: RuntimeAcpNotification) => void): Promise<() => void>
  onAcpAgentRequest(handler: (request: RuntimeAcpAgentRequest) => void): Promise<() => void>
}
