# ALwith Runtime Protocol (alwith-runtime-v1)

This document is for people building their own WorkBuddy: with only the `alwith-runtime` binary, this protocol and this repo's clients, and without reading the source of any ALwith application, you can start agents, chat, approve requests and view history.

The Runtime does only four things: hosts agent processes, maintains session run state, keeps session journals, and loads modules. It does not parse the conversation between you and the agent, and it does not handle UI, identity or storage; those are your application's business.

---

## 1. What you get

| Item | Where | What it does |
| --- | --- | --- |
| `alwith-runtime` binary | npm `@alwith/runtime`: `optionalDependencies` installs one `@alwith/runtime-<os>-<cpu>` per platform, and at build time `stageRuntime()` verifies the sha and copies it into your sidecar; without npm, the tgz on the registry is a public HTTPS address and `curl` works too | The only shared process; your application spawns it or connects to it |
| `@alwith/api` | This repo's `packages/api` | TypeScript: `./runtime` connects to the Runtime, `./agent` owns agents, `./session` holds session state; transports are WebSocket / Tauri relay / Node child process |
| `alwith-api` | This repo's `crates/api` | Rust: protocol types + a client (feature `client`): spawn a Runtime over stdio, or attach to any byte stream |
| An ACP agent | Your choice: `alwith-cli --acp`, `codex-acp-v2`, any process that speaks ACP | The Runtime only starts it and forwards its traffic |

Between the agent and your application the protocol is [ACP](https://agentclientprotocol.com) (Agent Client Protocol, JSON-RPC 2.0), which the Runtime forwards as is. This document covers only the Runtime's own protocol; for ACP see its specification.

---

## 2. Starting the Runtime

Two entry points, with identical frames.

### 2.1 stdio (your application spawns it)

```sh
ALWITH_RUNTIME_ENGINES='{"alwith":{"command":"/path/alwith-cli","args":["--acp"]}}' \
alwith-runtime --listen stdio://
```

- First line on stdout: `{"type":"ready","transport":"stdio"}`; after that requests come in on stdin, and responses and events go out on stdout, one frame per line.
- Only protocol frames appear on stdout; logs always go to stderr.
- stdin reaching EOF = the application left: the Runtime stops modules, kills all agents and exits.
- Sending `{"id":n,"method":"shutdown"}` also means leaving: you first receive the acknowledgement `{"id":n,"result":null}`, then it goes through the same wrap-up as EOF. A host that spawns a child process may not be able to close its own end of stdin (a Tauri sidecar cannot), so a method is provided. **Exit chain**: send `shutdown` first, wait for the process to end (the Runtime gives modules and agents a 2 second wrap-up window internally), and force-kill on timeout; SIGKILLing the Runtime directly leaves the process groups spawned by agents alive.
- No token: the pipe itself is the authorization. This connection's owner id is fixed as `stdio`.
- The writer is a separate task: when the application does not read stdout, only events get blocked, while `shutdown` and EOF are still handled immediately.
- `--listen stdio://` is the default and can be omitted.

### 2.2 WebSocket (browsers, remote)

```sh
ALWITH_RUNTIME_TOKEN=secret ALWITH_RUNTIME_ADDR=127.0.0.1:0 \
ALWITH_RUNTIME_ENGINES='{...}' alwith-runtime --listen ws://
# or directly --listen ws://127.0.0.1:4321
```

- Once up, it prints one line on stdout: `{"type":"ready","transport":"ws","url":"ws://127.0.0.1:52341","port":52341}`.
- The WebSocket is mounted at the root path `/`; `GET /readyz` and `GET /healthz` return `ok` for probes.
- Handshake authentication goes through subprotocols (the browser `WebSocket` constructor cannot set custom headers):

```
Sec-WebSocket-Protocol: alwith-runtime-v1, alwith-auth.<token>
```

Missing either one gives 401. The subprotocol the server replies with is `alwith-runtime-v1`.

- Each connection's owner id is `web-<uuid>`.
- Slow connections (event queue full at 1024 entries) are disconnected; after reconnecting, use `sessionEvents` to catch up by `sequence`.

### 2.3 Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `ALWITH_RUNTIME_ENGINES` | Yes | Engine table, JSON, see §5.1 |
| `ALWITH_RUNTIME_TOKEN` | Required for ws | Handshake token |
| `ALWITH_RUNTIME_ADDR` | No | Listen address when `--listen ws://` has no address, default `127.0.0.1:0` |
| `ALWITH_RUNTIME_JOURNAL` | No | Session journal directory, default `alwith/runtime/sessions` under the platform cache directory |
| `ALWITH_RUNTIME_ATTENTION` | No | Directory of `run-states.json` (the run states, kept across restarts) and `agents.json` (leases of the agent processes it started, reclaimed on the next start), default `alwith/Runtime` under the platform data directory |
| `ALWITH_RUNTIME_PARENT_PID` | No | Parent process pid; the Runtime exits by itself when the parent is gone (unix) |
| `ALWITH_MODULES_DIR` | No | Module directory (the application's `node_modules`), see §7 |

`alwith-runtime --version` prints the version; the `version` method reports the same version.

---

## 3. Frames

One JSON per line, ending in `\n`. Three kinds of frames, distinguished by their fields:

**Request** (application → Runtime)

```json
{"id": 1, "method": "runStates", "params": {}}
```

`id` is a u64 the application picks itself, and `params` may be omitted. Method names are camelCase.

**Response** (Runtime → application)

```json
{"id": 1, "result": [...], "error": null}
{"id": 2, "result": null, "error": {"code": -32000, "message": "unknown engine foo; known: alwith, codex"}}
```

On success `error` is null; on failure `result` is null and `error` is a JSON-RPC shaped `{code, message, data}` (`data` is null when absent). A request frame that fails to parse is also answered with the original `id` (0 if it cannot be obtained), so a pending entry paired by id never hangs forever.

The Runtime's own `code` values are only three:

| code | Meaning |
| --- | --- |
| `-32601` | No such method |
| `-32602` | Bad parameters (the frame is not valid JSON, a field is missing, a type is wrong) |
| `-32000` | The Runtime cannot do it: no such agent, not the owner, the agent exited… |

When a method of the `acpRequest` kind (§5.4) fails, `error` is the ACP error the agent returned, as is (`code` / `data` are the agent's, for example alwith-cli's `-32000 auth_required`). The client uses `-32001` for a local disconnect; the Runtime never sends it.

**Event** (Runtime → application, pushed proactively)

```json
{"type": "inbound", "agentId": "chat-1", "lines": ["{\"jsonrpc\":\"2.0\",...}"]}
```

`type` is the discriminator. Events are broadcast globally to all connected applications (and modules), regardless of owner.

Unknown method: `{"code": -32601, "message": "unknown runtime method <name>"}`.

---

## 4. Owners

- Each connection is an **owner** (`stdio` for stdio, `web-<uuid>` for ws, `module:<name>` for a module).
- An agent started by `start` belongs to the connection that started it. **Write** operations (`send`, the ACP-layer ones, `stop`, `releaseSession`, `stopSession`) can only be done by the owner; reads (`runStates`, `sessionEvents`, `agents`…) and `markRead` can be done by any connection.
- **Sub-owners**: write requests and `attachSession` may carry `owner: "<label>"` (for example a desktop window label), and the owner is recorded as `<connection>:<label>`. The connection itself has write access to the agents of all its sub-owners, while sub-owners cannot write to each other. `detachOwner {owner}` makes the agents under a sub-owner ownerless (the processes are not killed).
- When a connection drops, the agents under it are **not killed**; they become ownerless (orphans). Any connection can `stop` an orphan, or claim it via `attachSession` and keep using it.

That is the entire mechanism behind "sessions keep running in the background and any window can take over".

---

## 5. Agents

### 5.1 The engine table and `start`

The engine table tells the Runtime where each kind of agent's executable is:

```json
{
  "alwith": { "command": "/opt/alwith-cli", "args": ["--acp"], "env": {} },
  "codex":  { "command": "/opt/codex-acp-v2", "env": { "CODEX_PATH": "/opt/codex" } }
}
```

`start` starts an agent process:

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

- `agentId` is named by the application. **At most one process per `agentId` can exist at a time**: calling `start` while it is still alive fails immediately with `agent <id> is still running`. Swapping the engine = `stop` → wait for the `exit` event → `start`.
- Why implicit replacement is not allowed: after a process is killed it still spends a few dozen milliseconds draining its stdout. If starting while killing were allowed, the application would receive frames and exit events it could not attribute. Starting only after it has really exited means such frames simply do not exist.
- A product rule that follows: an engine should not be swapped while a turn is unfinished. To swap, `cancel` first and wait for the turn to wrap up.
- `launch.engine` looks up the engine table; `cwd`, `args` and `env` are appended on top of the engine table.
- `launch.provider` / `model` / `connection` are only labels; the Runtime places them as is in the results of `agents` and `attachSession` and does not interpret them.

#### Optional provider launch adapter

The raw launch is kept, suitable for CLI / ACP adapters that bring their own configuration. Engine names are not restricted to alwith or dsh; provider launch uses the adaptation method declared in the engine table:

```json
{"agentId":"chat-1","launch":{"providerConfig":{"engine":"alwith","providerId":"deepseek","modelId":"chosen-model"},"overrides":{"args":[],"env":{},"envRemove":[]}}}
```

The deployer selects an installed module through `ALWITH_RUNTIME_LAUNCH_RESOLVER`. The Runtime hands `providerConfig` to that module's private pipe to resolve, and then the Runtime itself launches the agent. The official `alwith-services` module reads `ai.providerConfigs` from `ALWITH_SETTINGS_PATH` and reuses the CLI adapter library; it does not require fs/store/QA to be enabled, and does not rewrite the CLI's models, tools, Skills or MCP. Without an adapter module the raw launch still works on its own, while providerConfig fails explicitly. The Runtime's build does not depend on these modules or on the client SDK.

- `providerConfig` supports engine, providerId, modelId, fastModelId, baseUrl, compatOverride, maxOutputTokens, modelOptions, supportsEffort, workspaceRoot, harnessPreset and dshProviderRoute; the last two apply only to the corresponding adapters.
- At the top level only `overrides` may accompany it; raw launch fields cannot be mixed in. overrides allows only args, env, envRemove and cwd; args are appended, env overrides, and cwd overrides when it has a value. When an authorized root is configured, cwd is also subject to path validation.
- The raw launch also supports `envRemove: string[]`. The order of application is engine default environment → envRemove → explicit env, so that switching providers does not inherit variables that were asked to be removed.
- When using providerConfig, do not repeat in the engine table the `--acp` or dsh entry arguments that the adapter provides.
- `engines/probeCapabilities` is provided by an optional module and accepts providerId, modelId and optional baseUrl and compatOverride; keys are resolved in the module process, and probing actually makes requests to the provider.
- The above are trusted-client capabilities and do not constitute a multi-tenant sandbox or platform account authentication.

#### Engine adapter declaration and discovery

The official adapter module reads the `providerAdapter` of an engine table entry and translates the provider selection into CLI arguments and environment; the Runtime does not interpret the specific adapter kind. The CLI must still conform to the ACP contract the Runtime supports.

```json
{"company-cli":{"command":"/opt/company-agent","providerAdapter":{"kind":"environment","args":["--acp"],"env":{"COMPANY_TOKEN":"apiKey","COMPANY_MODEL":"modelId","COMPANY_URL":"baseUrl"},"envRemove":["OLD_TOKEN"]}}}
```

- `kind` is `raw`, `alwith`, `dsh` or `environment`. The first three accept no extra fields. When not declared, the standard engine names alwith / dsh use the corresponding built-in adapter and the rest are raw; a custom name can explicitly choose any adapter.
- raw does not accept providerConfig and uses the raw launch; environment only maps env and appends fixed args, and performs no shell interpolation. The values of env are limited to providerId, modelId, fastModelId, apiKey and baseUrl.
- If the request maps apiKey but no key is configured, it fails explicitly; when other optional fields are missing, the corresponding environment variable is removed, to avoid inheriting an old value. envRemove is applied first and explicit env after.
- `engines/capabilities` returns `{schemaVersion:1,engines:[{engine,providerAdapter}]}`, sorted by engine name and containing no credentials; this is the configured adaptation method, not a model capability probe result.

#### Resource service configuration of optional modules

The configuration below is interpreted by the standalone `alwith-services` module and is not a Runtime build dependency. The `routes` in the module manifest declare the externally visible namespaces, and the Runtime only forwards calls and the connection identity. The client's existing method names and service event formats do not change.

The deployment environment variable `ALWITH_RUNTIME_SERVICES` is JSON, for example:

```json
{"schemaVersion":1,"fs":{"roots":["/srv/work"]},"store":{"dataDir":"/srv/app/data","cacheDir":"/srv/app/cache"}}
```

fs, git, shell and qa each accept non-empty absolute-path roots; store separately accepts distinct absolute-path dataDir / cacheDir. Capabilities not listed are not enabled; unknown fields or versions cause an error. `services/capabilities` returns `{schemaVersion:1,enabled:[...]}` with capability names sorted; `services/ping` does not require any resource capability to be enabled. Calling a resource capability that is not enabled fails explicitly.

`ALWITH_FS_ROOTS` is only an independent path constraint for the provider launch cwd and does not enable resource services; `ALWITH_SETTINGS_PATH` only specifies provider configuration. Path restrictions are not an operating-system sandbox for the shell / agent. QA platform credentials are provided by the Desktop business adapter and are not required to be moved into the Runtime; when a server lacks a credential provider, the related QA operations fail explicitly and other capabilities are unaffected.

### 5.2 `send`: one line of ACP

```json
{"id": 2, "method": "send", "params": {"agentId": "chat-1", "line": "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1}}"}}
```

`line` is one complete ACP JSON-RPC frame, which the Runtime writes to the agent's stdin. It looks at only two things and passes everything else through as is:

1. **`initialize` handshakes only once**: the agent's `initialize` response is cached. When you send `initialize` again afterwards (switching windows, taking over, reloading), the Runtime replays the response from the cache directly and does not disturb the agent. If the process has been replaced there is no cache, and this one is delivered to the agent as usual.
2. **`session/resume`**: before sending, the Runtime claims `params.sessionId` first, so the same session cannot be resumed by two agents at once.

A failed write (the process is dead) → `send` returns an error and broadcasts a synthetic ACP notification:

```json
{"jsonrpc":"2.0","method":"_alwith/runtimeError","params":{"message":"send to agent chat-1 failed: ..."}}
```

It goes through the `inbound` event, so your ACP client can see it on the same stream.

### 5.3 Agent output

| Event | Meaning |
| --- | --- |
| `{"type":"inbound","agentId","lines":[...]}` | ACP frames from agent → application, batched every 16ms |
| `{"type":"outbound","agentId","line","sessionId"?,"sequence"?}` | The line you `send`, shown to other connections as "who sent what". Frames that entered the session journal carry `sessionId` and `sequence` (see §6.4) |
| `{"type":"wire","agentId","outbound":bool,"lines":[...]}` | The text that actually went on the wire, for protocol diagnostics |
| `{"type":"stderr","agentId","line"}` | One line of the agent's stderr |
| `{"type":"exit","agentId"}` | The process exited. There is only one process per agentId at a time, so this is unambiguous: receiving it means "this agent of mine is gone", and it is also the moment you can `start` again |

You can also speak the protocol with your own ACP SDK: `send` writes a line and `inbound` receives a line, which is just an ND-JSON stream. But there is no need; see §5.4.

### 5.4 Let the Runtime speak ACP for you

`send` / `inbound` above is the raw channel. You do not need to touch it day to day: the Runtime speaks ACP v2 itself, you call only session-level methods, and you receive already-unpacked events.

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | `agentId, info?, capabilities?` | The result of the ACP handshake. Optional: call it only when you want to declare your own client capabilities (such as elicitation); session methods handshake automatically with a default identity; once done, the cached result is returned |
| `sessionNew` | `agentId, cwd, mcpServers?, meta?` | The result of ACP `session/new`, with `sessionId` inside. On the first call the Runtime handshakes for you first |
| `sessionLoad` / `sessionResume` / `sessionFork` | `agentId, sessionId, cwd, …` | Same as above |
| `prompt` | `agentId, sessionId, prompt: [...], meta?` | Returns only when the turn ends: `{stopReason, _meta}` |
| `cancel` | `agentId, sessionId` | null (sends a `session/cancel` notification) |
| `acpRespond` | `agentId, id, result? \| error?` | null. Answers a request sent by the agent |
| `acpRequest` / `acpNotify` | `agentId, method, params, id?` | Any ACP method / notification; the Runtime picks the id and waits for the response. An escape hatch: methods the Runtime does not wrap go through here. When the agent returns an error, the response's `error` is that ACP error as is. To be able to withdraw a request (`acpNotify` sending `$/cancel_request {requestId}`), pass your own `id` (a string or number; an unanswered id on the same agent cannot be reused) |

`meta` is placed as is into ACP's `_meta` (for example alwith-cli's `_meta.alwith.maxBudgetUsd`).

Events:

| Event | Meaning |
| --- | --- |
| `{"type":"acpNotification","agentId","method","params","sessionId"?,"sequence"?}` | A notification from the agent: every piece of content, tool call and status of `session/update` |
| `{"type":"acpAgentRequest","agentId","id","method","params","sessionId"?,"sequence"?}` | A request from the agent: `session/request_permission`, `elicitation/create`, `fs/*`…; answer with `acpRespond` carrying the same `id` |

`sessionId` / `sequence` appear only on frames that entered the session journal (`session/update`, `session/prompt`, `session/request_permission`), and equal the sequence number of the same frame in `sessionEvents`: you use it to detect missed frames and catch up, see §6.4.

What a turn looks like:

```json
→ {"id":1,"method":"sessionNew","params":{"agentId":"chat-1","cwd":"/work"}}
← {"id":1,"result":{"sessionId":"s-1"},"error":null}
→ {"id":2,"method":"prompt","params":{"agentId":"chat-1","sessionId":"s-1","prompt":[{"type":"text","text":"Hello"}]}}
← {"type":"acpNotification","agentId":"chat-1","method":"session/update","params":{"sessionId":"s-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello!"}}}}
← {"type":"acpAgentRequest","agentId":"chat-1","id":7,"method":"session/request_permission","params":{"sessionId":"s-1","options":[{"optionId":"allow","kind":"allow_once"}]}}
→ {"id":3,"method":"acpRespond","params":{"agentId":"chat-1","id":7,"result":{"outcome":{"outcome":"selected","optionId":"allow"}}}}
← {"id":3,"result":null,"error":null}
← {"id":2,"result":{"stopReason":"end_turn"},"error":null}
```

Responses to requests the Runtime sends on your behalf do not appear in `inbound` (you never sent them); notifications such as `session/update` appear on both sides. Requests on the same connection are handled concurrently: while `prompt` is pending, `acpRespond` still goes through.

### 5.5 Stopping

- `stop {agentId}`: kills the process. Any connection can stop an orphan agent.
- `stopSession {sessionId}`: looks up the agent by session and then stops it (ACP has no `session/close`).

### 5.6 Looking

`agents` → one entry per live agent:

```json
{"agentId":"chat-1","pid":4242,"provider":"anthropic","model":"...","connection":"API","cpu":1.5,"memMb":210.3,"uptimeSecs":37}
```

`version` → `{"version":"0.3.0","local":null}`. `ping` → `"pong"`.

---

## 6. Sessions

The session id is the `sessionId` the agent reports in ACP (the result of `session/new` / `session/load` / `session/resume` / `session/fork`); the Runtime does not invent its own names.

### 6.1 Run state

The Runtime infers each session's state from the traffic and broadcasts any change:

```json
{"type":"runStates","sessions":[{
  "sessionId":"s-1","state":"running","reusableDraft":false,"owner":"stdio:main",
  "cwd":"/Users/me/project","title":"Fix login page","since":1757770000000,
  "tasks":[{"id":"t1","title":"Run tests","background":true,"since":1757770001000}],
  "listeningPorts":[3000],"executionId":null,"executionRole":null,"lastActivityAt":1757770005000,
  "version":4,"interruption":null
}]}
```

| Field | Meaning |
| --- | --- |
| `state` | `running` / `requires_action` / `idle` are values reported directly by ACP v2 `state_update`; `done` is synthesized by the Runtime to mean "finished but nobody has looked": it becomes `done` on running → idle, and only `markRead {sessionId}` can turn it back to `idle` |
| `reusableDraft` | The session was created but no prompt has been sent yet |
| `owner` | The owner (a historical field name; the value is the owner id) |
| `version` | Monotonic per session: moves when `state` or `interruption` changes (not with activity in the same state), so a version names one attention state. Survives a Runtime restart |
| `interruption` | Why the Runtime holds the session in `requires_action` without the agent asking: `"runtime restarted"` when the session was `running` as the Runtime stopped (its turn was cut short). Cleared by the next state the agent reports; `null` otherwise. Run states survive a restart: `done` stays unread, `requires_action` stays, nothing is lowered to `idle` |
| `cwd` / `title` | From the `params.cwd` of `session/new` and the like, and from the title in `session_info_update`; `setSessionTitle {sessionId,title}` can push a title from the application side |
| `tasks` | Tool calls in `tool_call_update` whose `_meta.alwith.runInBackground` is true |
| `listeningPorts` | TCP ports the agent's process tree is listening on (scanned every 2s), for hints like "it started a dev server" |
| `executionId` / `executionRole` | Execution lease: the `_meta.alwith.executionId` / `executionRole` of `session/prompt` are recorded on the session; `releaseExecution {executionId}` clears them |

The `runStates` method returns the current full set.

### 6.2 Approval

A `session/request_permission` sent by the agent is an ordinary ACP request; it reaches you through the `lines` event, and you answer it per ACP (`send` a response). The Runtime records only two things: which permission requests are still unanswered (which makes `state` `requires_action`), and that answered ones are not replayed. Who reviews and what the UI looks like is your application's business.

### 6.3 Taking over

```json
{"id": 9, "method": "attachSession", "params": {"sessionId": "s-1", "owner": "window-2"}}
→ {"id": 9, "result": {"agentId":"chat-1","engine":"alwith","provider":"anthropic","pendingAgentRequests":[{"id":7,"method":"session/request_permission","params":{...}}]}, "error": null}
```

- The session is not on any live agent → `result` is null.
- On success this connection (or sub-owner) becomes the agent's owner; `pendingAgentRequests` are requests the agent has not yet received an answer to, and the taker-over treats them as `acpAgentRequest` events just received, answering with `acpRespond` carrying the same `id`.
- `release {sessionId}`: gives up ownership, and the agent becomes ownerless.
- `agentForSession {sessionId}` → agentId or null.

### 6.4 History

Every session's ACP frames are recorded in the journal (16MB per session by default; when exceeded the earliest are dropped), numbered monotonically by `sequence`:

- `sessionEvents {sessionId, afterSequence?, limit?}` → `[{"sequence":12,"recordedAt":1757770000000,"direction":"in"|"out","line":"{...}"}]`, at most 2000 entries per page; a late-joining side pages through with `afterSequence` to catch up. Answered `session/request_permission` frames are not returned again.
- `sessionReplay {sessionId}` → the raw text of all frames (an array of strings), fetched all at once.
- `sessionLifecycle {sessionId}` → lifecycle frames only: `session/prompt`, `session/request_permission`, `tool_call_update`, without AI body text, still queryable after the agent exits.

**Missed frames and catching up.** Event delivery is best-effort: when the stdio entry's event queue (8192 entries) is full it drops events, and once room frees up it first sends `{"type":"lagged","dropped":n}`; the ws entry does not drop but disconnects the slow connection directly (which also needs catching up after reconnecting). Catching up relies on sequence numbers: live events that entered the journal carry `sessionId` and `sequence`, equal to the sequence number of the same frame in `sessionEvents`, so the client has only one thing to do:

- For each session, remember the last `sequence` seen; when a frame arrives whose number jumped ahead (`sequence > last + 1`), or a `lagged` is received, or after reconnecting, call `sessionEvents {sessionId, afterSequence: last}` to fetch the frames in between, hand them to the application in order, and then continue with the live stream. A number not greater than `last` is a duplicate and is dropped; a number restarting from 0 means the engine replayed history (a resume with `replayFrom` clears the journal), so accept it as is.
- The journal keeps only its latter half beyond 16MB: if while catching up the first frame's number still skips past `last + 1`, it cannot be recovered. At that point the application should be told explicitly (reload that session) and must not pretend it is contiguous.
- Do not catch up when first seeing a session: a late-joining side has to fetch history with `sessionEvents` itself anyway, which is part of the takeover flow.

Both `@alwith/api` clients (TS `FrameRuntimeClient`, Rust `RuntimeClient`) do this: the application only receives events in order and without duplicates, and gets a `gap` for what cannot be recovered (TS `onGap`, Rust `ClientEvent::Gap {sessionId, from, to}`). If you write your own client, follow the three rules above.

---

## 7. Modules

A module is a package: a directory containing an `alwith-module.json` and an executable entry. At startup the Runtime scans `ALWITH_MODULES_DIR` (usually the application's `node_modules`) for `*/alwith-module.json` and `@*/*/alwith-module.json`, and spawns each as a child process. Your application depends on module packages in `package.json`, just like any npm package.

### 7.1 Manifest

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

`entry` is chosen by the local target triple, falling back to `default`, with paths relative to the module directory. `runtime` is the minimum Runtime version (`>=X.Y.Z`); modules that do not satisfy it are not loaded; `persistent` and `capabilities` are currently only recorded, not validated.

### 7.2 What a module process says

On its own stdin/stdout a module speaks exactly the same frames as an application, three kinds:

1. **Module → Runtime request** `{id, method, params}`: a module is a client and can call any Runtime method (`start` its own agent, look at `runStates`…), with owner `module:<name>`. The Runtime replies `{id, result|error}`.
2. **Runtime → module request**: the application calls `modules/<name>/<method>`, and the Runtime forwards `{id, method: "<method>", params}` to the module (prefix stripped); the module replies `{id, result|error}`, where `error` is likewise `{code, message, data}` and is passed back to the application as is. Each direction picks its own ids.
3. **Event** `{type, ...}`: all of the Runtime's events are pushed to the module as is; events the module emits are wrapped as `{"type":"module","module":"<name>","event":{...}}` and broadcast to all application connections.

Process environment: cwd is the module directory, `ALWITH_MODULE_NAME` is the module name, and stderr goes straight through to the Runtime's stderr. A module should exit when its stdin reaches EOF (the Runtime exited).

To write a module with this repo's clients: Rust uses `RuntimeClient::over_with_handler(stdin, stdout, handler)`, and TS uses `@alwith/api/module`'s `ModuleRuntimeClient({input: process.stdin, output: process.stdout, handle})`; `handle(method, params, signal)` receives requests, `emit` sends events, and other methods call the Runtime as usual. The IDs of the two directions are independent, and responses are still read while a request is being handled. EOF aborts the signal of every handler, rejects in-flight requests and discards late replies; business handlers must respect the signal. `ProcessRuntimeClient` is for an application launching a new Runtime and is not a module endpoint. A module's stdout carries only protocol frames; logs go to stderr.

### 7.3 How an application uses modules

- `modules` → `[{"name","version","persistent","capabilities","alive"}]`
- `modules/<name>/<method>` with arbitrary params; whatever the module answers is the result.
- Module events: `{"type":"module","module":"<name>","event":{"type":"...", ...}}`. The TS client has `onModuleEvent(name, handler)` to unwrap this envelope.

---

## 8. A minimal WorkBuddy

TypeScript, works in a browser or Node:

```ts
import { WebSocketRuntimeClient } from "@alwith/api"

const runtime = new WebSocketRuntimeClient("ws://127.0.0.1:4321", token)

// 1. Start an agent
await runtime.start("chat-1", { engine: "alwith", cwd })

// 2. Chat: the Runtime speaks ACP for you. Content and tool calls arrive via onAcpNotification, and approvals ask you via onAcpAgentRequest
runtime.onAcpNotification(({ method, params }) => {
  if (method === "session/update") render(params)
})
runtime.onAcpAgentRequest(async ({ agentId, id, method, params }) => {
  if (method === "session/request_permission")
    await runtime.acpRespond(agentId, id, { outcome: { outcome: "selected", optionId: await askUser(params) } })
})
const { sessionId } = await runtime.sessionNew("chat-1", cwd)
const { stopReason } = await runtime.prompt("chat-1", sessionId, [{ type: "text", text: "Hello" }])

// 3. Run state and history
runtime.onRunStates(states => renderSidebar(states))
const history = await runtime.sessionEvents(sessionId)
```

Rust (for example to build a connector or a module):

```rust
use alwith_api::{ClientEvent, RuntimeClient, RuntimeEvent};

let mut command = tokio::process::Command::new("alwith-runtime");
command.env("ALWITH_RUNTIME_ENGINES", r#"{"alwith":{"command":"/opt/alwith-cli","args":["--acp"]}}"#);
let client = RuntimeClient::spawn(command).await?;
client.start("chat-1", serde_json::json!({ "engine": "alwith", "cwd": "/work" }), None).await?;
client.send("chat-1", r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#, None).await?;
let mut events = client.events();
while let Ok(event) = events.recv().await {
    if let ClientEvent::Runtime(RuntimeEvent::Lines { agent_id, lines }) = event { /* ACP frames */ }
}
```

You can also skip the client: anything that can open a WebSocket and read and write JSON line by line can speak this protocol directly.

---

## 9. Method reference

| Method | Params | Result | Who can call |
| --- | --- | --- | --- |
| `start` | `agentId, provider, owner?` | null (errors if a process with the same name is still alive) | Any connection |
| `send` | `agentId, line, owner?` | null | Owner |
| `stop` | `agentId, owner?` | null | Owner, or the agent is an orphan |
| `attachSession` | `sessionId, owner?` | AttachInfo or null | Any connection (becomes owner on success) |
| `releaseSession` | `sessionId, owner?` | null | Owner |
| `stopSession` | `sessionId, owner?` | null | Owner |
| `detachOwner` | `owner` | null | Any connection (affects only its own sub-owners) |
| `releaseExecution` | `executionId` | bool | Any connection |
| `agentForSession` | `sessionId` | agentId or null | Any connection |
| `markRead` | `sessionId, version?` | null | Any connection. `version`: the state the reader saw; an older confirmation does not clear a newer `done`. Omitted = confirm whatever is current |
| `setSessionTitle` | `sessionId, title` | null | Any connection |
| `sessionLifecycle` | `sessionId` | Array of frames | Any connection |
| `sessionEvents` | `sessionId, afterSequence?, limit?` | Array of frames | Any connection |
| `sessionReplay` | `sessionId` | Array of strings | Any connection |
| `runStates` | — | Array of session run states | Any connection |
| `agents` | — | Array of agents | Any connection |
| `version` | — | `{version, local}` | Any connection |
| `ping` | — | `"pong"` | Any connection |
| `initialize` | `agentId, info?, capabilities?, owner?` | ACP handshake result | Owner |
| `sessionNew` / `sessionLoad` / `sessionResume` / `sessionFork` | `agentId, cwd, …, meta?, owner?` | ACP result | Owner |
| `prompt` | `agentId, sessionId, prompt, meta?, owner?` | `{stopReason, _meta}` | Owner |
| `cancel` | `agentId, sessionId, owner?` | null | Owner |
| `acpRequest` / `acpNotify` / `acpRespond` | `agentId, method \| id, params \| result, owner?` | ACP result / null | Owner |
| `setSlowMode` | `delayMs` | null | Any connection (for development) |
| `shutdown` | — | null, after which the Runtime wraps up and exits | stdio connections only (an unknown method on ws: a browser cannot shut down the shared Runtime) |
| `modules` | — | Array of module states | Any connection |
| `modules/<name>/<method>` | Defined by the module | Defined by the module | Any connection |

Events: `inbound`, `outbound`, `wire`, `stderr`, `exit`, `runStates`, `acpNotification`, `acpAgentRequest`, `lagged` (stdio), `module`.

## 10. Versioning

- The frame protocol name is `alwith-runtime-v1`. Adding fields or methods does not rename it; only a change in semantics would produce v2.
- `version.version` and `alwith-runtime --version` are the same number, and this repo's package versions are released in sync with it.
- The `runtime` field of a module manifest states the minimum Runtime version it needs.

## 11. What is not here

- **Identity and login**: the Runtime does not know users. Who is using it and whether login is needed is the application's business.
- **Approval records and policy**: the Runtime only knows which permission requests are unanswered; who answered and why is recorded by the application itself.
- **Storage**: everything other than the session journal (settings, files, databases) does not pass through the Runtime.
