// Reproduces the hazard with the package WebdriverIO's launcher actually registers: with
// an async-exit-hook handler installed, a process that only sets process.exitCode exits 0.
import { createRequire } from 'node:module'

// Resolved from @wdio/cli's own tree, so this tracks the copy WebdriverIO loads rather
// than a second one that happens to sit in the dev tree at a different version.
const require = createRequire(import.meta.url)
const exitHook = require(require.resolve('async-exit-hook', {
    paths: [require.resolve('@wdio/cli')]
}))

exitHook(() => {})
process.exitCode = 1
