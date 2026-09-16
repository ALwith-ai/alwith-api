// 打开着的每条会话,外加终端输出要用的流式 UTF-8 解码器。
//
// 终端块单独存(不进 `items`):它的输出是按字节流来的,一个多字节字符可能跨两个 chunk,
// 必须由同一个 `TextDecoder` 接着解 —— 这是纯 reducer 做不到的那一点状态。
import type * as acp from "@agentclientprotocol/sdk/experimental/v2"
import { addPrompt, applyUpdate, type FoldPolicy, markInterrupted, type Session } from "./session"
import { type Turn, turns } from "./turns"

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), character => character.charCodeAt(0))
}

export class SessionStore {
  readonly sessions = new Map<string, Session>()
  private readonly decoders = new Map<string, TextDecoder>()

  /** 折叠时协议答不了的那几个判断,见 `FoldPolicy`。 */
  private readonly policy: FoldPolicy

  constructor(policy: FoldPolicy = {}) {
    this.policy = policy
  }

  get(id: string): Session {
    const session = this.sessions.get(id)
    if (!session) throw new Error(`Unknown session ${id}`)
    return session
  }

  set(session: Session): void {
    this.sessions.set(session.id, session)
  }

  beginReplay(id: string): void {
    const session = this.get(id)
    this.sessions.set(id, {
      ...session,
      items: [],
      terminals: {},
      turnUsage: {},
      turnEndedAt: {},
      clock: 0,
      restoring: true,
      error: null
    })
    for (const key of this.decoders.keys()) if (key.startsWith(`${id}:`)) this.decoders.delete(key)
  }

  accept(id: string, update: acp.SessionUpdate): Session {
    const session = this.get(id)
    let decoded: string | undefined
    if (update.sessionUpdate === "terminal_update") {
      const frame = update as acp.TerminalUpdate
      if (frame.output) {
        const decoder = new TextDecoder()
        this.decoders.set(`${id}:${frame.terminalId}`, decoder)
        decoded = decoder.decode(decodeBase64(frame.output.data), {
          stream: true
        })
      }
    } else if (update.sessionUpdate === "terminal_output_chunk") {
      const frame = update as acp.TerminalOutputChunk
      const key = `${id}:${frame.terminalId}`
      let decoder = this.decoders.get(key)
      if (!decoder) {
        decoder = new TextDecoder()
        this.decoders.set(key, decoder)
      }
      decoded = decoder.decode(decodeBase64(frame.data), { stream: true })
    }
    const next = applyUpdate(session, update, { text: decoded, policy: this.policy })
    this.sessions.set(id, next)
    return next
  }

  /** 用户刚发出的那条消息先上屏,见 `addPrompt`。返回它的本地 id(回报到达后会换成 agent 的)。 */
  addPrompt(id: string, content: acp.ContentBlock[]): string {
    const promptId = crypto.randomUUID()
    this.sessions.set(id, addPrompt(this.get(id), content, promptId))
    return promptId
  }

  /** 这条会话按回合分组,带上 store 自己的判据。 */
  turns(id: string): Turn[] {
    return turns(this.get(id), this.policy)
  }

  /**
   * 给这条会话里悬空的「活过回合」工具收尸。只在装载一份**没有活进程**的会话、历史吃完之后调;
   * 接管到活进程的会话不许调。返回是否动过。
   */
  markInterrupted(id: string): boolean {
    const session = this.get(id)
    const next = markInterrupted(session, this.policy)
    if (next === session) return false
    this.sessions.set(id, next)
    return true
  }
}
