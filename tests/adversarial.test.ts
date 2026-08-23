import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, {
    FAILED_RERUN_SERVICE_PATH,
    MAX_RERUNS_LIMIT,
    runFailedTestsRerun
} from '#src/index'
import { serializeError } from '#src/errors'
import { readFailedTests } from '#src/manifest'
import { buildExactTitleFilters, buildExactTitleGrep } from '#src/planner'
import { parseCliArgs } from '#src/run'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-adversarial-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === FAILED_RERUN_SERVICE_PATH)
    return (service as [string, FailedRerunServiceOptions])[1]
}

async function recordFailure(manifestPath: string, error: unknown) {
    const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
    await service.afterTest({
        title: 'test',
        fullTitle: 'suite test',
        file: 'specs/a.e2e.ts'
    } as never, {}, {
        passed: false,
        duration: 1,
        error,
        retries: { attempts: 0, limit: 0 }
    } as never)
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('hostile error objects', () => {
    // serializeError runs inside the WebdriverIO afterTest hook. If it throws, the very
    // failure record the rerun depends on is lost, so no error shape may escape it.
    const hostile: Array<[string, () => unknown]> = [
        ['an accessor that throws', () => {
            const error = new Error('boom')
            Object.defineProperty(error, 'evil', {
                enumerable: true,
                get() {
                    throw new Error('property exploded')
                }
            })
            return error
        }],
        ['a Proxy that throws from ownKeys', () => Object.assign(new Error('boom'), {
            proxy: new Proxy({}, {
                ownKeys() {
                    throw new Error('no keys for you')
                }
            })
        })],
        ['5000 levels of nesting', () => {
            const root: Record<string, unknown> = {}
            let node = root
            for (let depth = 0; depth < 5000; depth++) {
                node.next = {}
                node = node.next as Record<string, unknown>
            }
            return Object.assign(new Error('boom'), { root })
        }],
        ['a BigInt property', () => Object.assign(new Error('boom'), { big: 10n })],
        ['a symbol property value', () => Object.assign(new Error('boom'), { sym: Symbol('s') })],
        ['non-finite numbers', () => Object.assign(new Error('boom'), {
            nan: Number.NaN,
            infinite: Number.POSITIVE_INFINITY
        })],
        ['a self-referencing error', () => {
            const error: Error & { self?: unknown } = new Error('boom')
            error.self = error
            return error
        }],
        ['a null-prototype object', () => {
            const bare = Object.create(null) as Record<string, unknown>
            bare.a = 1
            return Object.assign(new Error('boom'), { bare })
        }],
        ['a plain string', () => 'plain string failure'],
        ['null', () => null]
    ]

    for (const [name, build] of hostile) {
        it(`records a failure whose error contains ${name}`, async () => {
            const workspace = await makeTempDir()
            const manifestPath = path.join(workspace, 'failures.ndjson')

            await expect(recordFailure(manifestPath, build())).resolves.toBeUndefined()
            expect(await readFailedTests(manifestPath)).toHaveLength(1)
        })
    }

    it('caps recursion instead of overflowing the stack', () => {
        const root: Record<string, unknown> = {}
        let node = root
        for (let depth = 0; depth < 10000; depth++) {
            node.next = {}
            node = node.next as Record<string, unknown>
        }

        const serialized = serializeError(Object.assign(new Error('boom'), { root }))

        expect(JSON.stringify(serialized)).toContain('[Max depth exceeded]')
    })
})

describe('title filters round-trip exactly', () => {
    // Every one of these has burned some test runner: the filter must match the title it
    // was built from, and building it must not produce an invalid expression.
    const titles = [
        'a/b', 'a-b', 'a+b', 'a.b', 'a*b', 'a?b', 'a[b]', 'a{b}', 'a(b)', 'a|b',
        'a^b', 'a$b', 'a\\b', 'emoji ✅ here', 'ünïcödé', '   padded   ',
        '/^looks like a regex$/', '(?:group)', '\\d+', ']', '[', '\\',
        'a'.repeat(500), 'tab\tseparated'
    ]

    for (const title of titles) {
        it(`matches ${JSON.stringify(title)} and nothing else`, () => {
            const grep = buildExactTitleGrep([title])
            const [filter] = buildExactTitleFilters([title])

            expect(new RegExp(grep).test(title)).toBe(true)
            expect(new RegExp(filter).test(title)).toBe(true)
            expect(new RegExp(grep).test(`prefix ${title}`)).toBe(false)
            expect(new RegExp(grep).test(`${title} suffix`)).toBe(false)
        })
    }

    it('survives JSON serialization, as worker IPC requires', () => {
        const filters = buildExactTitleFilters(titles)

        expect(JSON.parse(JSON.stringify(filters))).toEqual(filters)
    })
})

describe('--max-reruns boundaries', () => {
    const rejected = ['-1', '1.5', '1e3', '0x10', 'NaN', 'Infinity', ' 5', '+5', '999999999999999999999']

    for (const value of rejected) {
        it(`rejects ${JSON.stringify(value)}`, () => {
            expect(() => parseCliArgs(['./wdio.conf.ts', '--max-reruns', value])).toThrow()
        })
    }

    it('names the real problem for a negative count instead of claiming the value is missing', () => {
        expect(() => parseCliArgs(['./wdio.conf.ts', '--max-reruns', '-1']))
            .toThrow('--max-reruns must be a non-negative integer')
    })

    it('accepts the inclusive bounds and rejects one past the top', () => {
        expect(parseCliArgs(['./wdio.conf.ts', '--max-reruns', '0']).options.maxReruns).toBe(0)
        expect(parseCliArgs(['./wdio.conf.ts', '--max-reruns', String(MAX_RERUNS_LIMIT)]).options.maxReruns)
            .toBe(MAX_RERUNS_LIMIT)
        expect(() => parseCliArgs(['./wdio.conf.ts', '--max-reruns', String(MAX_RERUNS_LIMIT + 1)]))
            .toThrow(`--max-reruns must be between 0 and ${MAX_RERUNS_LIMIT}`)
    })

    it('clamps an absurd programmatic count instead of rerunning forever', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        let runs = 0

        // Number('9e20') passes an isInteger check, so without a ceiling this loops
        // ~1e21 times, launching WebdriverIO on every round.
        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            maxReruns: 1e21,
            run: async (_configPath, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                await service.afterTest({ title: 't', fullTitle: 'suite t', file: spec } as never, {}, {
                    passed: false,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 1
            }
        })

        expect(runs).toBe(MAX_RERUNS_LIMIT + 1)
        expect(result.exitCode).toBe(1)
    })

    it.each([
        ['Infinity', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN],
        ['a negative count', -5]
    ])('treats %s as no reruns rather than looping', async (_name, maxReruns) => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'a.e2e.ts')
        let runs = 0

        await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            quiet: true,
            maxReruns,
            run: async (_configPath, args) => {
                runs++
                const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
                await service.afterTest({ title: 't', fullTitle: 'suite t', file: spec } as never, {}, {
                    passed: false,
                    duration: 1,
                    retries: { attempts: 0, limit: 0 }
                } as never)
                return 1
            }
        })

        expect(runs).toBe(1)
    })
})
