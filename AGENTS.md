# Repository Guidelines

## Never bump a minor or major version on your own

- For any package or app (`@alwith/api`, `@alwith/module-*`, `codex-acp-v2`, `alwith-cli`, Desktop / U / TV) an agent may only bump the **patch** version (x.y.Z).
- Minor and major bumps are the user's decision alone; "types changed", "breaking change" or "semver convention" never justify doing it yourself. Ask first, change only after the user agrees.
- Origin: user instruction (2026-10-19; `@alwith/api` was published as 0.4.0 instead of 0.3.1 without permission, and a published version number cannot be taken back).
