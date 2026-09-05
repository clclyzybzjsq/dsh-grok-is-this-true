/**
 * Self-contained build for the dsh-grok-is-this-true bundle.
 *
 * Follows the DeepSeek Harness publishing contract "Installing from GitHub:
 * the build-script catch": the `prepare` script must build the published entry
 * points from source with no dev-only context — no monorepo checkout, no
 * project references, no type checking. Output: lib/index.js, the ESM node
 * half the profile Loader resolves through the package `main`.
 *
 * Every `@deepseek-ai/*` import in this package is type-only and erased before
 * resolution, so no dependency needs bundling or external declaration here.
 */
import { defineConfig } from 'tsdown'

export default defineConfig(() => ({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}))
