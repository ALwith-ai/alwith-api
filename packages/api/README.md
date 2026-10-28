# @alwith/api

Public Runtime transport and framework-independent application state. ACP requests,
capabilities, session projection, replay and extension fields belong to the engine adapter.
For Codex, import those capabilities from `@nyssance/codex-acp-v2/client`.

| Entry | Contents |
| --- | --- |
| `@alwith/api` or `/runtime` | Runtime transport types, WebSocketRuntimeClient, run-state observation |
| `/node` | ProcessRuntimeClient, spawning the managed Runtime |
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

Since 0.1.4, `rust/` inside the package is a Cargo crate that can be embedded in a consumer's workspace, containing the protocol types, the Runtime client and process helpers. Install this package with Bun first, then configure a `path` relative to Cargo.toml:

```toml
[dependencies]
alwith-api = { path = "../node_modules/@alwith/api/rust", features = ["client"] }
```

The example above applies to `src-tauri/Cargo.toml`. A root-level Cargo.toml uses `node_modules/@alwith/api/rust`. Use `default-features = false` if you only need the types. This crate is compiled on the consumer side and does not depend on an upstream Git checkout.


## License and redistribution

See LICENSE and THIRD_PARTY_NOTICES.md. Migration does not change the license of any existing source.
