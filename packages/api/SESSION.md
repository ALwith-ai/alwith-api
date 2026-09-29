# 会话状态:`@alwith/api/session`

一条 ACP v2 会话的状态。`session/update` 帧进来，可渲染的 `Session` 出去。

做 WorkBuddy 时这一层每个人都要写，而且写出来必须一模一样：chunk 怎么并进上一条消息、
工具块的 upsert 语义（字段缺省保留、显式 null 清空）、终端输出跨 chunk 的 UTF-8 解码、
计划的增删、压缩进度、这一轮的用量归到哪条用户消息。写错的地方用户看得见：气泡分裂、
工具状态倒退、终端里出现乱码方块。

不在这里的：气泡长什么样、composer、工具渲染器、主题。那是每个 WorkBuddy 自己的脸。

```ts
import { createSession, SessionStore } from "@alwith/api/session"

const store = new SessionStore()
store.set(createSession(sessionId, cwd))

// 收到 agent 的 session/update 就喂进去,拿回这条会话的新样子
port.onAcpNotification(({ method, params }) => {
  if (method !== "session/update") return
  const next = store.accept(params.sessionId, params.update)
  render(next)
})
```

`Session` 是不可变的：每次更新返回新对象，渲染层直接用引用相等判断要不要重画。

## 两个视角，一份状态

`session.items` 是平铺的到达顺序，协议就长这样。想一条条读它的应用直接用。

界面基本按「一问一答」排版，所以包里还给一个分组视角：

```ts
for (const turn of store.turns(sessionId)) {
  render(turn.prompt)            // 起这一轮的用户消息，历史开头那一轮可能没有
  for (const entry of turn.entries) render(entry)   // 这一轮的回答、思考、工具
  showCost(turn.usage)           // 这一轮的用量，由收尾的 idle 帧带来
}
```

两个视角是同一份状态的纯推导，`turns()` 不改 `items`。subagent 派出去的子工具会收进父工具的
`children`，不在顶层重复出现——跨回合也认得到，后台 subagent 的结果迟到时不会另起一条。

终端单独存在 `session.terminals`(输出是字节流,要跨帧接着解码)。一个工具的终端按协议的连接找——
产出里那条 `{ type: "terminal", terminalId }` 引用,`terminalOf(tool, session.terminals)`;不要按
`terminals[tool.id]` 猜,那只是 codex-acp-v2 恰好把两个 id 设成一样。

每一轮带 `startedAt` / `endedAt`，每个工具带 `at` / `endedAt`：界面上「用了 12 秒」「思考了 3 秒」
就是这些相减。思考块的结束时刻是它后面那一条的到达时刻，不另记。

## 用户刚发的那条，先上屏

发送时用 `store.addPrompt(id, content)` 立即显示本地消息，保存返回的本地 ID。
`session/prompt` 成功只表示消息已插入，收到回执后调用
`store.acknowledgePrompt(sessionId, localId, response.messageId)` 精确认领。回显与回执可任意先后，
相同内容和并发请求也不能按最后一条消息或内容猜测。未插入的本地消息不接收正在生成的回答。

连接层使用 `PromptTracker` 把插入回执与生成完成分开：

```ts
const prompts = new PromptTracker()
// 实时 session/update 同时送给 prompts.accept(sessionId, update) 和 store.accept。
const completion = await prompts.run(
  sessionId,
  () => agent.request("session/prompt", { sessionId, prompt: content }),
  response => store.acknowledgePrompt(sessionId, localId, response.messageId)
)
// 此处已收到对应的 idle；stopReason、usage 和轮末 _meta 都从 completion 读取。
// 断线、放弃连接或替换进程时调用 prompts.fail(error)，拒绝尚未完成的等待。
```

`notice` 仅为实时提醒，不改变 Session，不进入聊天历史或回放。回放之前使用
`beginReplay()` 清空已折叠历史，避免重新收到相同 ID 的 chunk 时重复追加。

## 待办簿:agent 等你回答的请求

权限(`session/request_permission`)和问卷(`elicitation/create`)是 agent 发来、等应用回答的请求。
协议规定的几件事每家都要做、做错用户看得见,`AgentRequests` 一份做完:回答带原来的 id;用户点 Stop 时
这条会话所有没答的权限 MUST 回 `cancelled`、问卷回 `cancel`(不回,请求在 agent 与 Runtime 里永远挂着,
下次接管被重放成僵尸弹窗);agent 自己撤回的(`$/cancel_request`)回 -32800 并通知你撤弹窗;
`elicitation/complete` 替还挂着的问卷收掉;不认识的请求回 -32601 而不是让 agent 干等;接管时 Runtime
交来的那批当作刚收到;放手(交接给别的窗口、进程没了)一条都不答。

```ts
const requests = new AgentRequests((id, result, error) => agent.respond(id, result, error))
agent.onAgentRequest(request => requests.receive(request))
agent.onNotification((method, params) => requests.onNotification(method, params))
requests.onChange(pending => render(pending))      // 弹什么框是你的事
requests.answerPermission(toolCallId, { outcome: "selected", optionId })
requests.cancelSession(sessionId)                  // Stop
```

## `_meta` 跨帧累积

各家芯把条目级的事实摊在不同帧上发：alwith-cli 的后台标第二帧才来、消息的 uuid 在末帧、模型在首帧。
按帧替换就会把先到的事实冲掉，所以同一条目的 `_meta` 逐层合并，后到的键覆盖先到的。包不读里面的
任何字段，只负责留着。

## 协议答不了的，由你回答

有些判断协议给不了答案，包也不猜，交给 `FoldPolicy`。现在有两条。

**这个工具会活过本回合吗。**

回合结束时，还停在 `pending` 的工具会被置 `completed`——这一轮已经结束，不会再有属于它的帧了，
不封界面就永远转圈。但后台命令和长驻监视是例外：它们的真终态由带外帧送来，封了就等于对用户说
「这条跑完了」，而且状态一进终态就再也改不回去。

怎么知道一个工具活过回合，是各家芯的方言。alwith-cli 看 `_meta.alwith.runInBackground`，
外加工具名 `Monitor`——它的启动帧根本不带标，只有最后那条带外通知才带。

这条判据有两个推论，包自己做：子工具跟着父亲走（后台 subagent 派出的步骤跟它同生共死，回合边界
不封、收尸时一并收）；自己声明了活过回合的工具，状态只认**那一帧自己也声明了**的帧——alwith-cli
把命令扔到后台时会在轮内发一条不带标的 `completed`，那只是「已经扔出去了」，真终态是轮后带标的那条。

**这个工具是谁派出去的。** subagent 会把子步骤当成独立的工具帧发出来，界面要把它们收进那个
subagent 里显示。ACP v2 的 `ToolCallUpdate` 里没有父子字段，alwith-cli 放在
`_meta.claudeCode.parentToolUseId`。

```ts
const store = new SessionStore({
  outlivesTurn: tool => tool._meta?.alwith?.runInBackground === true || tool.name === "Monitor",
  parentOf: tool => tool._meta?.claudeCode?.parentToolUseId ?? null
})
```

**工具产出是增量还是全量。** `tool_call_update.content` 协议只写了一句「工具产生的内容」，
没说死是替换还是追加。alwith-cli 每帧只发新出来的那一段，codex 发全量。按全量读，一条
`npm install` 只剩最后一行；按增量读，全量的芯输出翻倍。默认全量，发增量的芯自己声明。

三条都不给也能用，只是工具全是平的、回合边界一视同仁、产出按全量。

## 验收

Desktop 有 36 份真实会话的回放录制。同一批 ACP 帧喂它现在的管线和这个包，两边归一成
「这一轮说了什么、想了什么、调了哪些工具」逐字比，36 份全过，见
`alwith-desktop/src/features/chat/__tests__/session-package-parity.test.ts`。

上面那条「增量还是全量」就是这一步撞出来的，不是想出来的。同时发现 Desktop 的 subagent
块没有 content 字段、而且只嵌一层——那两处是它的信息损失，包留着且是真递归。

之后 Desktop 真的换成了这个包：它先把旧管线对 36 份回放的完整 `ChatMessage[]` 录成基线
（`__tests__/goldens`），新实现的产物必须逐字一致。为此撞出来的规则都在上面：`_meta` 累积、
本地 prompt 的认领、活过回合沿父子链继承、状态只认声明帧、结束时刻。

装载一份**没有活进程**的会话时，历史吃完后调 `store.markInterrupted(id)`：那些悬空的工具，
结果永远不会经这条会话回来了，置成 `interrupted`。接管到活进程的会话一个都不许动。

## 词汇按协议来，方言留给应用

数据模型用 ACP 自己的形状（`acp.ContentBlock`、`acp.ToolCallStatus`、`acp.PlanUpdateContent`），
不另造一套名字。各家芯的方言不进包：一轮失败时 `TurnError` 只给协议规定的 `stopReason`，
外加 idle 帧的 `_meta` 原样——错误详情放 `_meta.alwith` 还是 `_meta.codex`，由应用按自己
那颗芯去读。

## 和 `@alwith/api/runtime` 的分工

`runtime` 管**怎么跟 Runtime 说话**：帧、连接、事件分发、`acpRequest` 把一条 ACP 请求
交出去。`session` 管**一条 ACP 会话是什么**：帧折成状态、两个视角、协议答不了的那几条判据。
一个是线上，一个是线上之上。同一个包的两个入口,互不依赖。
