# npm 产物边界

- `@alwith/api` 的首次 npm 版本是 `0.1.0`；后续修复递增 patch，不自动升级 minor/major。Rust/Runtime 版本独立，本次不重编号。
- 在仓库根目录 `bun install --frozen-lockfile`，然后进入 `packages/api` 执行 `bun run build` 或 `bun pm pack`。prepack 自动重建。
- 包只导出 `dist` 中的压缩 ESM、`.d.ts` 及明确允许的文档。不要发布 `src`、测试、source map 或构建脚本。
- 使用独立固定的 `typescript-compiler` 生成 JS/声明，Bun 压缩各模块；不把 peer dependencies 打进产物。
- 本地 file 依赖消费的也是 dist；修改源码后先重新 build，新建 dist 后需刷新消费者的 Bun 安装链接。
- 当前保留 `private: true` 作为发布锁。专有开发与再分发许可、第三方声明、组织权限、实际 tarball 审核完成后才解除并发布；不能把无许可证视为已经授予商用/再分发权利。
- JS 压缩不是加密。`.d.ts` 是公开接口，必须保留；原始 TS 实现仍在私有仓。
- 逐步开源按包、按版本决定；新许可不抹除旧版本已授出的权利。公开 npm 不等于公开仓库。
