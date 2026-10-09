import { expect, test } from "bun:test"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")

test("npm Rust crate preserves sources and resolves workspace metadata without the source repository", () => {
  const directory = mkdtempSync(join(tmpdir(), "alwith-rust-package-"))
  const output = join(directory, "package")
  cpSync(join(root, "packages/api/LICENSE"), join(output, "LICENSE"))
  mkdirSync(join(output, "rust/src"), { recursive: true })
  writeFileSync(join(output, "rust/src/removed.rs"), "stale source")
  const result = Bun.spawnSync([process.execPath, join(root, "scripts/stage-rust.ts"), output], {
    stdout: "pipe",
    stderr: "pipe"
  })
  expect(result.exitCode).toBe(0)
  expect(existsSync(join(output, "rust/src/removed.rs"))).toBe(false)
  const manifest = Bun.TOML.parse(readFileSync(join(output, "rust/Cargo.toml"), "utf8")) as {
    package: Record<string, unknown>
    workspace?: object
  }
  const workspace = Bun.TOML.parse(readFileSync(join(root, "Cargo.toml"), "utf8")) as {
    workspace: { package: Record<string, unknown> }
  }
  expect(manifest.package.version).toBe(workspace.workspace.package.version)
  expect(manifest.package.edition).toBe(workspace.workspace.package.edition)
  expect(manifest.package.repository).toBe(workspace.workspace.package.repository)
  expect(manifest.package["license-file"]).toBe("LICENSE")
  expect(readFileSync(join(output, "rust/LICENSE"), "utf8")).toBe(readFileSync(join(output, "LICENSE"), "utf8"))
  expect(manifest).not.toHaveProperty("workspace")
  for (const file of ["src/lib.rs", "src/client.rs", "src/process.rs", "src/protocol.rs", "tests/runtime.rs"]) {
    expect(readFileSync(join(output, "rust", file), "utf8")).toBe(readFileSync(join(root, "crates/api", file), "utf8"))
  }
})
