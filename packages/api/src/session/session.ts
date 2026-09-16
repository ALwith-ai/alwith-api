// 一条 ACP v2 会话的状态:`session/update` 帧进来,可渲染的 `Session` 出去。
// 纯函数,不碰传输、不碰进程、不认任何 UI 框架。每次更新返回新的 Session 对象,
// 渲染层可以直接用引用相等判断要不要重画。
import type * as acp from "@agentclientprotocol/sdk/experimental/v2"
import { isText } from "./blocks"

export type SessionState = "idle" | "running" | "requires_action"

type ItemBase = {
  id: string
  /** Wall-clock arrival, used for turn durations. */
  at: number
  /** Arrived through history replay rather than live streaming. */
  replayed: boolean
  /**
   * 各家芯的方言,原样保留给应用读。同一条目的多帧逐层合并、后到的键覆盖先到的 ——
   * 因为芯把条目级的事实摊在不同帧上发(alwith-cli 的后台标第二帧才来、uuid 在末帧),
   * 按帧替换就会把先到的事实冲掉。
   */
  _meta: Record<string, unknown> | null
}
export type MessageItem = ItemBase & {
  kind: "user" | "assistant" | "thought"
  content: acp.ContentBlock[]
  /**
   * 本地先上屏的用户消息与 agent 回报之间的对账。协议要求 agent 把用户消息按它在历史里的
   * 位置回报出来(`user_message` + messageId;codex 会发,alwith-cli 不发)。本地这条已经在,
   * 回报到达时只认领它的 id,不另起一条:`pending` 等回报,`adopted` 已认领、之后同 id 的帧
   * 只收 `_meta`。agent 自己的消息恒为 null。见 `addPrompt`。
   */
  echo: "pending" | "adopted" | null
}
export type ToolItem = ItemBase & {
  kind: "tool"
  name: string | null
  title: string | null
  toolKind: acp.ToolKind | null
  status: acp.ToolCallStatus | null
  content: acp.ToolCallContent[]
  locations: acp.ToolCallLocation[]
  rawInput: unknown
  rawOutput: unknown
  /** 进入终态(completed / failed / interrupted)的时刻;还在跑为 null。 */
  endedAt: number | null
}
/**
 * 会话没有活进程、历史也放完了,还停在 pending / in_progress 的「活过回合」工具 ——
 * 它的结果永远不会回来了。协议没有这个态,是我们自己合成的:不置它,界面就一直转圈,
 * 用户以为任务还在跑。只在装载期派生,不回写任何持久化。
 */
export const INTERRUPTED = "interrupted"

export type PlanItem = ItemBase & { kind: "plan"; plan: acp.PlanUpdateContent }
export type CompactionItem = ItemBase & {
  kind: "compaction"
  status: acp.CompactionUpdate["status"]
  error: string | null
}
export type Item = MessageItem | ToolItem | PlanItem | CompactionItem

export type Terminal = {
  id: string
  command: string | null
  cwd: string | null
  output: string
  exitStatus: acp.TerminalExitStatus | null
}

/**
 * 这一轮没正常收尾。协议本身只给 `stopReason`;错误详情放在哪儿是各家芯自己的方言
 * (alwith-cli 放 `_meta.alwith`,codex 放 `_meta.codex`),所以这里原样交出 `_meta`,
 * 由应用按自己那颗芯去读 —— 包不猜方言。
 */
export type TurnError = {
  /** `_error` / `refusal` / `max_tokens` 之一。 */
  stopReason: string
  /** idle 帧的 `_meta` 原样。 */
  meta: Record<string, unknown> | null
}

/**
 * 折叠时需要、但协议本身答不了的那几个判断。都由应用给,因为答案在各家芯的方言里。
 */
export type FoldPolicy = {
  /**
   * 这个工具会活过本回合吗。
   *
   * 活过回合的工具只能由带外帧收口,所以回合结束时不许把它封成 completed —— 封了,
   * 下面那道终态锁就再也不放行,真结果永远显示不出来。会话没有活进程时反过来要给它们收尸。
   *
   * 判据是方言:alwith-cli 看 `_meta.alwith.runInBackground`,外加工具名 `Monitor`
   * (它的启动帧不带标,只有最后那条带外通知才带)。所以包不猜,由应用回答。
   *
   * 两条推论包自己做,不用应用操心:
   * - 子工具跟着父亲走(`parentOf`):后台 subagent 派出的步骤跟它同生共死,回合边界不封、
   *   收尸时一并收。
   * - 活过回合的工具,状态只认**那一帧自己也声明了活过回合**的帧。alwith-cli 把后台命令扔到
   *   后台时会在轮内发一条不带标的 completed,那只是「已经扔出去了」;真终态是轮后带标的那条。
   *   把前者当终态,任务就被锁死在完成态,真结果永远出不来。判断方式是拿这一帧的 `_meta`
   *   单独问一次 `outlivesTurn`。
   */
  outlivesTurn?: (tool: ToolItem) => boolean

  /**
   * 这个工具是谁派出去的 —— subagent 会把子步骤当成独立的工具帧发出来,界面要把它们收进
   * 那个 subagent 里显示。协议没有这个字段(v2 的 `ToolCallUpdate` 里没有父子),
   * alwith-cli 放在 `_meta.claudeCode.parentToolUseId`。不给就全是平的。
   */
  parentOf?: (tool: ToolItem) => string | null

  /**
   * `tool_call_update.content` 里给的是这一帧的新产出,还是到目前为止的全部产出。
   *
   * 协议对这个字段只写了一句「工具产生的内容」,没说死是替换还是追加 —— 旁边 `name` 那几个
   * 字段倒是写明了补丁语义。两家芯的做法真的不一样:alwith-cli 每帧只发新出来的那一段,
   * codex 发全量。猜错的后果都看得见:把增量当全量,长命令只剩最后一行;把全量当增量,输出翻倍。
   *
   * 默认按全量,也就是照 `name` 那几个字段的替换语义读。发增量的芯要自己声明。
   * 注:协议另有 `tool_call_content_chunk` 专门发增量,那一条恒为追加,不受这里影响。
   */
  toolContent?: "replace" | "append"
}

export type ApplyOptions = {
  /** 终端输出已解码的文本(解码器要跨帧活着,见 `SessionStore`)。 */
  text?: string
  policy?: FoldPolicy
}

export type Session = {
  id: string
  cwd: string
  title: string | null
  state: SessionState
  /** True once `session/new` or `session/resume` succeeded on the live connection. */
  attached: boolean
  restoring: boolean
  /**
   * Another Codex client holds the thread's writer lock; the transcript is shown from the
   * read path and nothing can be sent (Codex's own TUI does the same).
   */
  readOnly: boolean
  error: TurnError | null
  items: Item[]
  configOptions: acp.SessionConfigOption[]
  usage: acp.UsageUpdate | null
  lastTurnUsage: acp.Usage | null
  /** Token usage per turn, keyed by the turn's user message id (from the idle frame). */
  turnUsage: Record<string, acp.Usage>
  /** 每一轮收尾(idle 帧到达)的时刻,同样按起这一轮的用户消息 id 记。 */
  turnEndedAt: Record<string, number>
  /**
   * 这条会话最近一次盖的时刻。所有时刻(条目到达、工具终态、回合收尾)都严格递增 —— 同一毫秒里
   * 来的几件事靠它分先后,渲染层拿「谁在收尾之前、谁在之后」不必猜。差的那几毫秒对时长没影响。
   */
  clock: number
  /** `stopReason` of the most recent idle frame; `cancelled` marks an interrupted turn. */
  lastStopReason: string | null
  commands: acp.AvailableCommand[]
  terminals: Record<string, Terminal>
  updatedAt: string | null
}

export function createSession(id: string, cwd: string, title: string | null = null): Session {
  return {
    id,
    cwd,
    title,
    state: "idle",
    attached: false,
    restoring: false,
    readOnly: false,
    error: null,
    items: [],
    configOptions: [],
    usage: null,
    lastTurnUsage: null,
    turnUsage: {},
    turnEndedAt: {},
    clock: 0,
    lastStopReason: null,
    commands: [],
    terminals: {},
    updatedAt: null
  }
}

function meta(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** 见 `ItemBase._meta`:逐层合并,后到的键覆盖先到的;数组与标量整个替换。 */
function mergeMeta(
  previous: Record<string, unknown> | null,
  incoming: unknown
): Record<string, unknown> | null {
  const next = meta(incoming)
  if (next === null) return previous
  if (previous === null) return next
  const merged: Record<string, unknown> = { ...previous }
  for (const [key, value] of Object.entries(next)) {
    const before = merged[key]
    merged[key] = isPlainObject(before) && isPlainObject(value) ? mergeMeta(before, value) : value
  }
  return merged
}

/** 下一个时刻:墙钟,但绝不与上一个相同或倒退(见 `Session.clock`)。 */
function nextStamp(session: Session): number {
  return Math.max(Date.now(), session.clock + 1)
}

/** 把 items 里最大的时刻收进时钟(工具终态时刻由 patch 内部盖,upsert 看不见)。 */
function bumpClock(session: Session): Session {
  let clock = session.clock
  for (const item of session.items) {
    if (item.at > clock) clock = item.at
    if (item.kind === "tool" && item.endedAt !== null && item.endedAt > clock) clock = item.endedAt
  }
  return clock === session.clock ? session : { ...session, clock }
}

function replaceItem(items: Item[], index: number, item: Item): Item[] {
  const next = items.slice()
  next[index] = item
  return next
}

function upsertItem<T extends Item>(
  session: Session,
  kind: T["kind"],
  id: string,
  create: (base: ItemBase) => T,
  patch: (item: T) => T
): Session {
  const index = session.items.findIndex(item => item.kind === kind && item.id === id)
  if (index === -1) {
    const at = nextStamp(session)
    const base: ItemBase = { id, at, replayed: session.restoring, _meta: null }
    return { ...session, clock: at, items: [...session.items, patch(create(base))] }
  }
  return {
    ...session,
    items: replaceItem(session.items, index, patch(session.items[index] as T))
  }
}

/**
 * agent 的 chunk 是流式增量(按 token 来),相邻文本并成一块;用户消息的 chunk 是整块回放
 * (alwith-cli 把落盘的每个内容块各发一帧,资源链接每个一块),各是各的,并起来会把两条
 * `Resource link: …` 粘成一行、路径都解错。
 */
function appendBlock(content: acp.ContentBlock[], block: acp.ContentBlock, streamed: boolean): acp.ContentBlock[] {
  const last = content.at(-1)
  if (streamed && isText(block) && last !== undefined && isText(last)) {
    return [...content.slice(0, -1), { ...last, text: last.text + block.text }]
  }
  return [...content, block]
}

/** 没带 messageId 的 chunk 归到哪条:紧挨着的上一条同类消息(不能是本地先上屏的那条),否则新的。 */
function anonymousMessageId(session: Session, kind: MessageItem["kind"]): string {
  const last = session.items.at(-1)
  return last !== undefined && last.kind === kind && last.echo === null ? last.id : crypto.randomUUID()
}

const MESSAGE_KINDS: Record<string, MessageItem["kind"]> = {
  user_message: "user",
  user_message_chunk: "user",
  agent_message: "assistant",
  agent_message_chunk: "assistant",
  agent_thought: "thought",
  agent_thought_chunk: "thought"
}

/** 见 `FoldPolicy.toolContent`。缺省不动,显式 null 清空,给了数组按芯的声明合并。 */
function mergeToolContent(
  previous: acp.ToolCallContent[],
  incoming: acp.ToolCallContent[] | null | undefined,
  policy: FoldPolicy | undefined
): acp.ToolCallContent[] {
  if (incoming === undefined) return previous
  if (incoming === null) return []
  if (policy?.toolContent !== "append") return incoming
  return incoming.length === 0 ? previous : [...previous, ...incoming]
}

const RUNNING_STATUS = new Set(["pending", "in_progress"])

function isRunning(tool: ToolItem): boolean {
  return tool.status !== null && RUNNING_STATUS.has(tool.status)
}

function isTerminal(status: string | null): boolean {
  return status !== null && !RUNNING_STATUS.has(status)
}

/**
 * 这个工具活过本回合吗 —— 自己声明了算,父亲(沿 `parentOf` 一路往上)声明了也算:
 * 后台 subagent 派出去的步骤跟它同生共死。
 */
function outlivesTurn(tool: ToolItem, session: Session, policy: FoldPolicy | undefined): boolean {
  const seen = new Set<string>()
  let current: ToolItem | undefined = tool
  while (current !== undefined && !seen.has(current.id)) {
    if (policy?.outlivesTurn?.(current) === true) return true
    seen.add(current.id)
    const parentId: string | null = policy?.parentOf?.(current) ?? null
    current =
      parentId === null
        ? undefined
        : (session.items.find(item => item.kind === "tool" && item.id === parentId) as ToolItem | undefined)
  }
  return false
}

function mapTools(session: Session, map: (tool: ToolItem) => ToolItem): Session {
  let changed = false
  const items = session.items.map(item => {
    if (item.kind !== "tool") return item
    const next = map(item)
    if (next !== item) changed = true
    return next
  })
  return changed ? { ...session, items } : session
}

/**
 * 回合收口:还停在 pending / in_progress 的工具置 completed。
 *
 * 依据是事实而非猜测 —— 这一轮已经结束,不会再有属于它的帧了。协议不保证每个工具都收到
 * 终态帧(被取消的那个就不会),漏一个界面就永远转圈。
 *
 * 活过回合的工具除外:它的真终态由带外帧送来,这里封了就等于对用户说「这条跑完了」,
 * 而且 status 一进终态,下面 `tool_call_update` 那道锁就再也不放行。
 *
 * 「新工具登场就把上一个封掉」那条旧规矩没有跟过来:它假设 agent 串行跑工具,并行一跑就说谎。
 */
function sealTurn(session: Session, policy: FoldPolicy | undefined): Session {
  const now = nextStamp(session)
  const sealed = mapTools(session, tool =>
    isRunning(tool) && !outlivesTurn(tool, session, policy) ? { ...tool, status: "completed", endedAt: now } : tool
  )
  return sealed === session ? session : { ...sealed, clock: now }
}

/**
 * 给悬空的「活过回合」工具收尸,返回新的 Session。
 *
 * **唯一的调用时机**:装载一份没有活进程的会话、整份历史已经吃完之后。判据是现场事实 ——
 * 那些工具的真终态只会由当时那个进程迟到推送,进程没了,结果就永远不会经这条会话回来。
 *
 * 接管到活进程的会话一个都不许动:它们还可能收到真终态帧。
 */
export function markInterrupted(session: Session, policy: FoldPolicy = {}): Session {
  const now = nextStamp(session)
  const marked = mapTools(session, tool =>
    isRunning(tool) && outlivesTurn(tool, session, policy) ? { ...tool, status: INTERRUPTED, endedAt: now } : tool
  )
  return marked === session ? session : { ...marked, clock: now }
}

/**
 * 用户刚发出的那条消息,先上屏。协议里用户消息由 agent 回报,但等回报再显示,用户会以为没发出去;
 * alwith-cli 更是从不回报。所以本地先记一条 `echo: "pending"`,回报到了再认领(见 `MessageItem.echo`)。
 */
export function addPrompt(session: Session, content: acp.ContentBlock[], id: string = crypto.randomUUID()): Session {
  const at = nextStamp(session)
  const item: MessageItem = {
    id,
    at,
    replayed: false,
    _meta: null,
    kind: "user",
    content,
    echo: "pending"
  }
  return { ...session, clock: at, items: [...session.items, item] }
}

/**
 * 这个工具的终端 —— 按协议的连接找:工具产出里那条 `{ type: "terminal", terminalId }` 引用。
 * 不要按 `terminals[tool.id]` 找:那是 codex-acp-v2 恰好把 terminalId 设成了 toolCallId,换一颗芯
 * 输出就静默消失。
 */
export function terminalOf(tool: ToolItem, terminals: Session["terminals"]): Terminal | null {
  for (const entry of tool.content) {
    if (entry.type !== "terminal") continue
    const terminal = terminals[(entry as { terminalId: string }).terminalId]
    if (terminal) return terminal
  }
  return null
}

/** 吃一帧 `session/update`。终端输出已由 `SessionStore` 解好码。 */
export function applyUpdate(session: Session, update: acp.SessionUpdate, options: ApplyOptions = {}): Session {
  const decodedTerminalText = options.text
  const messageKind = MESSAGE_KINDS[update.sessionUpdate]
  if (messageKind) {
    const frame = update as acp.UserMessage & acp.ContentChunk & { sessionUpdate: string }
    const isChunk = update.sessionUpdate.endsWith("_chunk")
    // 协议要求每个 chunk 带 messageId(同一条消息的 chunk 共用一个,换了就是新消息)。没带的
    // 按相邻性退化:紧挨着的上一条是同类消息就并进去,否则另起一条 —— 按 id 去 upsert 会把整轮
    // 的话塞进第一条里,后面的话全跑到工具前面去。v2 之前的录制就是这样,松散的芯也可能这样。
    const messageId =
      typeof frame.messageId === "string" && frame.messageId.length > 0
        ? frame.messageId
        : anonymousMessageId(session, messageKind)
    if (messageKind === "user") {
      const last = session.items.at(-1)
      const known = session.items.some(item => item.kind === "user" && item.id === messageId)
      // agent 回报刚发出去的那条:本地内容是权威,只认领它的 id。没带 id 的帧没什么可认领。
      if (!known && messageId === frame.messageId && last?.kind === "user" && last.echo === "pending") {
        const adopted: MessageItem = {
          ...last,
          id: messageId,
          echo: "adopted",
          _meta: mergeMeta(last._meta, frame._meta)
        }
        return { ...session, items: replaceItem(session.items, session.items.length - 1, adopted) }
      }
    }
    return upsertItem<MessageItem>(
      session,
      messageKind,
      messageId,
      base => ({ ...base, kind: messageKind, content: [], echo: null }),
      item =>
        item.echo === "adopted"
          ? { ...item, _meta: mergeMeta(item._meta, frame._meta) }
          : {
              ...item,
              content: isChunk
                ? appendBlock(item.content, frame.content, messageKind !== "user")
                : Array.isArray(frame.content)
                  ? frame.content.slice()
                  : item.content,
              _meta: mergeMeta(item._meta, frame._meta)
            }
    )
  }
  switch (update.sessionUpdate) {
    case "state_update": {
      const frame = update as acp.StateUpdate & {
        sessionUpdate: "state_update"
      }
      if (frame.state === "running")
        return {
          ...session,
          state: "running",
          error: null,
          lastStopReason: null
        }
      if (frame.state === "requires_action") return { ...session, state: "requires_action" }
      if (frame.state === "idle") {
        const idle = frame as acp.IdleStateUpdate
        const stopReason = idle.stopReason ?? "end_turn"
        const failed = stopReason === "_error" || stopReason === "refusal" || stopReason === "max_tokens"
        const usage = idle.usage ?? null
        const turnUser = session.items.findLast(item => item.kind === "user")
        const sealed = sealTurn(session, options.policy)
        const endedAt = nextStamp(sealed)
        return {
          ...sealed,
          clock: endedAt,
          state: "idle",
          lastTurnUsage: usage ?? session.lastTurnUsage,
          turnUsage:
            usage === null || turnUser === undefined
              ? session.turnUsage
              : { ...session.turnUsage, [turnUser.id]: usage },
          // 收尾时刻只记第一次:用户 Stop 之后 agent 自己的 idle 再来,这一轮结束于用户停下的那一刻
          turnEndedAt:
            turnUser === undefined || turnUser.id in session.turnEndedAt
              ? session.turnEndedAt
              : { ...session.turnEndedAt, [turnUser.id]: endedAt },
          lastStopReason: stopReason,
          error: failed ? { stopReason, meta: meta(idle._meta) } : null
        }
      }
      return session
    }
    case "tool_call_update": {
      const frame = update as acp.ToolCallUpdate
      const updated = upsertItem<ToolItem>(
        session,
        "tool",
        frame.toolCallId,
        base => ({
          ...base,
          kind: "tool",
          name: null,
          title: null,
          toolKind: null,
          status: null,
          content: [],
          locations: [],
          rawInput: undefined,
          rawOutput: undefined,
          endedAt: null
        }),
        item => {
          // Omitted fields keep their value; an explicit null clears.
          const patched: ToolItem = {
            ...item,
            name: frame.name === undefined ? item.name : frame.name,
            title: frame.title === undefined ? item.title : frame.title,
            toolKind: frame.kind === undefined ? item.toolKind : frame.kind,
            content: mergeToolContent(item.content, frame.content, options.policy),
            locations: frame.locations === undefined ? item.locations : (frame.locations ?? []),
            rawInput: frame.rawInput === undefined ? item.rawInput : frame.rawInput,
            rawOutput: frame.rawOutput === undefined ? item.rawOutput : frame.rawOutput,
            _meta: mergeMeta(item._meta, frame._meta)
          }
          if (frame.status === undefined || frame.status === null) return patched
          // 自己声明了活过回合的工具,状态只认同样声明了的那一帧(见 FoldPolicy.outlivesTurn)。
          // 只看自己的声明:后台 subagent 派出的步骤是跟着它封口、收尸,它们自己的状态帧照常收。
          if (
            options.policy?.outlivesTurn?.(patched) === true &&
            options.policy.outlivesTurn({ ...patched, _meta: meta(frame._meta) }) !== true
          )
            return patched
          const endedAt = isTerminal(frame.status) ? (patched.endedAt ?? nextStamp(session)) : null
          return { ...patched, status: frame.status, endedAt }
        }
      )
      // 工具进终态的那一刻也要进时钟,后面的条目不能与它同刻
      return updated.items === session.items ? updated : bumpClock(updated)
    }
    case "tool_call_content_chunk": {
      const frame = update as acp.ToolCallContentChunk
      return upsertItem<ToolItem>(
        session,
        "tool",
        frame.toolCallId,
        base => ({
          ...base,
          kind: "tool",
          name: null,
          title: null,
          toolKind: null,
          status: null,
          content: [],
          locations: [],
          rawInput: undefined,
          rawOutput: undefined,
          endedAt: null
        }),
        item => ({ ...item, content: [...item.content, frame.content] })
      )
    }
    case "terminal_update": {
      const frame = update as acp.TerminalUpdate
      const current = session.terminals[frame.terminalId] ?? {
        id: frame.terminalId,
        command: null,
        cwd: null,
        output: "",
        exitStatus: null
      }
      return {
        ...session,
        terminals: {
          ...session.terminals,
          [frame.terminalId]: {
            ...current,
            command: frame.command === undefined ? current.command : frame.command,
            cwd: frame.cwd === undefined ? current.cwd : frame.cwd,
            output: decodedTerminalText === undefined ? current.output : decodedTerminalText,
            exitStatus: frame.exitStatus === undefined ? current.exitStatus : frame.exitStatus
          }
        }
      }
    }
    case "terminal_output_chunk": {
      const frame = update as acp.TerminalOutputChunk
      const current = session.terminals[frame.terminalId] ?? {
        id: frame.terminalId,
        command: null,
        cwd: null,
        output: "",
        exitStatus: null
      }
      return {
        ...session,
        terminals: {
          ...session.terminals,
          [frame.terminalId]: {
            ...current,
            output: current.output + (decodedTerminalText ?? "")
          }
        }
      }
    }
    case "plan_update": {
      const frame = update as acp.PlanUpdate
      return upsertItem<PlanItem>(
        session,
        "plan",
        frame.plan.planId,
        base => ({ ...base, kind: "plan", plan: frame.plan }),
        item => ({ ...item, plan: frame.plan, _meta: mergeMeta(item._meta, frame._meta) })
      )
    }
    case "plan_removed": {
      const frame = update as acp.PlanRemoved
      return {
        ...session,
        items: session.items.filter(item => !(item.kind === "plan" && item.id === frame.planId))
      }
    }
    case "compaction_update": {
      const frame = update as acp.CompactionUpdate
      return upsertItem<CompactionItem>(
        session,
        "compaction",
        frame.compactionId,
        base => ({
          ...base,
          kind: "compaction",
          status: frame.status,
          error: null
        }),
        item => ({
          ...item,
          status: frame.status,
          error: frame.error ?? null,
          _meta: mergeMeta(item._meta, frame._meta)
        })
      )
    }
    case "config_option_update":
      return {
        ...session,
        configOptions: (update as acp.ConfigOptionUpdate).configOptions
      }
    case "session_info_update": {
      const frame = update as acp.SessionInfoUpdate
      return {
        ...session,
        title: frame.title === undefined ? session.title : frame.title,
        updatedAt: frame.updatedAt === undefined ? session.updatedAt : frame.updatedAt
      }
    }
    case "usage_update":
      return { ...session, usage: update as acp.UsageUpdate }
    case "available_commands_update":
      return {
        ...session,
        commands: (update as acp.AvailableCommandsUpdate).availableCommands
      }
    default:
      return session
  }
}
