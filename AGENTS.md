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
