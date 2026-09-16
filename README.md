# alwith-api

ALwith 的应用侧:做自己的 WorkBuddy 时,应用和模块靠这里接上 Runtime。Runtime 本体按二进制发布,闭源;这里是它对外的那一面。

| 包 | 语言 | 用途 |
| --- | --- | --- |
| `alwith-api` | Rust | 协议类型(总是有)+ 客户端(feature `client`,默认开):spawn 一个 Runtime 走 stdio,或接任意字节流(模块进程就是这样接 Runtime 的)。只要类型时 `default-features = false` |
| `@alwith/api` | TypeScript | 同一协议的 TS 面,一个包三样:`./runtime` 连 Runtime、`./agent` 持有 agent、`./session` 会话状态;传输在 `./tauri` 与 `./node` |

协议本身见 [PROTOCOL.md](PROTOCOL.md):只拿 Runtime 二进制、这份协议和这里的包,就能做自己的 WorkBuddy。Rust 是一个 cargo workspace(`crates/api`),TS 在 `packages/api`。

Runtime 独立构建，不依赖本仓。Rust 协议类型由 Runtime 二进制导出，更新使用
`bun scripts/sync-runtime-protocol.ts /path/to/alwith-runtime`；CI 校验时加 `--check`。
客户端跨进程测试：设置 `ALWITH_RUNTIME_TEST_BINARY` 后运行
`cargo test -p alwith-api --features runtime-contract-tests`，不链接 Runtime 私有 Rust crate。
