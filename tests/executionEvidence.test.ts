import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    BROWSERSTACK_RERUN_TESTS_ENV,
    FAILED_RERUN_SERVICE_PATH,
    runFailedTestsRerun
} from '#src/index'
import { readFailedTests } from '#src/manifest'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-evidence-'))
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

describe('a skipped test is never evidence that a rerun ran', () => {
    it('does not let a skipped Cucumber scenario count as a recovery', async () => {
        const workspace = await makeTempDir()
        const feature = path.join(workspace, 'login.feature')
        let runs = 0

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)

                if (runs === 1) {
                    await service.afterScenario(
                        { pickle: { name: 'signs in', uri: feature }, result: { status: 'FAILED' } } as never,
                        { passed: false, duration: 1, error: 'nope' } as never,
                        {}
                    )
                    return 1
                }

                // @wdio/cucumber-framework maps SKIPPED to `passed: true`, so without a
                // status check this would look exactly like a recovery.
                await service.afterScenario(
                    { pickle: { name: 'signs in', uri: feature }, result: { status: 'SKIPPED' } } as never,
                    { passed: true, duration: 0 } as never,
                    {}
                )
                return 0
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.summary.flaky).toEqual([])
        expect(result.summary.notExecuted.map((test) => test.fullTitle)).toEqual(['signs in'])
    })

    it('does not let a skipped Mocha test count as a recovery', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')
        let runs = 0

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                const skipped = runs > 1

                await service.afterTest({ title: 't', fullTitle: 'suite t', file: spec } as never, {}, {
                    passed: false,
                    skipped,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)

                return skipped ? 0 : 1
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.summary.notExecuted.map((test) => test.fullTitle)).toEqual(['suite t'])
    })
})

describe('awkward spec paths survive the rerun round-trip', () => {
    const specs = [
        'a b.e2e.ts',
        'ünïcödé.e2e.ts',
        "quote'.e2e.ts",
        'dollar$.e2e.ts',
        'deep/nested/x.e2e.ts'
    ]

    for (const spec of specs) {
        it(`reruns ${JSON.stringify(spec)} with a filter that matches it`, async () => {
            const workspace = await makeTempDir()
            const file = path.join(workspace, spec)
            const fullTitle = `suite handles ${spec}`
            let runs = 0
            let rerunSpec: string[] | undefined
            let rerunGrep: string | undefined

            const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
                cwd: workspace,
                quiet: true,
                run: async (_configPath, args) => {
                    runs++
                    if (runs > 1) {
                        rerunSpec = args.spec
                        rerunGrep = args.mochaOpts?.grep
                    }

                    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                    await service.afterTest({ title: 't', fullTitle, file } as never, {}, {
                        passed: runs > 1,
                        duration: 1,
                        retries: { attempts: 0, limit: 0 }
                    } as never)

                    return runs > 1 ? 0 : 1
                }
            })

            expect(rerunSpec).toEqual([file])
            expect(new RegExp(rerunGrep!).test(fullTitle)).toBe(true)
            expect(result.exitCode).toBe(0)
            expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual([fullTitle])
        })
    }

    it('still reruns a spec whose path contains a comma, without BrowserStack marking', async () => {
        const workspace = await makeTempDir()
        const file = path.join(workspace, 'comma,spec.e2e.ts')
        let runs = 0
        let markedDuringRerun: string | undefined
        let sawRerun = false

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs++
                if (runs > 1) {
                    sawRerun = true
                    markedDuringRerun = process.env[BROWSERSTACK_RERUN_TESTS_ENV]
                }

                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                await service.afterTest({ title: 't', fullTitle: 'suite t', file } as never, {}, {
                    passed: runs > 1,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)

                return runs > 1 ? 0 : 1
            }
        })

        // BrowserStack splits this variable on commas, so such a path cannot be expressed.
        // The rerun must still happen; only the marking is skipped.
        expect(sawRerun).toBe(true)
        expect(markedDuringRerun).toBeUndefined()
        expect(result.exitCode).toBe(0)
    })
})

describe('manifest under concurrent worker writes', () => {
    it('keeps every record readable when several processes append at once', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const child = fileURLToPath(new URL('./fixtures/appendFailures.mjs', import.meta.url))
        const workers = 6
        const perWorker = 40

        await Promise.all(Array.from({ length: workers }, (_unused, index) => new Promise<void>((resolve, reject) => {
            fork(child, [manifestPath, String(index), String(perWorker)])
                .on('exit', (code) => code === 0 ? resolve() : reject(new Error(`worker ${index} exited ${code}`)))
        })))

        const records = await readFailedTests(manifestPath)

        expect(records).toHaveLength(workers * perWorker)
    }, 60000)
})
