// The same situation, but exiting through exitWith, which the CLI uses.
import exitHook from 'exit-hook'

import { exitWith } from '../../build/run.js'

exitHook(() => {})
await exitWith(Number(process.argv[2] ?? '1'))
