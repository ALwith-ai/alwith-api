import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, relative, resolve, sep } from "node:path"

import { stageRust } from "./stage-rust"

// JS implementation stays private; the Rust SDK source is included for Cargo consumers.
const root = process.cwd()
const require = createRequire(resolve(root, "package.json"))
const ts = require("typescript-compiler") as typeof import("typescript-compiler")
const src = resolve(root, "src")
const dist = resolve(root, "dist")
for (const required of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  if (!existsSync(resolve(root, required))) throw new Error(`Missing distribution notice: ${required}`)
}
if (!existsSync(resolve(root, "tsconfig.json")) || !existsSync(src)) throw new Error("Run in an ALwith TS package")
const config = ts.readConfigFile(resolve(root, "tsconfig.json"), (path) => ts.sys.readFile(path))
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"))
const parsed = ts.parseJsonConfigFileContent(
  { ...config.config, exclude: ["src/**/__tests__/**", "src/**/*.test.*", "src/**/*.spec.*"] },
  ts.sys,
  root
)
const options = {
  ...parsed.options,
  noEmit: false,
  declaration: true,
  emitDeclarationOnly: false,
  declarationMap: false,
  sourceMap: false,
  inlineSourceMap: false,
  inlineSources: false,
  removeComments: true,
  rootDir: src,
  outDir: dist,
  incremental: false,
  composite: false
}
const program = ts.createProgram(parsed.fileNames, options)
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]
if (diagnostics.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => root,
      getCanonicalFileName: (f: string) => f,
      getNewLine: () => "\n"
    })
  )

// Preserve per-file modules (React context identity), and make ESM/Worker paths real.
const rewrite = (context: import("typescript-compiler").TransformationContext) => {
  let sourceFile: string
  const visit = (
    node: import("typescript-compiler").Node
  ): import("typescript-compiler").VisitResult<import("typescript-compiler").Node> => {
    if (ts.isStringLiteral(node) && node.text.startsWith(".")) {
      const path = resolve(dirname(sourceFile), node.text)
      let value = node.text
      if (/\.tsx?$/.test(value)) value = value.replace(/\.tsx?$/, ".js")
      else if (existsSync(`${path}.ts`) || existsSync(`${path}.tsx`)) value += ".js"
      else if (existsSync(resolve(path, "index.ts")) || existsSync(resolve(path, "index.tsx"))) value += "/index.js"
      if (value !== node.text) return context.factory.createStringLiteral(value)
    }
    return ts.visitEachChild(node, visit, context)
  }
  return (file: import("typescript-compiler").SourceFile | import("typescript-compiler").Bundle) => {
    if (ts.isBundle(file)) throw new Error("Bundle emit is not used; files are emitted one by one")
    sourceFile = file.fileName
    return ts.visitNode<import("typescript-compiler").SourceFile>(file, visit)
  }
}
rmSync(dist, { recursive: true, force: true })
const result = program.emit(undefined, undefined, undefined, false, {
  after: [rewrite],
  afterDeclarations: [rewrite]
})
if (result.emitSkipped || result.diagnostics.length) throw new Error("Declaration/JS emit failed")
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
for (const file of walk(dist).filter((f) => f.endsWith(".js"))) {
  const built = await Bun.build({
    entrypoints: [file],
    target: "browser",
    format: "esm",
    external: ["*"],
    minify: true,
    sourcemap: "none",
    write: false
  })
  if (!built.success || built.outputs.length !== 1)
    throw new Error(`Minification failed: ${file}\n${built.logs.map((log) => log.message).join("\n")}`)
  writeFileSync(file, await built.outputs[0].text())
}
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
