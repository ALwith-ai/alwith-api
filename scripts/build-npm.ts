import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, relative, resolve, sep } from "node:path"

import { emitPackage } from "./emit-package"
import { stageRust } from "./stage-rust"

// JS implementation stays private; the Rust SDK source is included for Cargo consumers.
const root = process.cwd()
const src = resolve(root, "src")
const dist = resolve(root, "dist")
for (const required of ["LICENSE-MIT", "LICENSE-APACHE", "THIRD_PARTY_NOTICES.md"]) {
  if (!existsSync(resolve(root, required))) throw new Error(`Missing distribution notice: ${required}`)
}
if (!existsSync(resolve(root, "tsconfig.json")) || !existsSync(src)) throw new Error("Run in an ALwith TS package")
rmSync(dist, { recursive: true, force: true })
emitPackage(root)
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(resolve(dir, e.name)) : [resolve(dir, e.name)]
  )
}
for (const file of walk(src)) {
  if (file.includes(`${sep}__tests__${sep}`)) continue
  if (file.endsWith(".css")) {
    const target = resolve(dist, relative(src, file))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(file))
  }
}
const entrypoints = walk(src).filter(
  (file) =>
    /\.tsx?$/.test(file) &&
    !file.endsWith(".d.ts") &&
    !file.includes(`${sep}__tests__${sep}`) &&
    !/\.(test|spec)\./.test(file)
)
const built = await Bun.build({
  entrypoints: entrypoints,
  root: src,
  outdir: dist,
  naming: "[dir]/[name].[ext]",
  target: "browser",
  format: "esm",
  packages: "external",
  splitting: true,
  minify: true,
  sourcemap: "none"
})
if (!built.success) throw new AggregateError(built.logs, "Distribution build failed")
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  name: string
  exports: Record<string, string | Record<string, string>>
}
for (const entry of Object.values(pkg.exports)) {
  for (const target of typeof entry === "string" ? [entry] : Object.values(entry)) {
    if (!target.startsWith("./dist/") || !existsSync(resolve(root, target)))
      throw new Error(`Invalid export: ${target}`)
  }
}
for (const file of walk(dist)) {
  if (file.endsWith(".map") || (/\.tsx?$/.test(file) && !file.endsWith(".d.ts")) || file.includes("__tests__"))
    throw new Error(`Private source in dist: ${file}`)
}
stageRust(root)
console.log(`${pkg.name}: built ${walk(dist).length} distribution files; no source maps or implementation TS/TSX`)
