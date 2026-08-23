import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    createFailedTestsRerunner
} from '#src/index'
import type { FailedRerunLogger } from '#src/reporter'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-reporter-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === FAILED_RERUN_SERVICE_PATH)
    return (service as [string, FailedRerunServiceOptions])[1]
}

function createRecordingLogger() {
    const lines: string[] = []
    const logger: FailedRerunLogger = { log: (message) => lines.push(message) }
    return { lines, logger }
}

async function record(args: FailedRerunRunArgs, spec: string, fullTitle: string, passed: boolean) {
    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
    await service.afterTest({ title: fullTitle, fullTitle, file: spec } as never, {}, {
        passed,
        duration: 1,
        retries: { attempts: 0, limit: 0 }
    } as never)
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('rerun reporting', () => {
    it('separates tests that recovered from tests that stayed broken', async () => {
        const workspace = await makeTempDir()
        const flakySpec = path.join(workspace, 'specs', 'login.e2e.ts')
        const brokenSpec = path.join(workspace, 'specs', 'checkout.e2e.ts')
        const { lines, logger } = createRecordingLogger()
        let runs = 0

        const result = await createFailedTestsRerunner({ logger }).run(
            path.join(workspace, 'wdio.conf.ts'),
            {
                cwd: workspace,
                run: async (_configPath, args) => {
                    runs++

                    if (runs === 1) {
                        await record(args, flakySpec, 'login flow signs in', false)
                        await record(args, brokenSpec, 'checkout applies discount', false)
                        return 1
                    }

                    if (runs === 2) {
                        await record(args, flakySpec, 'login flow signs in', true)
                        return 0
                    }

                    await record(args, brokenSpec, 'checkout applies discount', false)
                    return 1
                }
            }
        )

        expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual(['login flow signs in'])
        expect(result.summary.broken.map((test) => test.fullTitle)).toEqual(['checkout applies discount'])
        expect(result.summary.notExecuted).toEqual([])
        expect(result.exitCode).toBe(1)

        expect(lines).toEqual([
            '[wdio-failed-rerun] initial run failed: 2 tests across 2 specs',
            '[wdio-failed-rerun] rerun 1/1: login.e2e.ts (1 test), checkout.e2e.ts (1 test)',
            '[wdio-failed-rerun] summary: 1 flaky test (passed on rerun), 1 still failing',
            '[wdio-failed-rerun]   flaky:  login flow signs in',
            '[wdio-failed-rerun]   broken: checkout applies discount'
        ])
    })

    it('says a targeted test never ran instead of implying it passed', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'login.e2e.ts')
        const { lines, logger } = createRecordingLogger()
        let runs = 0

        const result = await createFailedTestsRerunner({ logger }).run(
            path.join(workspace, 'wdio.conf.ts'),
            {
                cwd: workspace,
                run: async (_configPath, args) => {
                    runs++

                    if (runs === 1) {
                        await record(args, spec, 'login flow signs in', false)
                        return 1
                    }

                    return 0
                }
            }
        )

        expect(result.summary.flaky).toEqual([])
        expect(result.summary.notExecuted.map((test) => test.fullTitle)).toEqual(['login flow signs in'])
        expect(lines).toContain(
            '[wdio-failed-rerun]   no result: login flow signs in (the rerun recorded no outcome for it)'
        )
    })

    it('stays silent when quiet is requested', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'login.e2e.ts')
        const { lines, logger } = createRecordingLogger()
        let runs = 0

        await createFailedTestsRerunner({ logger }).run(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs++

                if (runs === 1) {
                    await record(args, spec, 'login flow signs in', false)
                    return 1
                }

                await record(args, spec, 'login flow signs in', true)
                return 0
            }
        })

        expect(lines).toEqual([])
    })

    it('does not call a test flaky when no rerun ever targeted it', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'login.e2e.ts')
        const { logger } = createRecordingLogger()

        // maxReruns: 0 disables reruns entirely, so the failure recovered from nothing.
        const result = await createFailedTestsRerunner({ logger }).run(
            path.join(workspace, 'wdio.conf.ts'),
            {
                cwd: workspace,
                maxReruns: 0,
                run: async (_configPath, args) => {
                    await record(args, spec, 'login flow signs in', false)
                    return 1
                }
            }
        )

        expect(result.exitCode).toBe(1)
        expect(result.summary.flaky).toEqual([])
        expect(result.summary.broken).toEqual([])
        expect(result.failures.map((test) => test.fullTitle)).toEqual(['login flow signs in'])
    })
})
