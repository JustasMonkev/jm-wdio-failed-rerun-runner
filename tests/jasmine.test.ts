import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    runFailedTestsRerun
} from '#src/index'
import { readFailedTests } from '#src/manifest'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-jasmine-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === FAILED_RERUN_SERVICE_PATH)
    return (service as [string, FailedRerunServiceOptions])[1]
}

const jasmineConfig = { framework: 'jasmine' } as WebdriverIO.Config

// `@wdio/jasmine-framework` spreads Jasmine's own spec result into the hook argument,
// so the payload carries `fullName`/`description`, never Mocha's `fullTitle`/`title`.
function jasmineTest(spec: string, fullName: string) {
    return {
        description: fullName.split(' ').at(-1),
        fullName,
        file: spec
    } as never
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('jasmine support', () => {
    it('records a failed Jasmine spec from its fullName', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, jasmineConfig)

        await service.afterTest(
            jasmineTest('specs/login.spec.js', 'login flow signs a user in'),
            {},
            { passed: false, duration: 1, retries: { attempts: 0, limit: 0 } } as never
        )

        expect(await readFailedTests(manifestPath)).toEqual([
            {
                attempt: 'initial',
                framework: 'jasmine',
                spec: 'specs/login.spec.js',
                fullTitle: 'login flow signs a user in',
                title: 'in'
            }
        ])
    })

    it('reruns failed Jasmine specs with jasmineOpts.grep', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'login.spec.js')
        const runs: FailedRerunRunArgs[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.js'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs.push(args)
                const service = new FailedTestRerunService(getServiceOptions(args), {}, jasmineConfig)
                const passed = runs.length > 1

                await service.afterTest(
                    jasmineTest(spec, 'login flow signs a user in'),
                    {},
                    { passed, duration: 1, retries: { attempts: 0, limit: 0 } } as never
                )

                return passed ? 0 : 1
            }
        })

        expect(result.exitCode).toBe(0)
        expect(runs).toHaveLength(2)
        expect(runs[1].spec).toEqual([spec])
        // Jasmine matches this against `spec.getFullName()`, and it must not land in
        // `mochaOpts`, which Jasmine ignores.
        expect(runs[1].jasmineOpts?.grep).toBe('^(?:login flow signs a user in)$')
        expect(runs[1].mochaOpts).toBeUndefined()
        expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual(['login flow signs a user in'])
    })
})
