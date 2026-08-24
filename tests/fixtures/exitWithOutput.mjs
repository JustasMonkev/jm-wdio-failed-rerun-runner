// Writes far more than a pipe buffer holds, then exits non-zero. `process.exit` truncates
// pending asynchronous writes to a pipe, so without a flush the reader sees a short file.
import { exitWith } from '../../build/run.js'

const lines = Number(process.argv[2] ?? '20000')
for (let index = 0; index < lines; index++) {
    console.log(`line ${index}`)
}

await exitWith(1)
