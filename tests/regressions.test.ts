import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    runFailedTestsRerun
} from '#src/index'
import { serializeError } from '#src/errors'
import { appendFailedTest, readFailedTests } from '#src/manifest'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-regression-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === FAILED_RERUN_SERVICE_PATH)
    return (service as [string, FailedRerunServiceOptions])[1]
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('error serialization', () => {
    it('serializes a shared non-cyclic object every time it appears', () => {
        const shared = { id: 1 }
        const error = Object.assign(new Error('boom'), { first: shared, second: shared })

        const serialized = serializeError(error)

        // `second` is a sibling of `first`, not an ancestor of it: reporting it as
        // circular silently discards real diagnostic data.
        expect(serialized?.details?.first).toEqual({ id: 1 })
        expect(serialized?.details?.second).toEqual({ id: 1 })
    })

    it('still reports a genuine cycle as circular', () => {
        const cyclic: Record<string, unknown> = { id: 1 }
        cyclic.self = cyclic
        const error = Object.assign(new Error('boom'), { cyclic })

        const details = serializeError(error)?.details as Record<string, Record<string, unknown>>

        expect(details.cyclic.self).toBe('[Circular]')
    })
})

describe('manifest resilience', () => {
    it('skips unreadable lines instead of failing the whole rerun', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')

        await appendFailedTest(manifestPath, {
            attempt: 'initial',
            framework: 'mocha',
            spec: 'specs/a.e2e.ts',
            fullTitle: 'first failure'
        })
        // A worker killed mid-write, or a full disk, leaves a partial line behind.
        await fs.appendFile(manifestPath, '{"attempt":"initial","spec":\n')
        await fs.appendFile(manifestPath, 'not json at all\n')
        await appendFailedTest(manifestPath, {
            attempt: 'initial',
            framework: 'mocha',
            spec: 'specs/b.e2e.ts',
            fullTitle: 'second failure'
        })

        const records = await readFailedTests(manifestPath)

        expect(records.map((record) => record.fullTitle)).toEqual(['first failure', 'second failure'])
    })
})

describe('mocha full title reconstruction', () => {
    it('uses the live context so nested describes are not truncated', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // `@wdio/mocha-framework` hands `afterTest` a spread of the Mocha test, which drops
        // `fullTitle` (a prototype method) and reduces `parent` to the immediate suite title.
        // Rebuilding from parent + title would lose the outer describe, and the resulting
        // grep could never match the title Mocha actually filters on.
        await service.afterTest({
            title: 'logs in',
            parent: 'with valid credentials',
            file: 'specs/login.e2e.ts'
        } as never, {
            test: {
                fullTitle: () => 'login flow with valid credentials logs in'
            }
        }, {
            passed: false,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as never)

        const [record] = await readFailedTests(manifestPath)

        expect(record.fullTitle).toBe('login flow with valid credentials logs in')
    })
})

describe('focused rerun execution verification', () => {
    it('does not report success when the rerun filter matched no tests', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'login.e2e.ts')
        const runs: FailedRerunRunArgs[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            run: async (_configPath, args) => {
                runs.push(args)

                if (runs.length === 1) {
                    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                    await service.afterTest({
                        title: 'logs in',
                        fullTitle: 'login flow logs in',
                        file: spec
                    } as never, {}, {
                        passed: false,
                        duration: 1,
                        retries: { attempts: 0, limit: 0 }
                    } as never)
                    return 1
                }

                // The rerun's filter matched nothing, so the framework exits 0 having run
                // no tests and writes an empty manifest. That is indistinguishable from
                // "everything passed" unless execution is verified.
                return 0
            }
        })

        expect(result.exitCode).toBe(1)
        expect(runs).toHaveLength(2)

        const rerun = result.attempts[1]
        expect(rerun.type).toBe('rerun')
        expect(rerun.type === 'rerun' && rerun.notExecuted.map((test) => test.fullTitle))
            .toEqual(['login flow logs in'])
    })

    it('reports success when the rerun proves the targeted test executed', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'login.e2e.ts')
        const runs: FailedRerunRunArgs[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            run: async (_configPath, args) => {
                runs.push(args)
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                const passed = runs.length > 1

                await service.afterTest({
                    title: 'logs in',
                    fullTitle: 'login flow logs in',
                    file: spec
                } as never, {}, {
                    passed,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)

                return passed ? 0 : 1
            }
        })

        expect(result.exitCode).toBe(0)
        const rerun = result.attempts[1]
        expect(rerun.type === 'rerun' && rerun.notExecuted).toEqual([])
    })
})

describe('tests that must not be queued for rerun', () => {
    it('does not record a skipped test as a failure', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // WebdriverIO reports a skipped test as `passed: false, skipped: true`. Recording
        // it would queue a test that can never pass, so the run could never go green.
        await service.afterTest({
            title: 'is skipped',
            fullTitle: 'suite is skipped',
            file: 'specs/a.e2e.ts'
        } as never, {}, {
            passed: false,
            skipped: true,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as never)

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('waits for the final Mocha retry before recording a failure', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
        const failing = {
            passed: false,
            duration: 1,
            // @wdio/utils exhausts its own budget before returning, so these are equal by
            // the time the hook runs and cannot indicate a pending retry.
            retries: { attempts: 2, limit: 2 }
        } as never

        // Mocha will retry: attempt 0 of 2.
        await service.afterTest({
            title: 'flakes',
            fullTitle: 'suite flakes',
            file: 'specs/a.e2e.ts',
            _currentRetry: 0,
            _retries: 2
        } as never, {}, failing)

        expect(await readFailedTests(manifestPath)).toEqual([])

        // Final attempt: Mocha has no retries left.
        await service.afterTest({
            title: 'flakes',
            fullTitle: 'suite flakes',
            file: 'specs/a.e2e.ts',
            _currentRetry: 2,
            _retries: 2
        } as never, {}, failing)

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['suite flakes'])
    })

    it('does not record a Cucumber scenario that will be retried', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // cucumber-js sets `willBeRetried` on the hook parameter itself, not under `result`.
        await service.afterScenario({
            pickle: { name: 'signs in', uri: 'features/login.feature' },
            willBeRetried: true
        } as never, { passed: false, duration: 1 } as never, {})

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('lets a later passed record supersede an earlier failure for the same test', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')

        await appendFailedTest(manifestPath, {
            attempt: 'rerun',
            framework: 'mocha',
            spec: 'specs/a.e2e.ts',
            fullTitle: 'suite flakes'
        })
        await appendFailedTest(manifestPath, {
            attempt: 'rerun',
            framework: 'mocha',
            spec: 'specs/a.e2e.ts',
            fullTitle: 'suite flakes',
            outcome: 'passed'
        })

        expect(await readFailedTests(manifestPath)).toEqual([])
    })
})

describe('rerun manifest artifact', () => {
    it('keeps every spec group, not just the last one', async () => {
        const workspace = await makeTempDir()
        const firstSpec = path.join(workspace, 'a.e2e.ts')
        const secondSpec = path.join(workspace, 'b.e2e.ts')
        const rerunManifestPath = path.join(workspace, 'rerun-failures.ndjson')
        let runs = 0

        const failTest = async (args: FailedRerunRunArgs, spec: string, fullTitle: string) => {
            const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
            await service.afterTest({ title: fullTitle, fullTitle, file: spec } as never, {}, {
                passed: false,
                duration: 1,
                retries: { attempts: 0, limit: 0 }
            } as never)
        }

        await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            rerunManifestPath,
            run: async (_configPath, args) => {
                runs++

                if (runs === 1) {
                    await failTest(args, firstSpec, 'a fails')
                    await failTest(args, secondSpec, 'b fails')
                    return 1
                }

                // Each spec group is a separate rerun writing its own manifest.
                await failTest(args, runs === 2 ? firstSpec : secondSpec, runs === 2 ? 'a fails' : 'b fails')
                return 1
            }
        })

        const recorded = await readFailedTests(rerunManifestPath)

        expect(recorded.map((record) => record.fullTitle).sort()).toEqual(['a fails', 'b fails'])
    })
})
