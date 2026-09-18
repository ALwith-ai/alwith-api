import { cpSync, readFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackageValue = string | number | boolean | string[] | { workspace: boolean };
interface CargoManifest {
  package: Record<string, PackageValue>;
}

/** Generate the npm artifact from the authoritative crate, with no parent workspace required. */
export function stageRust(packageRoot: string): void {
  const repository = resolve(import.meta.dirname, "..");
  const source = join(repository, "crates/api");
  const manifest = Bun.TOML.parse(readFileSync(join(source, "Cargo.toml"), "utf8")) as CargoManifest;
  const workspace = Bun.TOML.parse(readFileSync(join(repository, "Cargo.toml"), "utf8")) as {
    workspace: { package: Record<string, PackageValue> };
  };
  for (const [field, value] of Object.entries(manifest.package)) {
    if (typeof value === "object" && !Array.isArray(value) && value.workspace) {
      const inherited = workspace.workspace.package[field];
      if (inherited === undefined) throw new Error(`Missing workspace.package.${field}`);
      manifest.package[field] = inherited;
    }
  }
  manifest.package["license-file"] = "LICENSE";
  const output = join(packageRoot, "rust");
  // This directory is generated exclusively by this script; never retain stale source files.
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  cpSync(join(source, "src"), join(output, "src"), { recursive: true });
  cpSync(join(source, "tests"), join(output, "tests"), { recursive: true });
  cpSync(join(packageRoot, "LICENSE"), join(output, "LICENSE"));
  const serialized = Bun.TOML.stringify(manifest);
  if (serialized === undefined) throw new Error("Failed to serialize the standalone Rust manifest");
  writeFileSync(join(output, "Cargo.toml"), serialized);
}

if (import.meta.main) {
  const destination = process.argv[2];
  if (!destination) throw new Error("Usage: bun scripts/stage-rust.ts <npm-package-directory>");
  stageRust(resolve(destination));
}
