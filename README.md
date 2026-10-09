# alwith-api

The application side of ALwith: when you build your own WorkBuddy, your app and modules connect to the Runtime through this. The Runtime itself ships as a closed-source binary; this is its public face.

| Package | Language | Purpose |
| --- | --- | --- |
| `alwith-api` | Rust | Protocol types (always present) + a client (feature `client`, on by default): spawn a Runtime over stdio, or attach to any byte stream (this is how module processes connect to the Runtime). Use `default-features = false` if you only need the types |
| `@alwith/api` | TypeScript | The TS surface of the same protocol, three things in one package: `./runtime` connects to the Runtime, `./agent` owns agents, `./session` holds session state; transports live in `./tauri` and `./node` |

The protocol itself is in [PROTOCOL.md](PROTOCOL.md): the Runtime binary, this protocol and the packages here are all you need to build your own WorkBuddy. Rust is a cargo workspace (`crates/api`); TS is in `packages/api`.

The Runtime is built independently and does not depend on this repo. The Rust protocol types are exported by the Runtime binary; update them with
`bun scripts/sync-runtime-protocol.ts /path/to/alwith-runtime` (add `--check` for CI verification).
Cross-process client tests: set `ALWITH_RUNTIME_TEST_BINARY`, then run
`cargo test -p alwith-api --features runtime-contract-tests`. This does not link any private Runtime Rust crate.

## Distributing the Rust SDK via npm

Since `@alwith/api` 0.1.4, the npm package carries both the JS output and a `rust/` crate. The Rust source is maintained only in `crates/api`; packaging copies the source and contract tests, expands workspace metadata, and adds the in-package license. The generated directory is not committed.

Install the npm dependency first, then point Cargo at a path relative to the consumer's Cargo.toml:

```toml
[dependencies]
alwith-api = { path = "node_modules/@alwith/api/rust", features = ["client"] }
```

If Cargo.toml is in `src-tauri/`, change the path to `../node_modules/@alwith/api/rust`. There is no need to clone this repo or fetch the crate through Git; third-party Rust dependencies are still resolved by Cargo. The npm version is pinned by the consumer's Bun lockfile, and the Rust crate keeps its own version.

Verify the package contents with `bun test scripts/__tests__`. Rust compilation and the Runtime contract tests run separately.

## Publishing `@alwith/api`

Push a `v<version>` tag and [publish.yml](.github/workflows/publish.yml) runs the tests, builds dist and publishes to npm. No local `npm login` is needed: it uses npm trusted publishing (OIDC), with no token. It does not attach provenance, which only supports public source repos; add it the day the repo goes public.

One-time setup (npmjs.com, package `@alwith/api` → Settings → Trusted Publisher → GitHub Actions): Organization `ALwith-ai`, Repository `alwith-api`, Workflow filename `publish.yml`, Environment left empty. Afterwards set Publishing access to "Require two-factor authentication and disallow tokens"; the trusted publisher is not affected by this setting, and it fully closes off the stale-token route.

To release: change `version` in `packages/api/package.json`, commit, then

```sh
git tag v0.1.1 && git push origin v0.1.1
```

The workflow fails outright if the tag and `version` disagree.

## Formatting

Run `bun install --frozen-lockfile` to install the repository's formatting tools.
`bun run format` formats JavaScript, TypeScript, CSS and supported configuration files;
`bun run format:rust` formats the Rust workspace; `bun run format:all` runs both.
Prettier and its Tailwind plugin match ALwith Desktop's versions; Prettier and Rustfmt settings match Desktop's rules.
Generated artifacts, dependency directories, licenses and Markdown are excluded from Prettier.
