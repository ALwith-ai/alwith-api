# npm artifact boundary

- The first npm version of `@alwith/api` is `0.1.0`; later fixes bump the patch version and never auto-upgrade minor/major. Rust/Runtime versions are independent and are not renumbered this time.
- Run `bun install --frozen-lockfile` at the repo root, then run `bun run build` or `bun pm pack` in `packages/api`. prepack rebuilds automatically.
- The package exports only the minified ESM and `.d.ts` files in `dist` plus explicitly allowed docs. Do not publish `src`, tests, source maps or build scripts.
- JS and declarations are generated with a separately pinned `typescript-compiler`, and Bun minifies each module; peer dependencies are not bundled into the output.
- Local file dependencies also consume dist; rebuild after changing the source, and refresh the consumer's Bun install links after dist is recreated.
- `private: true` is kept as a publish lock for now. Remove it and publish only after the proprietary development and redistribution license, third-party notices, organization permissions and a review of the actual tarball are complete; the absence of a license must not be treated as having granted commercial or redistribution rights.
- Minifying JS is not encryption. `.d.ts` files are the public interface and must be kept; the original TS implementation stays in the private repo.
- Open-sourcing proceeds gradually, decided per package and per version; a new license does not erase rights already granted for older versions. Publishing on public npm does not mean opening the repository.
