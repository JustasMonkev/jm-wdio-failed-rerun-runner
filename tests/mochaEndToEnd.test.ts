import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import Mocha from 'mocha'
import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    createFailedTestsRerunner
} from '#src/index'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-e2e-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === FAILED_RERUN_SERVICE_PATH)
    return (service as [string, FailedRerunServiceOptions])[1]
}

// Nested describes on purpose: WebdriverIO hands afterTest a spread of the Mocha test,
// which drops the fullTitle method and flattens parent to the immediate suite title. A
// single-level suite is the one shape where rebuilding from parent + title happens to be
// right, so it hides the bug this exercises.
const SPEC_SOURCE = `
describe('flaky suite', () => {
    describe('when the environment settles', () => {
        it('passes only on rerun', function () {
            if (process.env.WDIO_FAILED_RERUN_RETRY === '0') {
                throw new Error('intentional failure on initial run')
            }
        })

        it('sibling test that always passes', function () {})
    })
})
`

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('a focused rerun driven by the real Mocha runner', () => {
    it('reruns only the failed test in a nested suite and reports it as flaky', async () => {
        const workspace = await makeTempDir()
        const specPath = path.join(workspace, 'flaky.e2e.js')
        const attempts: Array<{ grep?: string, ran: string[] }> = []
        let copy = 0

        // Node caches modules, so a second Mocha instance loading the same path registers
        // no suites at all. Real WebdriverIO runs every attempt in a fresh process; here a
        // fresh physical copy stands in, while the recorded spec path stays constant.
        async function runMocha(options: FailedRerunServiceOptions, grep?: string) {
            const physical = path.join(workspace, `flaky.copy${copy++}.e2e.js`)
            await fs.writeFile(physical, SPEC_SOURCE)

            const mocha = new Mocha({ reporter: 'min' })
            if (grep) {
                mocha.grep(new RegExp(grep))
            }
            mocha.addFile(physical)
            await mocha.loadFilesAsync()

            const service = new FailedTestRerunService(options, {}, {} as WebdriverIO.Config)
            const ran: string[] = []
            const pending: Array<Promise<void>> = []

            const failures = await new Promise<number>((resolve) => {
                const runner = mocha.run(async (failureCount) => {
                    await Promise.all(pending)
                    resolve(failureCount)
                })

                runner.on('test end', (test) => {
                    ran.push(test.fullTitle())
                    // Exactly the payload @wdio/mocha-framework builds for afterTest.
                    pending.push(service.afterTest(
                        { ...test, parent: test.parent?.title, file: specPath } as never,
                        { test },
                        {
                            passed: test.state === 'passed',
                            duration: 1,
                            retries: { attempts: 0, limit: 0 }
                        } as never
                    ))
                })
            })

            attempts.push({ grep, ran })
            return failures
        }

        const result = await createFailedTestsRerunner({ logger: { log: () => {} } }).run(
            path.join(workspace, 'wdio.conf.js'),
            {
                cwd: workspace,
                run: async (_configPath, args) => runMocha(getServiceOptions(args), args.mochaOpts?.grep)
            }
        )

        expect(attempts).toHaveLength(2)

        // The initial run executes the whole file.
        expect(attempts[0].grep).toBeUndefined()
        expect(attempts[0].ran).toEqual([
            'flaky suite when the environment settles passes only on rerun',
            'flaky suite when the environment settles sibling test that always passes'
        ])

        // The rerun narrows to the failed test alone - the outer describe intact, and the
        // passing sibling in the same file left out.
        expect(attempts[1].ran).toEqual([
            'flaky suite when the environment settles passes only on rerun'
        ])

        expect(result.exitCode).toBe(0)
        expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual([
            'flaky suite when the environment settles passes only on rerun'
        ])
        expect(result.summary.broken).toEqual([])
        expect(result.summary.notExecuted).toEqual([])
    }, 60000)
})
