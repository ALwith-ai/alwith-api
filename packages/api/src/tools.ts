/** Versioned module-owned tools, passed as session/new|resume|fork _meta.alwith.tools. */
export interface ClientToolSet {
  version: 1
  /** Persist with the session; restore the same declarations, never silently replace schemas. */
  revision: string
  definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}

export interface ClientToolCall {
  sessionId: string
  turnId: string
  toolCallId: string
  name: string
  arguments: unknown
  toolSetRevision: string
}

export interface ClientToolResult {
  success: boolean
  contentItems: Array<
    | { type: "text"; text: string }
    | { type: "image" | "audio"; mimeType: string; data: string }
  >
}

/** Runtime supplies agentId from the real pipe, never from the Agent's arguments. */
export interface ModuleToolCall {
  agentId: string
  params: ClientToolCall
}
