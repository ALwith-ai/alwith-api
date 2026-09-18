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

## npm 分发 Rust SDK

从 `@alwith/api` 0.1.3 起，npm 包同时携带 JS 产物和 `rust/` crate。Rust 源码唯一维护在 `crates/api`；打包时自动复制源码与契约测试、展开 workspace 元数据，并附上包内许可证。生成目录不提交。

先安装 npm 依赖，再让 Cargo 使用相对于消费端 Cargo.toml 的路径：

```toml
[dependencies]
alwith-api = { path = "node_modules/@alwith/api/rust", features = ["client"] }
```

若 Cargo.toml 在 `src-tauri/`，路径改为 `../node_modules/@alwith/api/rust`。无需克隆本仓或通过 Git 获取 crate；第三方 Rust 依赖仍由 Cargo 解析。npm 版本由消费者的 Bun 锁文件固定，Rust crate 保持自身版本。

验证打包内容：`bun test scripts/__tests__`。Rust 编译与 Runtime 契约测试另行执行。

## 发布 `@alwith/api`

推一个 `v<版本>` 的 tag,[publish.yml](.github/workflows/publish.yml) 跑测试、构建 dist、发到 npm。本地不用 `npm login`:走 npm 的 trusted publishing(OIDC),没有 token。不带 provenance:那只支持公开源码仓,仓库公开那天再加。

一次性配置(npmjs.com,包 `@alwith/api` → Settings → Trusted Publisher → GitHub Actions):Organization `ALwith-ai`、Repository `alwith-api`、Workflow filename `publish.yml`、Environment 留空。配完把 Publishing access 设成「Require two-factor authentication and disallow tokens」,trusted publisher 不受这条限制,反而把失效 token 那条路彻底关掉。

发版:改 `packages/api/package.json` 的 `version`,提交,然后

```sh
git tag v0.1.1 && git push origin v0.1.1
```

tag 和 `version` 不一致 workflow 直接失败。
