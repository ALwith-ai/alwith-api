import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

test("published archive contains the standalone Rust crate and JS exports, without private TS sources", () => {
  const directory = mkdtempSync(join(tmpdir(), "alwith-api-archive-"));
  const archive = join(directory, "api.tgz");
  execFileSync(process.execPath, ["pm", "pack", "--filename", archive, "--quiet"], {
    cwd: join(root, "packages/api"), stdio: "pipe",
  });
  const files = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  expect(files).toContain("package/rust/Cargo.toml");
  expect(files).toContain("package/rust/LICENSE");
  expect(files).toContain("package/dist/index.js");
  expect(files).toContain("package/dist/index.d.ts");
  expect(files.filter(file => file.endsWith(".map") || (/\.tsx?$/.test(file) && !file.endsWith(".d.ts")))).toEqual([]);
  for (const file of ["src/lib.rs", "src/client.rs", "src/process.rs", "src/protocol.rs", "tests/runtime.rs"]) {
    const packed = execFileSync("tar", ["-xOf", archive, `package/rust/${file}`], { encoding: "utf8" });
    expect(packed).toBe(readFileSync(join(root, "crates/api", file), "utf8"));
  }
  const manifest = Bun.TOML.parse(execFileSync("tar", ["-xOf", archive, "package/rust/Cargo.toml"], { encoding: "utf8" })) as { package: Record<string, unknown>; workspace: object };
  expect(typeof manifest.package.version).toBe("string");
  expect(typeof manifest.package.edition).toBe("string");
  expect(typeof manifest.package.repository).toBe("string");
  expect(manifest.workspace).toEqual({});
}, 60_000);
