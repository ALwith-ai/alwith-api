# @alwith/api

ALwith 的应用侧 TypeScript。一个包,三样东西,按名词分入口;整包 import 也行。

| 入口 | 内容 |
| --- | --- |
| `@alwith/api/runtime` | `RuntimeClient` 接口与帧协议类型,`WebSocketRuntimeClient`(`alwith-runtime --listen ws://`),错误 |
| `@alwith/api/agent` | `Agents` / `Agent`(起、接管、换芯、退出)与 `AgentRequests`(权限与问卷的待办簿) |
| `@alwith/api/session` | `session/update` 帧折成一条可渲染的会话:`applyUpdate`、`SessionStore`、`turns`。判据见 [SESSION.md](SESSION.md) |
| `@alwith/api/tauri` | `TauriRuntimeClient`:宿主的 Rust 把 stdio 子进程经 Tauri 事件中转 |
| `@alwith/api/node` | `ProcessRuntimeClient`:自己 spawn `alwith-runtime --listen stdio://` |

三种传输都继承 `FrameRuntimeClient`;要自己的传输就继承它。

```ts
import { WebSocketRuntimeClient } from "@alwith/api/runtime"

const port = new WebSocketRuntimeClient(url, token)
await port.start("codex", { engine: "codex", cwd })
const { sessionId } = await port.sessionNew("codex", cwd)
const { stopReason } = await port.prompt("codex", sessionId, [{ type: "text", text: "你好" }])
```

## 你手里的 agent:`Agents`

起进程、接管、换芯、退出,每个 WorkBuddy 都要处理,而且做错就是事故:起了同名的第二个进程、
换芯时接回了正在退出的旧进程、进程崩了 prompt 的 `await` 永挂。这些收在 `Agents` 里,你拿到的是一个 `Agent`:

```ts
import { Agents } from "@alwith/api/agent"

const agents = new Agents(port, { info: { name: "my-workbuddy", version: "1.0" } })
// 有活的就接管(进程、上下文、没答的请求都还在),没有就起一个
const attached = await agents.attach(sessionId)
const agent = attached?.agent ?? (await agents.start("chat-1", launch))
attached?.info.pendingAgentRequests   // 接管时 agent 还在等答的请求,交给 AgentRequests 待办簿
agent.onNotification((method, params) => …)
await agent.request("session/prompt", { sessionId, prompt })   // 进程退出时立刻失败,不永挂
await agents.replace("chat-1", otherLaunch)                     // 换芯 = 停 → 等 exit → 起
agents.onExit(agent => …)                                       // 进程没了,与 Runtime 的 exit 事件同步
```

只观察不认领的面板别 attach:`attach` 就是认领,认领了那条会话的权限就该你答。用只读的
`agentForSession(sessionId)` 拿到 agentId,再按它过滤广播的 `onAcpNotification` / `onAcpAgentRequest`。

`Agents` 只要求端口有 `AgentPort` 那几条(`RuntimeClient` 的子集),应用自己的宿主端口(比如 Tauri 中转)也能用。

协议参考是仓库根的 [PROTOCOL.md](../../PROTOCOL.md);这个包是它的应用侧。
