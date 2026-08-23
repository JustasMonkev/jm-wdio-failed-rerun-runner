// Appends failure records from a separate process, so the manifest is exercised the way
// parallel WebdriverIO workers exercise it. Payloads are deliberately larger than PIPE_BUF
// so a non-atomic write would interleave and corrupt lines.
import { appendFailedTest } from '../../build/manifest.js'

const [manifestPath, id, count] = process.argv.slice(2)
const payload = 'x'.repeat(9000)

for (let index = 0; index < Number(count); index++) {
    await appendFailedTest(manifestPath, {
        attempt: 'initial',
        framework: 'mocha',
        spec: `specs/worker-${id}.e2e.ts`,
        fullTitle: `worker ${id} test ${index}`,
        error: { message: payload }
    })
}
