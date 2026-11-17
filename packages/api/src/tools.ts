/** Versioned module-owned tool declarations. Protocol adapters encode these for their engine. */
export interface ClientToolSet {
  version: 1
  definitions: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>
}

export interface ClientToolCall {
  sessionId: string
  turnId: string
  toolCallId: string
  name: string
  arguments: unknown
}

export interface ClientToolResult {
  success: boolean
  contentItems: Array<{ type: "text"; text: string } | { type: "image" | "audio"; mimeType: string; data: string }>
}

/** Runtime supplies agentId from the real pipe, never from the Agent's arguments. */
export interface ModuleToolCall {
  agentId: string
  params: ClientToolCall
}
