import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

import Mocha from 'mocha'
import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, { flushStream } from '#src/index'
import { readFailedTests } from '#src/manifest'

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-real-'))
    tempDirs.push(tempDir)
    return tempDir
}

// `spawn`, not `fork`: fork opens an IPC channel that keeps the child's event loop alive,
// so it never reaches the natural exit these tests are about.
function runNode(script: string, args: string[] = []) {
    return new Promise<number>((resolve, reject) => {
        spawn(process.execPath, [script, ...args], { stdio: 'ignore' })
            .on('error', reject)
            .on('exit', (code) => resolve(code ?? 0))
    })
}

function runNodeCapturingStdout(script: string, args: string[] = []) {
    return new Promise<{ code: number, stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'ignore'] })
        let stdout = ''
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code: code ?? 0, stdout }))
    })
}

afterEach(async () => {
    while (tempDirs.length > 0) {
        await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
    }
})

describe('against real Mocha objects', () => {
    // These use genuine Mocha Runnables rather than hand-written stand-ins. An earlier
    // version of this test used `{ fullTitle: () => '...' }`, an arrow function that needs
    // no `this`, and so passed while real Mocha threw `this.titlePath is not a function`.
    function buildNestedTest() {
        const mocha = new Mocha()
        const outer = Mocha.Suite.create(mocha.suite, 'flaky suite')
        const inner = Mocha.Suite.create(outer, 'when the environment settles')
        const test = new Mocha.Test('passes only on rerun', () => {})
        inner.addTest(test)
        return test
    }

    it('records the full ancestor chain from the live context', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const test = buildNestedTest()
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // Exactly what @wdio/mocha-framework passes: a SPREAD of the Mocha test (which
        // drops the fullTitle prototype method and flattens parent to a title string),
        // plus the live context that still holds the real Runnable.
        await service.afterTest(
            { ...test, parent: test.parent?.title, file: 'specs/flaky.e2e.js' } as never,
            { test },
            { passed: false, duration: 1, retries: { attempts: 0, limit: 0 } } as never
        )

        const [record] = await readFailedTests(manifestPath)

        expect(record.fullTitle).toBe(test.fullTitle())
        expect(record.fullTitle).toBe('flaky suite when the environment settles passes only on rerun')
    })

    it('does not throw out of the hook when fullTitle needs its receiver', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const test = buildNestedTest()
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // Mocha's fullTitle() is `this.titlePath().join(' ')`. Invoking a detached
        // reference throws and takes the whole afterTest hook down, losing the record.
        await expect(service.afterTest(
            { ...test, parent: test.parent?.title, file: 'specs/flaky.e2e.js' } as never,
            { test },
            { passed: false, duration: 1, retries: { attempts: 0, limit: 0 } } as never
        )).resolves.toBeUndefined()

        expect(await readFailedTests(manifestPath)).toHaveLength(1)
    })

    it('keeps the failure record when a framework title accessor throws', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // A detached or half-initialised runnable can throw from fullTitle(). Losing the
        // hook to that would lose the failure the rerun exists to fix.
        const hostile = {
            fullTitle() {
                throw new Error('runnable not attached')
            }
        }

        await expect(service.afterTest(
            { title: 'logs in', parent: 'login flow', file: 'specs/login.e2e.js' } as never,
            { test: hostile },
            { passed: false, duration: 1, retries: { attempts: 0, limit: 0 } } as never
        )).resolves.toBeUndefined()

        // Falls back to parent + title rather than dropping the record entirely.
        const [record] = await readFailedTests(manifestPath)
        expect(record.fullTitle).toBe('login flow logs in')
    })

    it('keeps the failure record when a title accessor throws on read', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)

        // Distinct from a method that throws when called: this throws while the property
        // is being READ, so a try around only the invocation does not catch it.
        const hostile = {}
        Object.defineProperty(hostile, 'fullTitle', {
            enumerable: true,
            get() {
                throw new Error('runnable not attached')
            }
        })

        await expect(service.afterTest(
            { title: 'logs in', parent: 'login flow', file: 'specs/login.e2e.js' } as never,
            { test: hostile },
            { passed: false, duration: 1, retries: { attempts: 0, limit: 0 } } as never
        )).resolves.toBeUndefined()

        const [record] = await readFailedTests(manifestPath)
        expect(record.fullTitle).toBe('login flow logs in')
    })

    it('builds a filter that matches the real Mocha title and excludes its sibling', async () => {
        const workspace = await makeTempDir()
        const manifestPath = path.join(workspace, 'failures.ndjson')
        const test = buildNestedTest()
        const sibling = new Mocha.Test('sibling test that always passes', () => {})
        test.parent!.addTest(sibling)

        const service = new FailedTestRerunService({ manifestPath }, {}, {} as WebdriverIO.Config)
        await service.afterTest(
            { ...test, parent: test.parent?.title, file: 'specs/flaky.e2e.js' } as never,
            { test },
            { passed: false, duration: 1, retries: { attempts: 0, limit: 0 } } as never
        )

        const { buildExactTitleGrep } = await import('#src/planner')
        const [record] = await readFailedTests(manifestPath)
        const grep = new RegExp(buildExactTitleGrep([record.fullTitle]))

        expect(grep.test(test.fullTitle())).toBe(true)
        expect(grep.test(sibling.fullTitle())).toBe(false)
    })
})

describe('stream draining', () => {
    // Exercised against the real process streams rather than a stand-in, since the whole
    // point is how Node's own streams behave when a process is about to exit.
    it('resolves immediately when nothing is buffered', async () => {
        expect(process.stdout.writableLength).toBe(0)

        await expect(flushStream(process.stdout)).resolves.toBeUndefined()
    })

    it('waits for a stream that still has buffered data', async () => {
        const stream = createWriteStream(path.join(await makeTempDir(), 'out.txt'))
        stream.write('x'.repeat(2_000_000))

        expect(stream.writableLength).toBeGreaterThan(0)
        await expect(flushStream(stream as unknown as NodeJS.WriteStream)).resolves.toBeUndefined()
        expect(stream.writableLength).toBe(0)

        await new Promise<void>((resolve) => stream.end(resolve))
    })
})

describe('exit code survives WebdriverIO exit hooks', () => {
    const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url))

    it('exit-hook still discards process.exitCode, which is why exitWith exists', async () => {
        // Guards the premise. WebdriverIO's launcher registers exit-hook unconditionally,
        // and this version replaces the exit path so that setting process.exitCode alone
        // exits 0. If a future version fixes this, the assertion tells us the workaround
        // can be reconsidered rather than silently becoming dead weight.
        expect(await runNode(path.join(fixtures, 'exitCodeOnly.mjs'))).toBe(0)
    })

    it('reports a failing run through exitWith despite the exit hook', async () => {
        expect(await runNode(path.join(fixtures, 'exitWithHook.mjs'))).toBe(1)
    })

    it('still reports success when the run passed', async () => {
        expect(await runNode(path.join(fixtures, 'exitWithHook.mjs'), ['0'])).toBe(0)
    })

    it('does not truncate piped output on the way out', async () => {
        const lines = 20000
        const { code, stdout } = await runNodeCapturingStdout(
            path.join(fixtures, 'exitWithOutput.mjs'),
            [String(lines)]
        )

        // Exiting without draining loses whatever is still buffered, which in a real run
        // is the summary the reporter printed immediately beforehand.
        expect(stdout.split('\n').filter(Boolean)).toHaveLength(lines)
        expect(code).toBe(1)
    }, 60000)
})
