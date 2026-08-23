#!/usr/bin/env node
import run, { exitWith } from '#src/run'

await exitWith(await run())
