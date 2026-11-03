import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")

test("published archive contains the standalone Rust crate and JS exports, without private TS sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "alwith-api-archive-"))
  const archive = join(directory, "api.tgz")
  execFileSync(process.execPath, ["pm", "pack", "--filename", archive, "--quiet"], {
    cwd: join(root, "packages/api"),
    stdio: "pipe"
  })
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n")
  expect(files).toContain("package/rust/Cargo.toml")
  for (const file of ["LICENSE-MIT", "LICENSE-APACHE"]) {
    expect(files).toContain(`package/${file}`)
    expect(files).toContain(`package/rust/${file}`)
  }
  expect(files).toContain("package/dist/index.js")
  expect(files).toContain("package/dist/index.d.ts")
  expect(files.filter((file) => file.endsWith(".map") || (/\.tsx?$/.test(file) && !file.endsWith(".d.ts")))).toEqual([])
  for (const file of ["src/lib.rs", "src/client.rs", "src/process.rs", "src/protocol.rs", "tests/runtime.rs"]) {
    const packed = execFileSync("tar", ["-xOf", archive, `package/rust/${file}`], { encoding: "utf8" })
    expect(packed).toBe(readFileSync(join(root, "crates/api", file), "utf8"))
  }
  const manifest = Bun.TOML.parse(
    execFileSync("tar", ["-xOf", archive, "package/rust/Cargo.toml"], { encoding: "utf8" })
  ) as { package: Record<string, unknown>; workspace?: object }
  expect(typeof manifest.package.version).toBe("string")
  expect(typeof manifest.package.edition).toBe("string")
  expect(typeof manifest.package.repository).toBe("string")
  expect(manifest).not.toHaveProperty("workspace")

  const consumer = join(directory, "consumer")
  const installed = join(consumer, "node_modules/@alwith/api")
  mkdirSync(installed, { recursive: true })
  execFileSync("tar", ["-xzf", archive, "-C", installed, "--strip-components=1"])
  writeFileSync(
    join(consumer, "Cargo.toml"),
    `[package]
name = "consumer"
version = "0.1.0"
edition = "2024"

[workspace]

[dependencies]
alwith-api = { path = "node_modules/@alwith/api/rust", features = ["client"] }
`
  )
  mkdirSync(join(consumer, "src"))
  writeFileSync(join(consumer, "src/main.rs"), "fn main() { let _ = alwith_api::RunState::Idle; }\n")
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], { cwd: consumer, stdio: "pipe" })
}, 60_000)
