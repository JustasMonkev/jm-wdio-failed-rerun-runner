// The same situation, but exiting through exitWith, which the CLI uses.
import { createRequire } from 'node:module'

import { exitWith } from '../../build/run.js'

const require = createRequire(import.meta.url)
const exitHook = require(require.resolve('async-exit-hook', {
    paths: [require.resolve('@wdio/cli')]
}))

exitHook(() => {})
await exitWith(Number(process.argv[2] ?? '1'))
