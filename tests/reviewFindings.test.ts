import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    createFailedTestsRerunner,
    runFailedTestsRerun
} from '#src/index'
import { readFailedTests, readManifest } from '#src/manifest'
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

    it('lets a spec-file retry supersede its earlier attempt during the initial run', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const previous = process.env.WDIO_WORKER_ID

        const record = async (cid: string, passed: boolean) => {
            process.env.WDIO_WORKER_ID = cid
            const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
            await service.afterTest({
                title: 'signs in',
                fullTitle: 'login signs in',
                file: 'specs/login.e2e.ts'
            } as never, {}, {
                passed,
                duration: 1,
                retries: { attempts: 0, limit: 0 }
            } as never)
        }

        try {
            // specFileRetries applies to the initial attempt too. Recording failures only
            // there would leave nothing for the retry's pass to supersede, so a test
            // WebdriverIO had already recovered would still be queued for a focused rerun.
            await record('0-0', false)
            await record('0-1', true)

            expect(await readFailedTests(manifestPath)).toEqual([])
        } finally {
            if (previous === undefined) {
                delete process.env.WDIO_WORKER_ID
            } else {
                process.env.WDIO_WORKER_ID = previous
            }
        }
    })

    it('lets a spec-file retry supersede an earlier Cucumber failure', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const previous = process.env.WDIO_WORKER_ID

        const record = async (cid: string, passed: boolean) => {
            process.env.WDIO_WORKER_ID = cid
            const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
            await service.afterScenario(
                { pickle: { name: 'signs in', uri: 'features/login.feature' }, result: { status: passed ? 'PASSED' : 'FAILED' } } as never,
                { passed, duration: 1 } as never,
                {}
            )
        }

        try {
            await record('0-0', false)
            await record('0-1', true)

            expect(await readFailedTests(manifestPath)).toEqual([])
        } finally {
            if (previous === undefined) {
                delete process.env.WDIO_WORKER_ID
            } else {
                process.env.WDIO_WORKER_ID = previous
            }
        }
    })

    it('lets a WebdriverIO spec-file retry supersede the attempt it replaced', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')

        // specFileRetries reruns the failed spec in a NEW worker, so the retry carries the
        // same capability index with a higher run counter. Keying on the whole cid would
        // keep the stale failure alive after WebdriverIO's own retry had already passed.
        await recordAs(manifestPath, '0-0', false)
        await recordAs(manifestPath, '0-1', true)

        expect(await readFailedTests(manifestPath)).toEqual([])
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

describe('execution evidence is scoped to the capability that produced it', () => {
    it('does not let one capability\'s pass vouch for another that never ran', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')
        const previous = process.env.WDIO_WORKER_ID
        let runs = 0

        const record = async (args: FailedRerunRunArgs, cid: string, passed: boolean) => {
            process.env.WDIO_WORKER_ID = cid
            const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
            await service.afterTest({
                title: 'signs in',
                fullTitle: 'login signs in',
                file: spec
            } as never, {}, {
                passed,
                duration: 1,
                retries: { attempts: 0, limit: 0 }
            } as never)
        }

        try {
            const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
                cwd: workspace,
                quiet: true,
                run: async (_configPath, args) => {
                    runs++

                    if (runs === 1) {
                        // The same test fails under two capabilities.
                        await record(args, '0-0', false)
                        await record(args, '1-0', false)
                        return 1
                    }

                    // Only the first capability reruns and passes; the second never runs.
                    await record(args, '0-0', true)
                    return 0
                }
            })

            expect(result.exitCode).toBe(1)
            expect(result.summary.flaky).toHaveLength(1)
            expect(result.summary.notExecuted).toHaveLength(1)
            expect(result.summary.notExecuted[0].cid).toBe('1-0')
        } finally {
            if (previous === undefined) {
                delete process.env.WDIO_WORKER_ID
            } else {
                process.env.WDIO_WORKER_ID = previous
            }
        }
    })

    it('matches a rerun to the failure it targets across differing run counters', async () => {
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
                    // WebdriverIO's cid is `<capabilityIndex>-<runCounter>`; only the
                    // capability index is stable between attempts.
                    process.env.WDIO_WORKER_ID = runs === 1 ? '0-3' : '0-0'

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

describe('serialization survives a hostile prototype chain', () => {
    it('records the failure when a Proxy refuses getPrototypeOf', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // `instanceof` walks the prototype chain, so this throws before any guarded
        // traversal begins.
        const hostile = new Proxy({}, {
            getPrototypeOf() {
                throw new Error('no prototype for you')
            }
        })

        await expect(service.afterTest(
            { title: 't', fullTitle: 'suite t', file: 'specs/a.e2e.ts' } as never,
            {},
            {
                passed: false,
                duration: 1,
                error: Object.assign(new Error('boom'), { hostile }),
                retries: { attempts: 0, limit: 0 }
            } as never
        )).resolves.toBeUndefined()

        expect(await readFailedTests(manifestPath)).toHaveLength(1)
    })
})

describe('an unreadable manifest can never be reported as passing', () => {
    it('fails the run when a failure line was lost, even if the rest recovered', async () => {
        const workspace = await makeTempDir()
        const firstSpec = path.join(workspace, 'a.e2e.ts')
        const secondSpec = path.join(workspace, 'b.e2e.ts')
        const manifestPath = path.join(workspace, 'initial.ndjson')
        let runs = 0

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            manifestPath,
            run: async (_configPath, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)

                if (runs === 1) {
                    await service.afterTest({
                        title: 'a',
                        fullTitle: 'suite a',
                        file: firstSpec
                    } as never, {}, {
                        passed: false,
                        duration: 1,
                        retries: { attempts: 0, limit: 0 }
                    } as never)

                    // A worker killed mid-write leaves the second failure half-recorded.
                    await fs.appendFile(
                        manifestPath,
                        `{"attempt":"initial","framework":"mocha","spec":"${secondSpec}","fullTi\n`
                    )
                    return 1
                }

                await service.afterTest({
                    title: 'a',
                    fullTitle: 'suite a',
                    file: firstSpec
                } as never, {}, {
                    passed: true,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 0
            }
        })

        // Skipping the bad line keeps the run alive, but the failure it described was
        // never retried, so success cannot be claimed.
        expect(result.exitCode).toBe(1)
        expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual(['suite a'])
    })

    it('fails a run that exited zero when a manifest line was lost', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'initial.ndjson')

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            manifestPath,
            run: async () => {
                // The framework reported success, but a worker died mid-write. Whatever
                // that line said is unknowable, so success cannot be claimed.
                await fs.mkdir(path.dirname(manifestPath), { recursive: true })
                await fs.appendFile(manifestPath, '{"attempt":"initial","framework":"moc\n')
                return 0
            }
        })

        expect(result.exitCode).toBe(1)
    })

    it('says why the run was failed', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'initial.ndjson')
        const lines: string[] = []

        await createFailedTestsRerunner({ logger: { log: (message) => lines.push(message) } }).run(
            path.join(workspace, 'wdio.conf.ts'),
            {
                cwd: workspace,
                manifestPath,
                run: async () => {
                    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
                    await fs.appendFile(manifestPath, 'not json at all\n')
                    return 1
                }
            }
        )

        expect(lines.some((line) => line.includes('could not be read'))).toBe(true)
    })
})

describe('failures first seen during a rerun are reported', () => {
    it('reports a capability that newly fails, so the summary matches the exit code', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')
        const previous = process.env.WDIO_WORKER_ID
        let runs = 0

        const record = async (args: FailedRerunRunArgs, cid: string, passed: boolean) => {
            process.env.WDIO_WORKER_ID = cid
            const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
            await service.afterTest({
                title: 'signs in',
                fullTitle: 'login signs in',
                file: spec
            } as never, {}, {
                passed,
                duration: 1,
                retries: { attempts: 0, limit: 0 }
            } as never)
        }

        try {
            const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
                cwd: workspace,
                quiet: true,
                run: async (_configPath, args) => {
                    runs++

                    if (runs === 1) {
                        await record(args, '0-0', false)
                        return 1
                    }

                    // The rerun launches the spec under every capability, so one that
                    // passed initially can fail here for the first time.
                    await record(args, '0-0', true)
                    await record(args, '1-0', false)
                    return 1
                }
            })

            expect(result.exitCode).toBe(1)
            expect(result.summary.flaky).toHaveLength(1)
            expect(result.summary.broken).toHaveLength(1)
            expect(result.summary.broken[0].cid).toBe('1-0')
        } finally {
            if (previous === undefined) {
                delete process.env.WDIO_WORKER_ID
            } else {
                process.env.WDIO_WORKER_ID = previous
            }
        }
    })
})

describe('serialization survives a revoked proxy', () => {
    it('records the failure when a revoked Proxy is an error detail', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
        const { proxy, revoke } = Proxy.revocable({}, {})
        revoke()

        // A revoked Proxy answers the guarded isError check safely but throws from
        // Array.isArray, which sits before the traversal.
        await expect(service.afterTest(
            { title: 't', fullTitle: 'suite t', file: 'specs/a.e2e.ts' } as never,
            {},
            {
                passed: false,
                duration: 1,
                error: Object.assign(new Error('boom'), { dead: proxy }),
                retries: { attempts: 0, limit: 0 }
            } as never
        )).resolves.toBeUndefined()

        expect(await readFailedTests(manifestPath)).toHaveLength(1)
    })
})

describe('internally generated manifests do not accumulate', () => {
    it('removes the temp manifests it invented, even on a fully green run', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        const seen: string[] = []

        await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                const options = getServiceOptions(args)
                seen.push(options.manifestPath)

                const service = new FailedTestRerunService(options, {}, {} as WebdriverIO.Config)
                await service.afterTest({
                    title: 't',
                    fullTitle: 'suite t',
                    file: spec
                } as never, {}, {
                    passed: true,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 0
            }
        })

        // Every completed test is recorded now, so leaving these behind would drop a
        // full-suite NDJSON file into the temp directory on every run.
        expect(seen).not.toHaveLength(0)
        for (const manifestPath of seen) {
            await expect(fs.access(manifestPath)).rejects.toThrow()
        }
    })

    it('leaves a manifest the caller named alone', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        const manifestPath = path.join(workspace, 'initial-failures.ndjson')

        await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            maxReruns: 0,
            manifestPath,
            run: async (_configPath, args) => {
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
        })

        // A path the caller supplied is their build artifact.
        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle)).toEqual(['suite t'])
    })

    it('removes the temp manifests each rerun round invents', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        const seen: string[] = []
        let runs = 0

        await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                runs++
                const options = getServiceOptions(args)
                seen.push(options.manifestPath)

                const service = new FailedTestRerunService(options, {}, {} as WebdriverIO.Config)
                await service.afterTest({
                    title: 't',
                    fullTitle: 'suite t',
                    file: spec
                } as never, {}, {
                    passed: runs > 1,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return runs > 1 ? 0 : 1
            }
        })

        // Each rerun round resolves its own temp path, so those need collecting too.
        expect(seen).toHaveLength(2)
        for (const manifestPath of seen) {
            await expect(fs.access(manifestPath)).rejects.toThrow()
        }
    })

    it('does not fail the run when cleanup itself fails', async () => {
        const workspace = await makeTempDir()
        const records = new Map<string, FailedTestRecord[]>()
        let resets = 0

        const rerunner = createFailedTestsRerunner({
            manifests: {
                async reset(manifestPath) {
                    resets++
                    // A read-only temp directory, a removed mount: tidying up is not worth
                    // turning a completed run into a failure.
                    if (resets > 1) {
                        throw new Error('EROFS: read-only file system')
                    }
                    records.set(manifestPath, [])
                },
                async read(manifestPath) {
                    return records.get(manifestPath) ?? []
                }
            },
            run: async () => 0
        })

        const result = await rerunner.run(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true
        })

        expect(result.exitCode).toBe(0)
        expect(resets).toBeGreaterThan(1)
    })

    it('still cleans up when the run throws after writing', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        const seen: string[] = []

        await expect(runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_configPath, args) => {
                const options = getServiceOptions(args)
                seen.push(options.manifestPath)

                // Write first: a manifest that was never written to would be absent
                // whether or not cleanup ran, so the assertion below could not tell.
                const service = new FailedTestRerunService(options, {}, {} as WebdriverIO.Config)
                await service.afterTest({
                    title: 't',
                    fullTitle: 'suite t',
                    file: spec
                } as never, {}, {
                    passed: false,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)

                throw new Error('launcher exploded')
            }
        })).rejects.toThrow('launcher exploded')

        expect(seen).toHaveLength(1)
        await expect(fs.access(seen[0])).rejects.toThrow()
    })
})

describe('a pending test is never queued for rerun', () => {
    it('recognises Mocha\'s pending flag when WebdriverIO\'s skip marker is absent', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // WebdriverIO decides `skipped` by string-matching the error a framework throws to
        // signal a skip. When that misses, the framework's own `pending` flag on the test
        // is the only signal left, and without it the test is queued for a rerun it can
        // never pass, so the run can never go green.
        await service.afterTest({
            title: 'skipped at runtime',
            fullTitle: 'suite skipped at runtime',
            file: 'specs/a.e2e.js',
            pending: true
        } as never, {}, {
            passed: false,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as never)

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('still records an ordinary failure', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterTest({
            title: 'real failure',
            fullTitle: 'suite real failure',
            file: 'specs/a.e2e.js',
            pending: false
        } as never, {}, {
            passed: false,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as never)

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['suite real failure'])
    })
})

describe('a custom store returning raw records is handled', () => {
    it('lets a later pass supersede an earlier failure from an undeduplicated readAll', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        const failure: FailedTestRecord = {
            attempt: 'initial',
            framework: 'mocha',
            spec,
            fullTitle: 'suite t',
            cid: '0-0'
        }
        // `readAll` is documented as every record a rerun wrote. A custom adapter honouring
        // that literally returns both the failed spec-file attempt and the passing retry.
        const raw: FailedTestRecord[] = [
            { ...failure, attempt: 'rerun' },
            { ...failure, attempt: 'rerun', cid: '0-1', outcome: 'passed' }
        ]
        let runs = 0

        const result = await createFailedTestsRerunner({
            manifests: {
                async reset() {},
                async read() {
                    return runs <= 1 ? [failure] : raw.filter((record) => record.outcome !== 'passed')
                },
                async readAll() {
                    return raw
                }
            },
            run: async () => {
                runs++
                return runs === 1 ? 1 : 0
            }
        }).run(path.join(workspace, 'wdio.conf.ts'), { cwd: workspace, quiet: true })

        expect(result.exitCode).toBe(0)
        expect(result.summary.flaky.map((test) => test.fullTitle)).toEqual(['suite t'])
        expect(result.summary.broken).toEqual([])
    })
})

describe('a skipped test retires an earlier failure without proving execution', () => {
    it('lets a skip in the final spec-file retry supersede the failure it replaced', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'manifest.ndjson')
        const previous = process.env.WDIO_WORKER_ID
        const test = {
            title: 'signs in',
            fullTitle: 'login signs in',
            file: 'specs/login.e2e.ts'
        }
        const result = { duration: 1, passed: false, retries: { attempts: 0, limit: 0 } }

        try {
            // `specFileRetries` reruns the spec in a fresh worker. The first worker fails the
            // test; the retry skips it - a conditional `this.skip()`, or a filter that now
            // excludes it. The skip is the last word on the test, so the failure is retired.
            process.env.WDIO_WORKER_ID = '0-0'
            await new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
                .afterTest(test as never, {}, result as never)

            process.env.WDIO_WORKER_ID = '0-1'
            await new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
                .afterTest({ ...test, pending: true } as never, {}, result as never)
        } finally {
            process.env.WDIO_WORKER_ID = previous
        }

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('lets a skipped scenario in the final spec-file retry supersede the failure it replaced', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'manifest.ndjson')
        const previous = process.env.WDIO_WORKER_ID
        const feature = path.join(workspace, 'login.feature')

        try {
            process.env.WDIO_WORKER_ID = '0-0'
            await new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
                .afterScenario(
                    { pickle: { name: 'signs in', uri: feature }, result: { status: 'FAILED' } } as never,
                    { passed: false, duration: 1, error: 'nope' } as never,
                    {}
                )

            // The spec-file retry ran the feature again and the scenario was skipped. The
            // skip is the last word on it, so the earlier worker's failure is retired.
            process.env.WDIO_WORKER_ID = '0-1'
            await new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
                .afterScenario(
                    { pickle: { name: 'signs in', uri: feature }, result: { status: 'SKIPPED' } } as never,
                    { passed: true, duration: 0 } as never,
                    {}
                )
        } finally {
            process.env.WDIO_WORKER_ID = previous
        }

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('refuses to call a rerun a recovery when it skipped the test it targeted', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'login.e2e.ts')
        const test = { title: 'signs in', fullTitle: 'login signs in', file: spec }
        const result = { duration: 1, passed: false, retries: { attempts: 0, limit: 0 } }
        let runs = 0

        const rerun = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_config, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)

                if (runs === 1) {
                    await service.afterTest(test as never, {}, result as never)
                    return 1
                }

                // The rerun skipped the very test it was launched to retry. Nothing was
                // proven about it, so it must not be reported as flaky.
                await service.afterTest({ ...test, pending: true } as never, {}, result as never)
                return 0
            }
        })

        expect(rerun.exitCode).toBe(1)
        expect(rerun.summary.flaky).toEqual([])
        // A skip proves nothing either way, so it is reported as no result - never also as
        // still failing, which would contradict it in the same summary.
        expect(rerun.summary.broken).toEqual([])
        expect(rerun.summary.notExecuted.map((record) => record.fullTitle)).toEqual(['login signs in'])
    })

    it('refuses to call a cucumber rerun a recovery when the scenario was skipped', async () => {
        const workspace = await makeTempDir()
        const feature = path.join(workspace, 'login.feature')
        let runs = 0

        const rerun = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            run: async (_config, args) => {
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

                // `@wdio/cucumber-framework` reports a SKIPPED scenario as `passed: true`.
                // Taking that at face value would turn a genuinely failing build green.
                await service.afterScenario(
                    { pickle: { name: 'signs in', uri: feature }, result: { status: 'SKIPPED' } } as never,
                    { passed: true, duration: 0 } as never,
                    {}
                )
                return 0
            }
        })

        expect(rerun.exitCode).toBe(1)
        expect(rerun.summary.flaky).toEqual([])
        expect(rerun.summary.broken).toEqual([])
        expect(rerun.summary.notExecuted.map((record) => record.fullTitle)).toEqual(['signs in'])
    })
})

describe('a hostile framework object cannot cost the failure record', () => {
    // Every one of these is read off an object a framework hands the hook. A partially
    // initialised or hostile one can expose an accessor that throws, and an exception here
    // rejects the hook and loses the very failure the rerun exists to fix.
    function withThrowingGetter<T extends object>(target: T, key: string) {
        Object.defineProperty(target, key, {
            configurable: true,
            get() {
                throw new Error(`cannot read ${key}`)
            }
        })
        return target
    }

    const test = () => ({ title: 'signs in', fullTitle: 'login signs in', file: 'specs/login.e2e.ts' })
    const result = () => ({ passed: false, duration: 1, retries: { attempts: 0, limit: 0 } })

    it.each(['pending', '_currentRetry', '_retries'])(
        'still records the failure when test.%s throws on read',
        async (key) => {
            const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
            const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

            await service.afterTest(withThrowingGetter(test(), key) as never, {}, result() as never)

            expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
                .toEqual(['login signs in'])
        }
    )

    it('still records the failure when result.skipped throws on read', async () => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterTest(test() as never, {}, withThrowingGetter(result(), 'skipped') as never)

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['login signs in'])
    })

    it.each([
        ['result.retries', () => withThrowingGetter({ passed: false, duration: 1 }, 'retries')],
        ['result.retries.attempts', () => {
            const value = { passed: false, duration: 1, retries: { limit: 0 } }
            withThrowingGetter(value.retries, 'attempts')
            return value
        }]
    ])('still records the failure when %s throws on read', async (_label, build) => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterTest(test() as never, {}, build() as never)

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['login signs in'])
    })

    const world = () => ({
        pickle: { name: 'signs in', uri: 'features/login.feature' },
        result: { status: 'FAILED' }
    })
    const pickleResult = () => ({ passed: false, duration: 1, error: 'nope' })

    it.each([
        ['world.result', () => withThrowingGetter(world(), 'result')],
        ['world.willBeRetried', () => withThrowingGetter(world(), 'willBeRetried')],
        ['world.result.status', () => {
            const value = world()
            withThrowingGetter(value.result, 'status')
            return value
        }],
        // A status that is not a string cannot be the skip marker, so a hostile
        // `toUpperCase` should never be reached in the first place.
        ['status.toUpperCase', () => ({
            ...world(),
            result: { status: { toUpperCase() { throw new Error('cannot upper') } } }
        })]
    ])('still records the scenario failure when %s throws on read', async (_label, build) => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterScenario(build() as never, pickleResult() as never, {})

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['signs in'])
    })
})

describe('an unreadable scenario name costs one record, not the run', () => {
    it('resolves rather than rejecting when the pickle itself cannot be read', async () => {
        // Unlike the cases above this one is genuinely unrecoverable: the scenario name
        // exists only on the pickle, so no record can be built. What must not happen is the
        // hook rejecting - that aborts the worker and takes every later failure with it.
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
        const hostile = { result: { status: 'FAILED' } }
        Object.defineProperty(hostile, 'pickle', {
            configurable: true,
            get() {
                throw new Error('cannot read pickle')
            }
        })

        await expect(service.afterScenario(
            hostile as never,
            { passed: false, duration: 1, error: 'nope' } as never,
            {}
        )).resolves.toBeUndefined()

        expect(await readFailedTests(manifestPath)).toEqual([])

        // The very next scenario, with a readable pickle, is still recorded.
        await service.afterScenario(
            { pickle: { name: 'signs out', uri: 'features/login.feature' }, result: { status: 'FAILED' } } as never,
            { passed: false, duration: 1, error: 'nope' } as never,
            {}
        )

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['signs out'])
    })
})

describe('the retry guard applies only to something that will be retried', () => {
    it('records a skip that also carries Mocha retry counters', async () => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const previous = process.env.WDIO_WORKER_ID
        const test = { title: 'signs in', fullTitle: 'login signs in', file: 'specs/login.e2e.ts' }

        try {
            process.env.WDIO_WORKER_ID = '0-0'
            await new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
                .afterTest(test as never, {}, {
                    passed: false,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)

            // The spec-file retry skipped the test. Mocha stamps its retry counters on every
            // runnable, so with `mochaOpts.retries` configured this skip looks exactly like a
            // first failed attempt awaiting a retry - but Mocha never retries a skipped test,
            // so the guard must not swallow it.
            process.env.WDIO_WORKER_ID = '0-1'
            await new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
                .afterTest({ ...test, pending: true, _currentRetry: 0, _retries: 2 } as never, {}, {
                    passed: false,
                    duration: 0,
                    retries: { attempts: 0, limit: 0 }
                } as never)
        } finally {
            process.env.WDIO_WORKER_ID = previous
        }

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('still withholds a genuine failure that Mocha will retry', async () => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // The other direction: a real failure on a non-final attempt stays out of the
        // manifest, so a test that recovers on a later retry is never queued for a rerun.
        await service.afterTest({
            title: 'signs in',
            fullTitle: 'login signs in',
            file: 'specs/login.e2e.ts',
            _currentRetry: 0,
            _retries: 2
        } as never, {}, {
            passed: false,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as never)

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    // `@wdio/cucumber-framework` currently maps SKIPPED to `passed: true`, so today the
    // pass check alone would carry this. That mapping is upstream's to change, not ours to
    // rely on, so the two signals are read independently: a scenario this code considers
    // skipped is recorded whatever the retry flag says.
    it.each([
        ['reported as passed, the way the framework maps it today', true],
        ['reported as not passed, should that mapping ever change', false]
    ])('records a skipped scenario marked for retry when %s', async (_label, passed) => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterScenario({
            pickle: { name: 'signs in', uri: 'features/login.feature' },
            result: { status: 'SKIPPED' },
            willBeRetried: true
        } as never, { passed, duration: 0 } as never, {})

        expect((await readManifest(manifestPath)).map((record) => record.outcome)).toEqual(['skipped'])
    })
})

describe('a throwing result property cannot cost the failure record', () => {
    function withThrowingGetter<T extends object>(target: T, key: string) {
        Object.defineProperty(target, key, {
            configurable: true,
            get() {
                throw new Error(`cannot read ${key}`)
            }
        })
        return target
    }

    it.each(['passed', 'error'])('still records the failure when result.%s throws', async (key) => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterTest({
            title: 'signs in',
            fullTitle: 'login signs in',
            file: 'specs/login.e2e.ts'
        } as never, {}, withThrowingGetter({
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        }, key) as never)

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['login signs in'])
    })

    it.each(['passed', 'error'])('still records the scenario failure when result.%s throws', async (key) => {
        const manifestPath = path.join(await makeTempDir(), 'manifest.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        await service.afterScenario({
            pickle: { name: 'signs in', uri: 'features/login.feature' },
            result: { status: 'FAILED' }
        } as never, withThrowingGetter({ duration: 1 }, key) as never, {})

        expect((await readFailedTests(manifestPath)).map((record) => record.fullTitle))
            .toEqual(['signs in'])
    })
})
