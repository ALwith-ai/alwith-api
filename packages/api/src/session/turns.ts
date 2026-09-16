// 把一条会话按回合分组:一轮 = 一条用户消息,加上 agent 为它产出的所有东西。
//
// `session.items` 是按到达顺序的平铺清单,协议就长这样,想一条条读它的应用直接用。
// 但界面基本都按「一问一答」排版:用户气泡,底下跟着这一轮的回答、思考、工具。
// 这个分组每个 WorkBuddy 都要做,做法也只有一种,所以放在包里而不是各写一遍。
import type * as acp from "@agentclientprotocol/sdk/experimental/v2"
import type { CompactionItem, FoldPolicy, Item, MessageItem, PlanItem, Session, ToolItem } from "./session"

/** 一个工具,以及它派出去的子工具。 */
export type ToolNode = ToolItem & { children: ToolNode[] }

/** 一轮里 agent 产出的一条东西。工具已经认过亲,子工具在父工具的 `children` 里。 */
export type TurnEntry = MessageItem | ToolNode | PlanItem | CompactionItem

export type Turn = {
  /**
   * 起这一轮的用户消息。为 null 的情况有两种:历史从 agent 的话开头,
   * 或者这一轮是 agent 自己发起的。
   */
  prompt: MessageItem | null
  /** 这一轮 agent 产出的东西,按到达顺序。 */
  entries: TurnEntry[]
  /** 这一轮的用量,由收尾的 idle 帧带来。 */
  usage: acp.Usage | null
  /** 这一轮开始的时刻:用户消息到达,没有用户消息就是第一条产出到达。空轮为 null。 */
  startedAt: number | null
  /** 这一轮收尾(idle 帧到达)的时刻;还没收尾、或这一轮没有用户消息可记,为 null。 */
  endedAt: number | null
}

function isTool(item: Item): item is ToolItem {
  return item.kind === "tool"
}

function isPrompt(item: Item): item is MessageItem {
  return item.kind === "user"
}

/**
 * 按回合分组,顺便让工具认亲。
 *
 * 谁派出了这个工具,协议没有字段可问 —— alwith-cli 放在 `_meta.claudeCode.parentToolUseId`。
 * 所以跟「活过回合」一样,判据由 `FoldPolicy` 给,不给就全是平的。
 *
 * 认不到父亲的子工具按顶层处理:父亲可能在已经裁掉的历史里,让它凭空消失比放错地方更糟。
 */
export function turns(session: Session, policy: FoldPolicy = {}): Turn[] {
  const nodes = new Map<string, ToolNode>()
  for (const item of session.items) {
    if (isTool(item)) nodes.set(item.id, { ...item, children: [] })
  }

  const nested = new Set<string>()
  for (const item of session.items) {
    if (!isTool(item)) continue
    const parentId = policy.parentOf?.(item) ?? null
    if (parentId === null || parentId === item.id) continue
    const parent = nodes.get(parentId)
    if (parent === undefined) continue
    parent.children.push(nodes.get(item.id)!)
    nested.add(item.id)
  }

  const entryOf = (item: Item): TurnEntry => (isTool(item) ? nodes.get(item.id)! : item)

  const result: Turn[] = []
  let current: Turn | null = null
  for (const item of session.items) {
    if (isPrompt(item)) {
      current = {
        prompt: item,
        entries: [],
        usage: session.turnUsage[item.id] ?? null,
        startedAt: item.at,
        endedAt: session.turnEndedAt[item.id] ?? null
      }
      result.push(current)
      continue
    }
    if (isTool(item) && nested.has(item.id)) continue
    if (current === null) {
      current = { prompt: null, entries: [], usage: null, startedAt: item.at, endedAt: null }
      result.push(current)
    }
    current.entries.push(entryOf(item))
  }
  return result
}
