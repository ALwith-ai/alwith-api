# @alwith/api

The application-side TypeScript of ALwith. One package, three things, with entry points split by noun; importing the whole package also works.

| Entry | Contents |
| --- | --- |
| `@alwith/api/runtime` | The `RuntimeClient` interface and frame protocol types, `WebSocketRuntimeClient` (`alwith-runtime --listen ws://`), and errors |
| `@alwith/api/agent` | `Agents` / `Agent` (start, attach, swap engine, exit) and `AgentRequests` (the to-do ledger for permissions and questionnaires) |
| `@alwith/api/session` | Folds `session/update` frames into one renderable session: `applyUpdate`, `SessionStore`, `turns`. See [SESSION.md](SESSION.md) for the criteria |
| `@alwith/api/tauri` | `TauriRuntimeClient`: the host's Rust relays the stdio child process through Tauri events |
| `@alwith/api/node` | `ProcessRuntimeClient`: spawns `alwith-runtime --listen stdio://` itself |

All three transports extend `FrameRuntimeClient`; extend it to build your own transport.

```ts
import { WebSocketRuntimeClient } from "@alwith/api/runtime"

const port = new WebSocketRuntimeClient(url, token)
await port.start("codex", { engine: "codex", cwd })
const { sessionId } = await port.sessionNew("codex", cwd)
const { stopReason } = await port.prompt("codex", sessionId, [{ type: "text", text: "Hello" }])
```

## The agents you hold: `Agents`

Starting processes, attaching, swapping engines and exiting are something every WorkBuddy must handle, and getting them wrong causes incidents: starting a second process with the same name,
re-attaching to an old process that is still exiting during an engine swap, or a prompt's `await` hanging forever after the process crashes. `Agents` encapsulates all of this, and what you get is an `Agent`:

```ts
import { Agents } from "@alwith/api/agent"

const agents = new Agents(port, { info: { name: "my-workbuddy", version: "1.0" } })
// Attach if one is alive (process, context and unanswered requests are all still there), otherwise start one
const attached = await agents.attach(sessionId)
const agent = attached?.agent ?? (await agents.start("chat-1", launch))
attached?.info.pendingAgentRequests   // Requests the agent was still waiting on at attach time; hand them to the AgentRequests ledger
agent.onNotification((method, params) => …)
await agent.request("session/prompt", { sessionId, prompt })   // Fails immediately when the process exits, never hangs
await agents.replace("chat-1", otherLaunch)                     // Swap engine = stop → wait for exit → start
agents.onExit(agent => …)                                       // The process is gone, in sync with the Runtime's exit event
```

A panel that only observes and does not claim should not attach: `attach` means claiming, and once you claim a session you are the one who should answer its permissions. Use the read-only
`agentForSession(sessionId)` to get the agentId, then filter the broadcast `onAcpNotification` / `onAcpAgentRequest` by it.

`Agents` only requires the port to have the `AgentPort` methods (a subset of `RuntimeClient`), so an application's own host port (such as a Tauri relay) works too.

Standard `Agent.request` and `Agent.notify` calls use the official ACP SDK method maps:
parameters and results are inferred from the method literal. Do not provide a response
schema generic for standard methods. Custom `_` methods can supply their own response
and parameter types, as in the SDK. The Runtime still owns transport routing; this does
not create a second SDK connection. The `signal` option cancels the request and ends the
local wait immediately, unlike the SDK's cooperative `cancellationSignal`.


The protocol reference is [PROTOCOL.md](../../PROTOCOL.md) at the repo root; this package is its application side.

## Rust SDK

Since 0.1.4, `rust/` inside the package is a Cargo crate that can be embedded in a consumer's workspace, containing the protocol types, the Runtime client and process helpers. Install this package with Bun first, then configure a `path` relative to Cargo.toml:

```toml
[dependencies]
alwith-api = { path = "../node_modules/@alwith/api/rust", features = ["client"] }
```

The example above applies to `src-tauri/Cargo.toml`. A root-level Cargo.toml uses `node_modules/@alwith/api/rust`. Use `default-features = false` if you only need the types. This crate is compiled on the consumer side and does not depend on an upstream Git checkout.

## License and redistribution

See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
ALwith-owned code is proprietary, not open source. You may build, customize, host,
charge for and distribute your own WorkBuddy applications under the included
license, without per-application registration. This does not grant hosted-service
access or rights to separately distributed Rust libraries or Runtime binaries.
The npm artifact includes compiled/minified JS, declarations, necessary assets,
and the Rust SDK source under `rust/`. It does not include the private TS/TSX
implementation or source maps. Minification is not encryption.
