# Repository Guidelines

## Never bump a minor or major version on your own

- For any package or app (`@alwith/api`, `@alwith/module-*`, `codex-acp-v2`, `alwith-cli`, Desktop / U / TV) an agent may only bump the **patch** version (x.y.Z).
- Minor and major bumps are the user's decision alone; "types changed", "breaking change" or "semver convention" never justify doing it yourself. Ask first, change only after the user agrees.
- Origin: user instruction (2026-10-19; `@alwith/api` was published as 0.4.0 instead of 0.3.1 without permission, and a published version number cannot be taken back).

## Verify Rust locally before pushing

`crates/` has its own `target/`; a check takes seconds. Before any push that touches Rust, run
`cargo clippy --workspace --all-targets -- -D warnings` and `cargo test --workspace` here and make them
green. CI is a second look, never the first: pushing to find out whether it compiles wastes five
minutes per round. Grep the whole workspace (tests included) for every call site before changing a
signature, so one push carries the whole change.

Origin: user instruction (2026-10-19), after a Runtime change went through nine pushes, five of them
compile errors CI could have been spared.

## Commit messages: English only, one commit per change

- Write commit messages in English only. No Chinese in subjects or bodies, in any repo.
- Squash churn before pushing: one commit per logical change. Never leave an add-then-remove sequence (a feature commit followed by its revert, or a dependency pinned and re-pinned) in history; rewrite it into the net result.
- Origin: user instruction (2026-10-20).

## Publish existing npm packages through trusted CI

- `@alwith/api` already has a working npm Trusted Publisher bound to
  `ALwith-ai/alwith-api`, workflow `publish.yml`, without an environment.
- Release by committing the patch version and pushing the matching `v<version>` tag.
  Monitor the workflow and verify the registry version before updating consumers.
- Do not run local `npm publish` or ask for per-release npm login / 2FA.
  Change the one-time trust binding only if CI reports an actual trust mismatch.
- Origin: user instruction (2026-10-22).

## Test Runtime isolation

Scripts that start Runtime/engine sessions, including temporary probes, must use
`startTestRuntime` from `@alwith/api/node`. Never use the real Codex home as test
state. Default tests use mocks; only an explicitly authorized live test supplies
`authFrom` to copy auth.json into the helper's temporary home. Use `await using`
or await `dispose()` in `finally`. Existing server protocol fixtures that already
create isolated homes remain valid; they must never fall back to the real home.

## Rust formatting: stable only, never nightly

- Format Rust with stable `cargo fmt` only. `rustfmt.toml` keeps options that only nightly applies; on stable they are ignored with a warning, which is known and accepted.
- Never run `cargo +nightly`, `rustfmt +nightly` or `rustup toolchain install nightly`, and never install a nightly toolchain to make those warnings go away.
- Origin: user instruction (2026-07-25 in alwith-desktop; repeated here 2026-11-25 after a session auto-installed nightly through `cargo +nightly fmt`).
