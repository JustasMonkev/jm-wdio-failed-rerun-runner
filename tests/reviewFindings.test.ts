import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    createFailedTestsRerunner,
    runFailedTestsRerun
} from '#src/index'
import { readFailedTests } from '#src/manifest'
import type { FailedRerunRunArgs, FailedRerunServiceOptions, FailedTestRecord } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-review-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === FAILED_RERUN_SERVICE_PATH)
    return (service as [string, FailedRerunServiceOptions])[1]
}

async function recordAs(manifestPath: string, cid: string, passed: boolean) {
    const previous = process.env.WDIO_WORKER_ID
    process.env.WDIO_WORKER_ID = cid

    try {
        const service = new FailedTestRerunService({ manifestPath, attempt: 'rerun' }, {}, {} as WebdriverIO.Config)
        await service.afterTest({
            title: 'signs in',
            fullTitle: 'login signs in',
            file: 'specs/login.e2e.ts'
        } as never, {}, {
            passed,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as never)
    } finally {
        if (previous === undefined) {
            delete process.env.WDIO_WORKER_ID
        } else {
            process.env.WDIO_WORKER_ID = previous
        }
    }
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('records from different workers are distinct executions', () => {
    it('keeps one capability failing when another capability passes', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')

        // The same spec and title run once per capability, in separate workers. Collapsing
        // them on title alone lets the browser that passed erase the one that failed.
        await recordAs(manifestPath, '0-0', false)
        await recordAs(manifestPath, '1-0', true)

        const failures = await readFailedTests(manifestPath)

        expect(failures).toHaveLength(1)
        expect(failures[0].cid).toBe('0-0')
    })

    it('still lets a retry within one worker supersede its own earlier failure', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')

        await recordAs(manifestPath, '0-0', false)
        await recordAs(manifestPath, '0-0', true)

        expect(await readFailedTests(manifestPath)).toEqual([])
    })
})

describe('matching a rerun to the failure it targets ignores the worker', () => {
    it('recognises a rerun that ran in a different worker than the initial run', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')
        const previous = process.env.WDIO_WORKER_ID
        let runs = 0

        try {
            const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
                cwd: workspace,
                quiet: true,
                run: async (_configPath, args) => {
                    runs++
                    // WebdriverIO starts a fresh worker for the rerun, so its cid differs
                    // from the one that recorded the original failure. Matching on the
                    // worker id would make every rerun look like it never ran the test.
                    process.env.WDIO_WORKER_ID = runs === 1 ? '0-0' : '0-1'

                    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                    await service.afterTest({
                        title: 'signs in',
                        fullTitle: 'login signs in',
                        file: spec
                    } as never, {}, {
                        passed: runs > 1,
                        duration: 1,
                        retries: { attempts: 0, limit: 0 }
                    } as never)

                    return runs > 1 ? 0 : 1
                }
            })

            expect(result.exitCode).toBe(0)
            expect(result.summary.notExecuted).toEqual([])
            expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual(['login signs in'])
        } finally {
            if (previous === undefined) {
                delete process.env.WDIO_WORKER_ID
            } else {
                process.env.WDIO_WORKER_ID = previous
            }
        }
    })
})

describe('the summary reflects the last rerun, not every rerun', () => {
    it('calls a test flaky when a later round recovers it', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')
        let runs = 0

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            maxReruns: 2,
            run: async (_configPath, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                const passed = runs === 3

                await service.afterTest({
                    title: 'signs in',
                    fullTitle: 'login signs in',
                    file: spec
                } as never, {}, {
                    passed,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)

                return passed ? 0 : 1
            }
        })

        // The run exits 0, so reporting the test as broken would contradict its own verdict.
        expect(result.exitCode).toBe(0)
        expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual(['login signs in'])
        expect(result.summary.broken).toEqual([])
    })

    it('still calls a test broken when the last round fails it', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            maxReruns: 2,
            run: async (_configPath, args) => {
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                await service.afterTest({
                    title: 'signs in',
                    fullTitle: 'login signs in',
                    file: spec
                } as never, {}, {
                    passed: false,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 1
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.summary.broken.map((test) => test.fullTitle)).toEqual(['login signs in'])
        expect(result.summary.flaky).toEqual([])
    })
})

describe('substituted manifest storage is respected', () => {
    it('does not write the combined manifest to disk behind a custom store', async () => {
        const workspace = await makeTempDir()
        const rerunManifestPath = path.join(workspace, 'rerun.ndjson')
        const records = new Map<string, FailedTestRecord[]>()
        const failure: FailedTestRecord = {
            attempt: 'initial',
            framework: 'mocha',
            spec: path.join(workspace, 'a.e2e.ts'),
            fullTitle: 'suite t'
        }

        const rerunner = createFailedTestsRerunner({
            manifests: {
                async reset(manifestPath) {
                    records.set(manifestPath, manifestPath.includes('initial') ? [failure] : [])
                },
                async read(manifestPath) {
                    return records.get(manifestPath) ?? []
                }
            },
            run: async () => 1
        })

        await rerunner.run(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            rerunManifestPath
        })

        // A caller who substitutes storage must not find files appearing on disk anyway.
        expect(await fs.readdir(workspace)).toEqual([])
    })

    it('writes the combined manifest through a store that can append', async () => {
        const workspace = await makeTempDir()
        const rerunManifestPath = path.join(workspace, 'rerun.ndjson')
        const appended: Array<{ manifestPath: string, record: FailedTestRecord }> = []
        const records = new Map<string, FailedTestRecord[]>()
        const failure: FailedTestRecord = {
            attempt: 'initial',
            framework: 'mocha',
            spec: path.join(workspace, 'a.e2e.ts'),
            fullTitle: 'suite t'
        }

        const rerunner = createFailedTestsRerunner({
            manifests: {
                async reset(manifestPath) {
                    records.set(manifestPath, manifestPath.includes('initial') ? [failure] : [failure])
                },
                async read(manifestPath) {
                    return records.get(manifestPath) ?? []
                },
                async append(manifestPath, record) {
                    appended.push({ manifestPath, record })
                }
            },
            run: async () => 1
        })

        await rerunner.run(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            rerunManifestPath
        })

        expect(appended.map((entry) => entry.record.fullTitle)).toEqual(['suite t'])
        expect(appended[0].manifestPath).toBe(rerunManifestPath)
        expect(await fs.readdir(workspace)).toEqual([])
    })
})

describe('a focused rerun cannot be inverted away', () => {
    it.each([
        ['mocha', { mochaOpts: { invert: true } }, 'mochaOpts'],
        ['jasmine', { jasmineOpts: { invertGrep: true } }, 'jasmineOpts']
    ])('overrides %s grep inversion so the filter selects the target', async (framework, args, key) => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        let rerunOptions: Record<string, unknown> | undefined

        await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            args,
            run: async (_configPath, runArgs) => {
                const options = (runArgs as Record<string, Record<string, unknown> | undefined>)[key]
                if (options?.grep) {
                    rerunOptions = options
                    return 0
                }

                const config = framework === 'jasmine' ? { framework: 'jasmine' } : {}
                const service = new FailedTestRerunService(
                    getServiceOptions(runArgs),
                    {},
                    config as WebdriverIO.Config
                )
                await service.afterTest({
                    title: 't',
                    fullTitle: 'suite t',
                    fullName: 'suite t',
                    description: 't',
                    file: spec
                } as never, {}, {
                    passed: false,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 1
            }
        })

        // Keeping the project's inversion would make this filter EXCLUDE the failed test
        // and run everything else, so the target could never recover.
        expect(rerunOptions?.grep).toBe('^(?:suite t)$')
        expect(rerunOptions?.[framework === 'jasmine' ? 'invertGrep' : 'invert']).toBe(false)
    })
})

describe('a rerun that recorded nothing is never read as a recovery', () => {
    it('does not call a test flaky when the rerun failed without recording it', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        let runs = 0

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs++

                if (runs === 1) {
                    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                    await service.afterTest({
                        title: 't',
                        fullTitle: 'suite t',
                        file: spec
                    } as never, {}, {
                        passed: false,
                        duration: 1,
                        retries: { attempts: 0, limit: 0 }
                    } as never)
                    return 1
                }

                // The rerun executed the test but reported failure without recording which
                // one - a crash, or two tests sharing a full title colliding in the
                // manifest. It proves nothing about whether the target recovered.
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                await service.afterTest({
                    title: 't',
                    fullTitle: 'suite t',
                    file: spec
                } as never, {}, {
                    passed: true,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 1
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.summary.flaky).toEqual([])
        expect(result.summary.notExecuted.map((test) => test.fullTitle)).toEqual(['suite t'])
    })
})
