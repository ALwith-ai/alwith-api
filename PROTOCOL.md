# ALwith Runtime 协议（alwith-runtime-v1）

这份文档给要做自己的 WorkBuddy 的人：只拿 `alwith-runtime` 二进制、这份协议和本仓的客户端，不看 ALwith 任何应用的源码，就能起 agent、聊天、审批、看历史。

Runtime 只做四件事：托管 agent 进程、维护会话运行态、记会话日志、加载模块。它不解析你和 agent 之间的对话内容，也不管界面、身份和存储——那些是你的应用的事。

---

## 1. 你拿到什么

| 东西 | 在哪 | 干什么 |
| --- | --- | --- |
| `alwith-runtime` 二进制 | Runtime 的 GitHub Release，按平台 `alwith-runtime-<rust-triple>.tar.gz` | 唯一共享的进程，你的应用 spawn 它或连它 |
| `@alwith/api` | 本仓 `packages/api` | TypeScript：`./runtime` 连 Runtime、`./agent` 持有 agent、`./session` 会话状态；传输 WebSocket / Tauri 中转 / Node 子进程 |
| `alwith-api` | 本仓 `crates/api` | Rust：协议类型 + 客户端（feature `client`）：spawn 一个 Runtime 走 stdio，或接任意字节流 |
| 一个 ACP agent | 你自己选：`alwith-cli --acp`、`codex-acp-v2`、任何说 ACP 的进程 | Runtime 只负责起它、转发它 |

agent 与你的应用之间说的是 [ACP](https://agentclientprotocol.com)（Agent Client Protocol，JSON-RPC 2.0），Runtime 原样转发。本文只讲 Runtime 自己的协议；ACP 看它的规范。

---

## 2. 起 Runtime

两种入口，帧完全相同。

### 2.1 stdio（应用 spawn 它）

```sh
ALWITH_RUNTIME_ENGINES='{"alwith":{"command":"/path/alwith-cli","args":["--acp"]}}' \
alwith-runtime --listen stdio://
```

- 第一行 stdout：`{"type":"ready","transport":"stdio"}`，之后 stdin 进请求、stdout 出响应与事件，一行一帧。
- stdout 上只有协议帧，日志一律 stderr。
- stdin 到 EOF = 应用走了：Runtime 停模块、杀所有 agent、退出。
- 没有 token：管道本身就是授权。这条连接的属主 id 固定是 `stdio`。
- `--listen stdio://` 是默认值，可省略。

### 2.2 WebSocket（浏览器、远程）

```sh
ALWITH_RUNTIME_TOKEN=secret ALWITH_RUNTIME_ADDR=127.0.0.1:0 \
ALWITH_RUNTIME_ENGINES='{...}' alwith-runtime --listen ws://
# 或直接 --listen ws://127.0.0.1:4321
```

- 起来后 stdout 打一行：`{"type":"ready","transport":"ws","url":"ws://127.0.0.1:52341","port":52341}`。
- WebSocket 挂在根路径 `/`；`GET /readyz`、`GET /healthz` 回 `ok` 给探针。
- 握手鉴权走子协议（浏览器的 `WebSocket` 构造器不能自定义 header）：

```
Sec-WebSocket-Protocol: alwith-runtime-v1, alwith-auth.<token>
```

缺任一个即 401。服务端回的子协议是 `alwith-runtime-v1`。

- 每条连接的属主 id 是 `web-<uuid>`。
- 慢连接（事件队列 1024 条积满）会被断开；重连后用 `sessionEvents` 按 `sequence` 补齐。

### 2.3 环境变量

| 变量 | 必需 | 含义 |
| --- | --- | --- |
| `ALWITH_RUNTIME_ENGINES` | 是 | 引擎表，JSON，见 §5.1 |
| `ALWITH_RUNTIME_TOKEN` | ws 时必需 | 握手 token |
| `ALWITH_RUNTIME_ADDR` | 否 | `--listen ws://` 不带地址时的监听地址，缺省 `127.0.0.1:0` |
| `ALWITH_RUNTIME_JOURNAL` | 否 | 会话日志目录，缺省平台缓存目录下 `alwith/runtime/sessions` |
| `ALWITH_RUNTIME_PARENT_PID` | 否 | 父进程 pid；父进程没了 Runtime 自己退出（unix） |
| `ALWITH_MODULES_DIR` | 否 | 模块目录（应用的 `node_modules`），见 §7 |

`alwith-runtime --version` 打版本；`version` 方法也报同一个版本。

---

## 3. 帧

一行一个 JSON，`\n` 结尾。三种帧，按字段区分：

**请求**（应用 → Runtime）

```json
{"id": 1, "method": "runStates", "params": {}}
```

`id` 是应用自己编的 u64，`params` 可省。方法名 camelCase。

**响应**（Runtime → 应用）

```json
{"id": 1, "result": [...], "error": null}
{"id": 2, "result": null, "error": {"code": -32000, "message": "unknown engine foo; known: alwith, codex"}}
```

成功 `error` 为 null，失败 `result` 为 null、`error` 是 JSON-RPC 形状的 `{code, message, data}`（`data` 没有时为 null）。请求帧解析失败也会回带原 `id`（取不到用 0），所以按 id 配对的 pending 不会永远挂着。

Runtime 自己的 `code` 只有三个：

| code | 含义 |
| --- | --- |
| `-32601` | 没有这个方法 |
| `-32602` | 参数不对（帧不是合法 JSON、字段缺了、类型错了） |
| `-32000` | Runtime 做不到：没有这个 agent、不是属主、agent 退出了… |

`acpRequest` 一类方法（§5.4）失败时，`error` 是 agent 回的那个 ACP 错误原样（`code` / `data` 都是 agent 的，比如 alwith-cli 的 `-32000 auth_required`）。客户端本地断线用 `-32001`，Runtime 不会发它。

**事件**（Runtime → 应用，主动推）

```json
{"type": "inbound", "agentId": "chat-1", "lines": ["{\"jsonrpc\":\"2.0\",...}"]}
```

`type` 判别。事件对所有已连接的应用（和模块）全局广播，不分属主。

未知方法：`{"code": -32601, "message": "unknown runtime method <name>"}`。

---

## 4. 属主

- 每条连接是一个**属主**（stdio 是 `stdio`，ws 是 `web-<uuid>`，模块是 `module:<name>`）。
- `start` 起的 agent 归起它的连接。**写类**操作（`send`、ACP 层的那几个、`stop`、`releaseSession`、`stopSession`）只有属主能做；读（`runStates`、`sessionEvents`、`agents`…）和 `markRead` 任何连接都能做。
- **子属主**：写类请求和 `attachSession` 可带 `owner: "<label>"`（比如桌面的窗口 label），属主记为 `<连接>:<label>`。连接本身对名下所有子属主的 agent 都有写权，子属主之间互不可写。`detachOwner {owner}` 让一个子属主名下的 agent 改挂无主（进程不杀）。
- 连接断开：它名下的 agent **不杀**，改挂无主（孤儿）。孤儿任何连接都可以 `stop`，或经 `attachSession` 认领后继续用。

这就是"会话后台继续跑、任意窗口接管"的全部机制。

---

## 5. Agent

### 5.1 引擎表与 `start`

引擎表告诉 Runtime 每种 agent 的可执行文件在哪：

```json
{
  "alwith": { "command": "/opt/alwith-cli", "args": ["--acp"], "env": {} },
  "codex":  { "command": "/opt/codex-acp-v2", "env": { "CODEX_PATH": "/opt/codex" } }
}
```

`start` 起一个 agent 进程：

```json
{"id": 1, "method": "start", "params": {
  "agentId": "chat-1",
  "owner": "main",
  "launch": {
    "engine": "alwith",
    "cwd": "/Users/me/project",
    "args": [],
    "env": { "ANTHROPIC_API_KEY": "..." },
    "provider": "anthropic", "model": "claude-fable-5-1", "connection": "API"
  }
}}
→ {"id": 1, "result": null, "error": null}
```

- `agentId` 由应用取名。**同一个 `agentId` 的进程同时只能有一个**：它还活着时再 `start` 直接报错 `agent <id> is still running`。换芯 = `stop` → 等 `exit` 事件 → `start`。
- 为什么不允许隐式替换：一个进程被杀之后还有几十毫秒在把 stdout 排完。允许边杀边起，应用就会收到分不清属于谁的帧和退出事件。等它真的退出再起，这种帧根本不存在。
- 顺带的产品规则：一轮对话没结束不该换芯。要换先 `cancel`，等这一轮收口。
- `launch.engine` 查引擎表；`cwd`、`args`、`env` 追加在引擎表之上。
- `launch.provider` / `model` / `connection` 只是标签，Runtime 原样放进 `agents` 和 `attachSession` 的结果里，不解释。

#### Runtime 原生供应商选择

原始 launch 保留，适合自带配置的 CLI／ACP 适配器。引擎名不限制为 alwith 或 dsh；供应商启动使用引擎表声明的适配方式：

```json
{"agentId":"chat-1","launch":{"providerConfig":{"engine":"alwith","providerId":"deepseek","modelId":"chosen-model"},"overrides":{"args":[],"env":{},"envRemove":[]}}}
```

Runtime 从部署者指定的 `ALWITH_SETTINGS_PATH` 读取 `ai.providerConfigs`，解析密钥并调用 CLI 适配器。此能力不要求开启 fs/store/QA；不重写 CLI 内部的模型、工具、Skills、MCP 实现。原始 launch 的标签只是标签，providerConfig 则会实际影响启动环境。

- `providerConfig` 支持 engine、providerId、modelId、fastModelId、baseUrl、compatOverride、maxOutputTokens、modelOptions、supportsEffort、workspaceRoot、harnessPreset、dshProviderRoute；后两项仅对应适配器使用。
- 顶层只能另带 `overrides`，不能混入原始 launch 字段。overrides 只允许 args、env、envRemove、cwd；args 追加，env 覆盖，cwd 有值时覆盖。配置了授权根时，cwd 同样接受路径校验。
- 原始 launch 也支持 `envRemove: string[]`。应用顺序为引擎默认环境 → envRemove → 显式 env，确保切换供应商不会继承已要求删除的变量。
- 采用 providerConfig 时，引擎表不要重复填写适配器提供的 `--acp` 或 dsh 入口参数。
- `engines/probeCapabilities` 接受 providerId、modelId 和可选 baseUrl、compatOverride，返回能力探测结果；密钥只在 Runtime 内部解析，探测会实际请求供应商。
- 以上是受信任客户端能力，不构成多租户沙箱或平台账号鉴权。

#### 引擎适配声明与发现

引擎表条目的 `providerAdapter` 决定如何将供应商选择翻译为 CLI 参数与环境，不改变该 CLI 必须符合 Runtime 所支持 ACP 合同的要求。

```json
{"company-cli":{"command":"/opt/company-agent","providerAdapter":{"kind":"environment","args":["--acp"],"env":{"COMPANY_TOKEN":"apiKey","COMPANY_MODEL":"modelId","COMPANY_URL":"baseUrl"},"envRemove":["OLD_TOKEN"]}}}
```

- `kind` 为 `raw`、`alwith`、`dsh` 或 `environment`。前三种不接受额外字段。未声明时，标准引擎名 alwith／dsh 使用对应内置适配，其余为 raw；自定义名字可以显式选择任何适配。
- raw 不接受 providerConfig，使用原始 launch；environment 仅映射 env 和追加固定 args，不执行 shell 插值。env 的值限定为 providerId、modelId、fastModelId、apiKey、baseUrl。
- 请求映射 apiKey 但未配置密钥时明确报错；其他可选字段缺失时删除对应环境变量，避免继承旧值。envRemove 先应用，显式 env 后应用。
- `engines/capabilities` 返回 `{schemaVersion:1,engines:[{engine,providerAdapter}]}`，按引擎名排序，不含凭据；这是已配置适配方式，不是模型能力探测结果。

#### 内置资源服务配置

部署环境变量 `ALWITH_RUNTIME_SERVICES` 为 JSON，例如：

```json
{"schemaVersion":1,"fs":{"roots":["/srv/work"]},"store":{"dataDir":"/srv/app/data","cacheDir":"/srv/app/cache"}}
```

fs、git、shell、qa 分别接受非空绝对路径 roots；store 独立接受不同的绝对路径 dataDir／cacheDir。未列出的能力不启用；未知字段或版本报错。`services/capabilities` 返回 `{schemaVersion:1,enabled:[...]}`，能力名排序；`services/ping` 不要求启用任何资源能力。调用未启用的资源能力会明确失败。

`ALWITH_FS_ROOTS` 仅为供应商启动 cwd 的独立路径约束，不启用资源服务；`ALWITH_SETTINGS_PATH` 仅指定供应商配置。路径限制不是 shell／Agent 的操作系统沙箱。QA 平台凭据由 Desktop 业务适配提供，不要求迁入 Runtime；服务器缺少凭据提供方时，相关 QA 操作明确失败，其他能力不受影响。

### 5.2 `send`：一行 ACP

```json
{"id": 2, "method": "send", "params": {"agentId": "chat-1", "line": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}"}}
```

`line` 是一条完整的 ACP JSON-RPC 帧，Runtime 写进 agent 的 stdin。它只看两件事，其余原样透传：

1. **`initialize` 只握一次手**：agent 的 `initialize` 响应会被缓存。之后再发 `initialize`（换窗口、接管、重载），Runtime 直接从缓存回放响应给你，不打扰 agent。进程换过就没有缓存，这一条照常送到 agent。
2. **`session/resume`**：发出前 Runtime 先把 `params.sessionId` 占住，同一份会话不能被两个 agent 同时恢复。

写失败（进程已死）→ `send` 报错，并广播一条合成的 ACP 通知：

```json
{"jsonrpc":"2.0","method":"_alwith/runtimeError","params":{"message":"send to agent chat-1 failed: ..."}}
```

它走 `inbound` 事件，所以你的 ACP 客户端在同一条流上就能看到。

### 5.3 agent 的输出

| 事件 | 含义 |
| --- | --- |
| `{"type":"inbound","agentId","lines":[...]}` | agent → 应用的 ACP 帧，按 16ms 合批 |
| `{"type":"outbound","agentId","line"}` | 你 `send` 的那行，给别的连接看"谁发了什么" |
| `{"type":"wire","agentId","outbound":bool,"lines":[...]}` | 真正上线的原文，做协议诊断用 |
| `{"type":"stderr","agentId","line"}` | agent 的 stderr 一行 |
| `{"type":"exit","agentId"}` | 进程退出。同一个 agentId 同时只有一个进程，所以这条没有歧义：收到它就是"我这个 agent 没了"，也是可以再 `start` 的那一刻 |

要自己拿 ACP SDK 说协议也可以：`send` 写一行、`inbound` 收一行，就是一条 ND-JSON 流。但没必要——见 §5.4。

### 5.4 让 Runtime 替你说 ACP

上面 `send` / `inbound` 是原始通道。日常不用碰它：Runtime 自己会说 ACP v2，你只调会话级的方法，收拆好的事件。

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `initialize` | `agentId, info?, capabilities?` | ACP 握手的结果。可选：只有要声明自己的客户端能力（如 elicitation）时才调，会话方法会自动以默认身份握手；握过就回缓存 |
| `sessionNew` | `agentId, cwd, mcpServers?, meta?` | ACP `session/new` 的结果，`sessionId` 在里面。第一次调用 Runtime 会先替你握手 |
| `sessionLoad` / `sessionResume` / `sessionFork` | `agentId, sessionId, cwd, …` | 同上 |
| `prompt` | `agentId, sessionId, prompt: [...], meta?` | 回合结束才返回：`{stopReason, _meta}` |
| `cancel` | `agentId, sessionId` | null（发 `session/cancel` 通知） |
| `acpRespond` | `agentId, id, result? \| error?` | null。回答 agent 发来的请求 |
| `acpRequest` / `acpNotify` | `agentId, method, params, id?` | 任意 ACP 方法 / 通知，Runtime 编 id、等响应。逃生口：Runtime 没包的方法从这里走。agent 回错误时响应的 `error` 就是那个 ACP 错误原样。要能撤回（`acpNotify` 发 `$/cancel_request {requestId}`）就自己传 `id`（字符串或数字，同一 agent 上未答的 id 不能重用） |

`meta` 原样放进 ACP 的 `_meta`（比如 alwith-cli 的 `_meta.alwith.maxBudgetUsd`）。

事件：

| 事件 | 含义 |
| --- | --- |
| `{"type":"acpNotification","agentId","method","params"}` | agent 发来的通知：`session/update` 的每一条内容、工具调用、状态 |
| `{"type":"acpAgentRequest","agentId","id","method","params"}` | agent 发来的请求：`session/request_permission`、`elicitation/create`、`fs/*`…用 `acpRespond` 带同一个 `id` 回答 |

一轮对话的样子：

```json
→ {"id":1,"method":"sessionNew","params":{"agentId":"chat-1","cwd":"/work"}}
← {"id":1,"result":{"sessionId":"s-1"},"error":null}
→ {"id":2,"method":"prompt","params":{"agentId":"chat-1","sessionId":"s-1","prompt":[{"type":"text","text":"你好"}]}}
← {"type":"acpNotification","agentId":"chat-1","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"你好！"}}}}
← {"type":"acpAgentRequest","agentId":"chat-1","id":7,"method":"session/request_permission","params":{"sessionId":"s-1","options":[{"optionId":"allow","kind":"allow_once"}]}}
→ {"id":3,"method":"acpRespond","params":{"agentId":"chat-1","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}}
← {"id":3,"result":null,"error":null}
← {"id":2,"result":{"stopReason":"end_turn"},"error":null}
```

Runtime 替你发的请求，它们的响应不会出现在 `inbound` 里（你没发过它们）；`session/update` 之类的通知则两边都有。同一条连接上的请求是并发处理的：`prompt` 挂着的时候 `acpRespond` 照常过。

### 5.5 停

- `stop {agentId}`：杀进程。孤儿 agent 任何连接都能停。
- `stopSession {sessionId}`：按会话反查 agent 再停（ACP 没有 `session/close`）。

### 5.6 看

`agents` → 每个活 agent 一条：

```json
{"agentId":"chat-1","pid":4242,"provider":"anthropic","model":"...","connection":"API","cpu":1.5,"memMb":210.3,"uptimeSecs":37}
```

`version` → `{"version":"0.3.0","local":null}`。`ping` → `"pong"`。

---

## 6. 会话

会话 id 就是 agent 在 ACP 里报的 `sessionId`（`session/new` / `session/load` / `session/resume` / `session/fork` 的结果），Runtime 不另起名字。

### 6.1 运行态

Runtime 从流量里推出每个会话的状态，任何变化都广播：

```json
{"type":"runStates","sessions":[{
  "sessionId":"s-1","state":"running","reusableDraft":false,"owner":"stdio:main",
  "cwd":"/Users/me/project","title":"修登录页","since":1757770000000,
  "tasks":[{"id":"t1","title":"跑测试","background":true,"since":1757770001000}],
  "listeningPorts":[3000],"executionId":null,"executionRole":null,"lastActivityAt":1757770005000
}]}
```

| 字段 | 含义 |
| --- | --- |
| `state` | `running` / `requires_action` / `idle` 是 ACP v2 `state_update` 直报的值；`done` 是 Runtime 合成的"跑完了但没人看"：running → idle 时变 `done`，只有 `markRead {sessionId}` 能把它变回 `idle` |
| `reusableDraft` | 会话建了但还没发过 prompt |
| `owner` | 属主（历史字段名，值是属主 id） |
| `cwd` / `title` | 来自 `session/new` 等的 `params.cwd` 与 `session_info_update` 的标题；`setSessionTitle {sessionId,title}` 可以从应用侧推标题 |
| `tasks` | `tool_call_update` 里 `_meta.alwith.runInBackground` 为 true 的工具调用 |
| `listeningPorts` | agent 进程树监听的 TCP 端口（每 2s 扫一次），给"它起了个 dev server"这种提示用 |
| `executionId` / `executionRole` | 执行租约：`session/prompt` 的 `_meta.alwith.executionId` / `executionRole` 会记到会话上；`releaseExecution {executionId}` 清掉 |

`runStates` 方法拿当前全量。

### 6.2 审批

agent 发的 `session/request_permission` 是普通 ACP 请求，走 `lines` 事件到你这里，你按 ACP 回答（`send` 一条响应）。Runtime 只记两件事：哪些权限请求还没答（`state` 因此是 `requires_action`），以及答过的不再回放。谁来审、界面长什么样，是你的应用的事。

### 6.3 接管

```json
{"id": 9, "method": "attachSession", "params": {"sessionId": "s-1", "owner": "window-2"}}
→ {"id": 9, "result": {"agentId":"chat-1","engine":"alwith","provider":"anthropic","pendingAgentRequests":[{"id":7,"method":"session/request_permission","params":{...}}]}, "error": null}
```

- 会话不在任何活 agent 上 → `result` 为 null。
- 成功后这条连接（或子属主）成为该 agent 的属主；`pendingAgentRequests` 是 agent 还没得到回答的请求，接管方把它们当作刚收到的 `acpAgentRequest` 事件处理，用 `acpRespond` 带同一个 `id` 回答。
- `release {sessionId}`：放弃属主，agent 改挂无主。
- `agentForSession {sessionId}` → agentId 或 null。

### 6.4 历史

每个会话的 ACP 帧都记进日志（默认每会话 16MB，超了丢最早的），按 `sequence` 单调编号：

- `sessionEvents {sessionId, afterSequence?, limit?}` → `[{"sequence":12,"recordedAt":1757770000000,"direction":"in"|"out","line":"{...}"}]`，一页最多 2000 条，晚加入的端按 `afterSequence` 翻页补齐。已答过的 `session/request_permission` 不会再给。
- `sessionReplay {sessionId}` → 全部帧原文（字符串数组），一次拿全。
- `sessionLifecycle {sessionId}` → 只要生命周期帧：`session/prompt`、`session/request_permission`、`tool_call_update`，不含 AI 正文，agent 退出后仍可查。

stdio 入口的事件队列（8192 条）满了会丢事件，腾出后先补一条 `{"type":"lagged","dropped":n}`，你据此用 `sessionEvents` 回放。ws 入口不丢，直接断开慢连接。

---

## 7. 模块

模块是包：一个目录，里面一份 `alwith-module.json` 加一个可执行入口。Runtime 启动时扫 `ALWITH_MODULES_DIR`（通常是应用的 `node_modules`）下的 `*/alwith-module.json` 和 `@*/*/alwith-module.json`，每个 spawn 成子进程。你的应用在 `package.json` 里依赖模块包，就像依赖任何 npm 包。

### 7.1 清单

```json
{
  "name": "alwith-dev",
  "version": "0.1.0",
  "entry": {
    "aarch64-apple-darwin": "bin/alwith-dev",
    "x86_64-pc-windows-msvc": "bin/alwith-dev.exe",
    "default": "bin/alwith-dev"
  },
  "runtime": ">=0.3.0",
  "persistent": false,
  "capabilities": ["filesystem", "subprocess"]
}
```

`entry` 按本机 target triple 取，没有就取 `default`，路径相对模块目录。`runtime` 是最低 Runtime 版本(`>=X.Y.Z`),不满足的模块不加载;`persistent`、`capabilities` 目前只记录不校验。

### 7.2 模块进程说什么

模块在自己的 stdin/stdout 上说和应用一模一样的帧，三种：

1. **模块 → Runtime 请求** `{id, method, params}`：模块就是一个客户端，能调 Runtime 的任何方法（`start` 自己的 agent、看 `runStates`…），属主是 `module:<name>`。Runtime 回 `{id, result|error}`。
2. **Runtime → 模块请求**：应用调 `modules/<name>/<method>`，Runtime 转给模块 `{id, method: "<method>", params}`（前缀已剥掉），模块回 `{id, result|error}`，`error` 同样是 `{code, message, data}`，原样转回应用。两个方向各自编 id。
3. **事件** `{type, ...}`：Runtime 的全部事件原样推给模块；模块发出的事件被包成 `{"type":"module","module":"<name>","event":{...}}` 广播给所有应用连接。

进程环境：cwd 是模块目录，`ALWITH_MODULE_NAME` 是模块名，stderr 直通 Runtime 的 stderr。模块的 stdin 到 EOF（Runtime 退出）就该退出。

用本仓的客户端写模块：Rust 用 `RuntimeClient::over_with_handler(stdin, stdout, handler)`，TS 用 `ProcessRuntimeClient`；`handler` 收应用的请求，`emit` 发事件，其余方法照常调 Runtime。

### 7.3 应用怎么用模块

- `modules` → `[{"name","version","persistent","capabilities","alive"}]`
- `modules/<name>/<method>` 任意参数，模块答什么就是什么。
- 模块事件：`{"type":"module","module":"<name>","event":{"type":"...", ...}}`。TS 客户端有 `onModuleEvent(name, handler)` 拆掉这层信封。

---

## 8. 最小 WorkBuddy

TypeScript，浏览器或 Node 都行：

```ts
import { WebSocketRuntimeClient } from "@alwith/api"

const runtime = new WebSocketRuntimeClient("ws://127.0.0.1:4321", token)

// 1. 起一个 agent
await runtime.start("chat-1", { engine: "alwith", cwd })

// 2. 聊:Runtime 替你说 ACP。内容与工具调用经 onAcpNotification 到,审批经 onAcpAgentRequest 问你
runtime.onAcpNotification(({ method, params }) => {
  if (method === "session/update") render(params)
})
runtime.onAcpAgentRequest(async ({ agentId, id, method, params }) => {
  if (method === "session/request_permission")
    await runtime.acpRespond(agentId, id, { outcome: { outcome: "selected", optionId: await askUser(params) } })
})
const { sessionId } = await runtime.sessionNew("chat-1", cwd)
const { stopReason } = await runtime.prompt("chat-1", sessionId, [{ type: "text", text: "你好" }])

// 3. 运行态与历史
runtime.onRunStates(states => renderSidebar(states))
const history = await runtime.sessionEvents(sessionId)
```

Rust（比如做一个连接器或模块）：

```rust
use alwith_api::{ClientEvent, RuntimeClient, RuntimeEvent};

let mut command = tokio::process::Command::new("alwith-runtime");
command.env("ALWITH_RUNTIME_ENGINES", r#"{"alwith":{"command":"/opt/alwith-cli","args":["--acp"]}}"#);
let client = RuntimeClient::spawn(command).await?;
client.start("chat-1", serde_json::json!({ "engine": "alwith", "cwd": "/work" }), None).await?;
client.send("chat-1", r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#, None).await?;
let mut events = client.events();
while let Ok(event) = events.recv().await {
    if let ClientEvent::Runtime(RuntimeEvent::Lines { agent_id, lines }) = event { /* ACP 帧 */ }
}
```

不用客户端也行：任何能开 WebSocket、按行读写 JSON 的东西都能直接说这个协议。

---

## 9. 方法总表

| 方法 | 参数 | 结果 | 谁能调 |
| --- | --- | --- | --- |
| `start` | `agentId, provider, owner?` | null（同名进程还活着则报错） | 任何连接 |
| `send` | `agentId, line, owner?` | null | 属主 |
| `stop` | `agentId, owner?` | null | 属主，或 agent 是孤儿 |
| `attachSession` | `sessionId, owner?` | AttachInfo 或 null | 任何连接（成功即成为属主） |
| `releaseSession` | `sessionId, owner?` | null | 属主 |
| `stopSession` | `sessionId, owner?` | null | 属主 |
| `detachOwner` | `owner` | null | 任何连接（只影响自己的子属主） |
| `releaseExecution` | `executionId` | bool | 任何连接 |
| `agentForSession` | `sessionId` | agentId 或 null | 任何连接 |
| `markRead` | `sessionId` | null | 任何连接 |
| `setSessionTitle` | `sessionId, title` | null | 任何连接 |
| `sessionLifecycle` | `sessionId` | 帧数组 | 任何连接 |
| `sessionEvents` | `sessionId, afterSequence?, limit?` | 帧数组 | 任何连接 |
| `sessionReplay` | `sessionId` | 字符串数组 | 任何连接 |
| `runStates` | — | 会话运行态数组 | 任何连接 |
| `agents` | — | agent 数组 | 任何连接 |
| `version` | — | `{version, local}` | 任何连接 |
| `ping` | — | `"pong"` | 任何连接 |
| `initialize` | `agentId, info?, capabilities?, owner?` | ACP 握手结果 | 属主 |
| `sessionNew` / `sessionLoad` / `sessionResume` / `sessionFork` | `agentId, cwd, …, meta?, owner?` | ACP 结果 | 属主 |
| `prompt` | `agentId, sessionId, prompt, meta?, owner?` | `{stopReason, _meta}` | 属主 |
| `cancel` | `agentId, sessionId, owner?` | null | 属主 |
| `acpRequest` / `acpNotify` / `acpRespond` | `agentId, method \| id, params \| result, owner?` | ACP 结果 / null | 属主 |
| `setSlowMode` | `delayMs` | null | 任何连接（开发用） |
| `modules` | — | 模块状态数组 | 任何连接 |
| `modules/<name>/<method>` | 模块定 | 模块定 | 任何连接 |

事件：`inbound`、`outbound`、`wire`、`stderr`、`exit`、`runStates`、`acpNotification`、`acpAgentRequest`、`lagged`（stdio）、`module`。

## 10. 版本

- 帧协议名 `alwith-runtime-v1`。加字段、加方法不改名；改语义才会有 v2。
- `version.version` 与 `alwith-runtime --version` 是同一个数，本仓的包版本与它同步发布。
- 模块清单的 `runtime` 字段写它需要的最低 Runtime 版本。

## 11. 不在这里的东西

- **身份与登录**：Runtime 不认用户。谁在用、要不要登录，是应用的事。
- **审批的记录与策略**：Runtime 只知道哪些权限请求没答；谁答的、为什么答，应用自己记。
- **存储**：会话日志之外的一切（设置、文件、数据库）都不经 Runtime。
