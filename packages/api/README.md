# @alwith/api

Public Runtime transport and framework-independent application state. ACP requests,
capabilities, session projection, replay and extension fields belong to the engine adapter.
For Codex, import those capabilities from `@nyssance/codex-acp-v2/client`.

| Entry | Contents |
| --- | --- |
| `@alwith/api` or `/runtime` | Runtime transport types, WebSocketRuntimeClient, run-state observation |
| `/node` | ProcessRuntimeClient, spawning the managed Runtime; `engineFromManifest`, an engine entry read from the manifest staged with the engine |
| `/tauri` | TauriRuntimeClient, connecting to the host relay |
| `/client` | Generic createStore and UpdateScheduler |
| `/module` | Module transport |
| `/tools` | Module tool declarations |

All transports extend FrameRuntimeClient. Runtime owns processes, run states and
read acknowledgement. Raw request envelopes remain opaque transport payloads;
this package does not interpret or construct engine extension fields.

```ts
import { WebSocketRuntimeClient, observeRunStates } from "@alwith/api"
import { CodexClient } from "@nyssance/codex-acp-v2/client"

const port = new WebSocketRuntimeClient(url, token)
const client = new CodexClient(async () => port, {
  agentId: "codex", launch: { engine: "codex" }
})
const observer = observeRunStates(port, (records, source) =>
  client.applyRunStates(records, source === "snapshot" ? "snapshot" : undefined)
)
await observer.ready
// On teardown:
observer.dispose()
```

Observation subscribes before reading the snapshot and discards snapshots superseded
by newer events. Disposal handles late subscription registration and is idempotent.

## Migration

ACP agent/session exports and the protocol SessionClient moved to the adapter's
`/client` entry; there are no compatibility re-exports from this package.
The generic store remains at `/client`. For extension-bearing calls use the
adapter, which encodes the request through the opaque Runtime request transport.
The basic Runtime convenience methods accept only their standard arguments.

## Rust SDK

The Rust SDK is the `alwith-api` crate on crates.io, versioned with this package: the protocol types, the Runtime client and process helpers.

```toml
[dependencies]
alwith-api = { version = "0.6", features = ["client"] }
```

Use `default-features = false` if you only need the types.


## License and redistribution

Licensed under either of MIT (LICENSE-MIT) or Apache-2.0 (LICENSE-APACHE) at your option; third-party notices are in THIRD_PARTY_NOTICES.md. Versions published before 0.6.0 keep the license they were released under.

## Isolated test Runtime

Use `startTestRuntime` from `@alwith/api/node` for test scripts, including temporary
probes. It owns a private temporary Codex home, workspace, journal and attention
state for either `stdio` or `ws`. Process, engine and launch environments are fenced
to that home. It never mutates the caller's environment or original credentials.

```ts
import { startTestRuntime } from "@alwith/api/node"
await using runtime = await startTestRuntime({
  binary: runtimeBinary,
  engines: { mock: mockEngine },
  transport: "stdio"
})
await runtime.client.start("test", { engine: "mock" })
```

The default home is empty. Only an explicitly requested live test supplies
`authFrom: existingCodexHome`, copying **only** auth.json with owner-only permissions.
The fixture removes the copy and all test state after the process exits, including
startup failures. Use `try/finally` with `await runtime.dispose()` when the host does
not support `await using`. Never point a test's CODEX_HOME at the original directory.
