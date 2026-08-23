#!/usr/bin/env node
import run from '#src/run'

// Set `exitCode` rather than calling `process.exit`, which would truncate pending
// stdout writes and cut off the summary the reporter just printed.
process.exitCode = await run()
