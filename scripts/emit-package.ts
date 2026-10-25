import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

// TS7 emits declarations; Bun owns JavaScript bundling.
export function emitPackage(root: string): void {
  const temporary = mkdtempSync(join(root, ".ts7-build-"))
  try {
    const config = join(temporary, "tsconfig.json")
    writeFileSync(
      config,
      JSON.stringify({
        extends: resolve(root, "tsconfig.json"),
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          declarationMap: false,
          sourceMap: false,
          inlineSourceMap: false,
          inlineSources: false,
          removeComments: true,
          rootDir: resolve(root, "src"),
          outDir: resolve(root, "dist"),
          incremental: false,
          composite: false,
          target: "ESNext",
          module: "ESNext",
          moduleResolution: "Bundler",
          rewriteRelativeImportExtensions: true
        },
        include: [resolve(root, "src")],
        exclude: [
          resolve(root, "src/**/__tests__/**"),
          resolve(root, "src/**/*.test.*"),
          resolve(root, "src/**/*.spec.*")
        ]
      })
    )
    const result = Bun.spawnSync(["bun", "x", "--bun", "--no-install", "tsc", "-p", config], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit"
    })
    if (result.exitCode !== 0) throw new Error(`TS7 compilation failed (${result.exitCode}): ${root}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
