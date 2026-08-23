import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { createWdioRun, loadWdioLauncher } from '#src/launcher'

const require = createRequire(import.meta.url)

describe('WDIO launcher adapter', () => {
    it('loads the real @wdio/cli Launcher export', async () => {
        await expect(loadWdioLauncher()).resolves.toEqual(expect.any(Function))
    })

    it('constructs and runs the loaded Launcher', async () => {
        const calls: Array<{
            configPath: string
            args: unknown
        }> = []

        class FakeLauncher {
            constructor(configPath: string, args: unknown) {
                calls.push({ configPath, args })
            }

            async run() {
                return 17
            }
        }

        const run = createWdioRun(async () => ({
            Launcher: FakeLauncher
        }))
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-'))
        const configPath = path.join(workspace, 'wdio.conf.ts')
        await fs.writeFile(configPath, 'export const config = {}\n')

        try {
            await expect(run(configPath, {
                spec: ['/repo/spec.e2e.ts']
            })).resolves.toBe(17)
            expect(calls).toEqual([
                {
                    configPath,
                    args: {
                        spec: ['/repo/spec.e2e.ts']
                    }
                }
            ])
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('appends launcher-arg services through a wrapper config', async () => {
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-wrapper-'))
        const configPath = path.join(workspace, 'wdio.conf.mjs')
        const calls: Array<{
            configPath: string
            args: unknown
            config: string
        }> = []

        await fs.writeFile(configPath, `export const config = {
    services: [['appium', { command: 'appium' }]],
    specs: ['./test/specs/**/*.js']
}
`)

        class FakeLauncher {
            constructor(
                public readonly configPath: string,
                public readonly args: unknown
            ) {}

            async run() {
                calls.push({
                    configPath: this.configPath,
                    args: this.args,
                    config: await fs.readFile(this.configPath, 'utf8')
                })
                return 0
            }
        }

        const run = createWdioRun(async () => ({
            Launcher: FakeLauncher
        }))

        await expect(run(configPath, {
            spec: ['/repo/spec.e2e.ts'],
            services: [['@wdio/failed-rerun-runner', {
                manifestPath: '/tmp/failed.ndjson',
                attempt: 'initial'
            }]]
        })).resolves.toBe(0)

        expect(calls).toHaveLength(1)
        expect(calls[0].configPath).not.toBe(configPath)
        expect(calls[0].args).toEqual({
            spec: ['/repo/spec.e2e.ts']
        })
        expect(calls[0].config).toContain("baseConfig.services || []")
        expect(calls[0].config).toContain('@wdio/failed-rerun-runner')
        await expect(fs.access(calls[0].configPath)).rejects.toMatchObject({
            code: 'ENOENT'
        })

        await fs.rm(workspace, { recursive: true, force: true })
    })

    // A config name is a filesystem path, but the wrapper reaches it through an import
    // specifier, which is a URL. Every character below means something in a URL and nothing
    // in a path, and each one used to import a different module - or none at all.
    it.each([
        ['a plain name', 'wdio.conf.mjs'],
        ['a fragment character', 'wdio#prod.conf.mjs'],
        ['a query character', 'wdio?v=1.conf.mjs'],
        ['a percent escape', 'wdio%20test.conf.mjs'],
        ['a space', 'wdio staging.conf.mjs']
    ])('loads the real config through the wrapper given %s', async (_label, configName) => {
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-url-'))
        const configPath = path.join(workspace, configName)

        await fs.writeFile(configPath, `export const config = {
    services: [['appium', { command: 'appium' }]],
    specs: ['./from-the-real-config.js']
}
`)

        // The wrapper has to be imported by Node itself. Asserting on its text would pass
        // just as happily against a specifier resolving to the wrong module, and importing
        // it from inside Vitest measures Vite's resolver rather than the ESM URL semantics
        // this is about.
        let loaded: { services?: unknown[], specs?: unknown[] } | undefined

        class FakeLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                const { stdout } = await promisify(execFile)(process.execPath, [
                    '--input-type=module',
                    '-e',
                    `const { pathToFileURL } = await import('node:url')
                     const m = await import(pathToFileURL(process.argv[1]).href)
                     process.stdout.write(JSON.stringify(m.config))`,
                    this.configPath
                ])
                loaded = JSON.parse(stdout) as typeof loaded
                return 0
            }
        }

        const run = createWdioRun(async () => ({ Launcher: FakeLauncher }))

        try {
            await expect(run(configPath, {
                services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
            })).resolves.toBe(0)

            // The user's own config survived intact, and the injected service was appended
            // rather than replacing the tuple-form service already configured.
            expect(loaded?.specs).toEqual(['./from-the-real-config.js'])
            expect(loaded?.services).toEqual([
                ['appium', { command: 'appium' }],
                ['@wdio/failed-rerun-runner', { attempt: 'initial' }]
            ])
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('loads the real config when the directory name is URL-significant', async () => {
        // A branch-named worktree like `feature#123` puts the character in the directory
        // rather than the filename, which the basename cases above would never reach.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-dir-'))
        const configDirectory = path.join(workspace, 'feature#123')
        await fs.mkdir(configDirectory)
        const configPath = path.join(configDirectory, 'wdio.conf.mjs')

        await fs.writeFile(configPath, 'export const config = { specs: [\'./from-the-real-config.js\'] }\n')

        let loaded: { specs?: unknown[] } | undefined

        class FakeLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                const { stdout } = await promisify(execFile)(process.execPath, [
                    '--input-type=module',
                    '-e',
                    `const { pathToFileURL } = await import('node:url')
                     const m = await import(pathToFileURL(process.argv[1]).href)
                     process.stdout.write(JSON.stringify(m.config))`,
                    this.configPath
                ])
                loaded = JSON.parse(stdout) as typeof loaded
                return 0
            }
        }

        try {
            await expect(createWdioRun(async () => ({ Launcher: FakeLauncher }))(configPath, {
                services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
            })).resolves.toBe(0)

            expect(loaded?.specs).toEqual(['./from-the-real-config.js'])
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    // Both of these need Node to load the wrapper, so they run it in a real process for
    // the same reason as the cases above.
    async function loadThroughWrapper(configPath: string, extraEnv: NodeJS.ProcessEnv = {}) {
        let loaded: { retryAttempt?: unknown, specs?: unknown[] } | undefined

        class FakeLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                const { stdout } = await promisify(execFile)(process.execPath, [
                    '--import', pathToFileURL(require.resolve('tsx')).href,
                    '--input-type=module',
                    '-e',
                    `const { pathToFileURL } = await import('node:url')
                     const m = await import(pathToFileURL(process.argv[1]).href)
                     process.stdout.write(JSON.stringify(m.config))`,
                    this.configPath
                ], { env: { ...process.env, ...extraEnv } })
                loaded = JSON.parse(stdout) as typeof loaded
                return 0
            }
        }

        await expect(createWdioRun(async () => ({ Launcher: FakeLauncher }))(configPath, {
            services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
        })).resolves.toBe(0)

        return loaded
    }

    it('loads a TypeScript config from a project that is not an ES module', async () => {
        // Without `"type": "module"` a `.ts` wrapper compiles to CommonJS, where the
        // wrapper's top-level await is a syntax error. Service injection always writes a
        // wrapper, so this shape has to work.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-cjs-'))
        const configPath = path.join(workspace, 'wdio.conf.ts')

        await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'p', private: true }))
        await fs.writeFile(configPath, 'export const config = { specs: [\'./from-the-real-config.js\'] }\n')

        try {
            expect((await loadThroughWrapper(configPath))?.specs).toEqual(['./from-the-real-config.js'])
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('re-evaluates a config that reads the rerun environment on every attempt', async () => {
        // Every attempt runs in one process, so this has to load both wrappers in one
        // process too. Spawning a fresh Node per attempt would clear the module registry
        // and pass whether or not the base import is cache-busted.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-cache-'))
        const configPath = path.join(workspace, 'wdio.conf.mjs')

        await fs.writeFile(path.join(workspace, 'package.json'),
            JSON.stringify({ name: 'p', private: true, type: 'module' }))
        await fs.writeFile(configPath,
            'export const config = { retryAttempt: process.env.WDIO_FAILED_RERUN_RETRY }\n')

        const wrappers: string[] = []

        class CapturingLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                // Keep each attempt's generated wrapper: the runner deletes it, and both
                // are needed alive at once to replay them in a single process.
                const kept = path.join(workspace, `kept-${wrappers.length}.mjs`)
                await fs.copyFile(this.configPath, kept)
                wrappers.push(kept)
                return 0
            }
        }

        try {
            const run = createWdioRun(async () => ({ Launcher: CapturingLauncher }))
            const args = { services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]] }

            await run(configPath, args as never)
            await run(configPath, args as never)

            const { stdout } = await promisify(execFile)(process.execPath, [
                '--input-type=module',
                '-e',
                `const { pathToFileURL } = await import('node:url')
                 const seen = []
                 for (const [index, wrapper] of process.argv.slice(1).entries()) {
                     process.env.WDIO_FAILED_RERUN_RETRY = String(index)
                     const m = await import(pathToFileURL(wrapper).href)
                     seen.push(m.config.retryAttempt)
                 }
                 process.stdout.write(JSON.stringify(seen))`,
                ...wrappers
            ])

            // Attempt 0 saw RETRY=0 and attempt 1 saw RETRY=1. A cached base config would
            // report '0' twice.
            expect(JSON.parse(stdout)).toEqual(['0', '1'])
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('hands WebdriverIO a wrapper it will register its TypeScript loader for', async () => {
        // WebdriverIO decides whether to load tsx by the config path's suffix
        // (`TS_FILE_EXTENSIONS.some((ext) => this._configFilePath.endsWith(ext))`), so a
        // `.mjs` wrapper for a TypeScript config would leave the base config untransformable
        // in the launcher process. `.mts` keeps that suffix and is always an ES module.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-ts-'))
        const seen: string[] = []

        class RecordingLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                seen.push(path.extname(this.configPath))
                return 0
            }
        }

        try {
            for (const [configName, expected] of [
                ['wdio.conf.ts', '.mts'],
                ['wdio.conf.mts', '.mts'],
                ['wdio.conf.cts', '.mts'],
                ['wdio.conf.mjs', '.mjs'],
                ['wdio.conf.js', '.mjs']
            ]) {
                const configPath = path.join(workspace, configName)
                await fs.writeFile(configPath, 'export const config = {}\n')

                await expect(createWdioRun(async () => ({ Launcher: RecordingLauncher }))(configPath, {
                    services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
                })).resolves.toBe(0)

                expect(seen.pop()).toBe(expected)
            }
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('reports a missing config as a usage error, not a wrapper-file stack trace', async () => {
        const { runWdio } = await import('#src/launcher')
        const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-missing-')), 'wdio.conf.ts')

        // Without a pre-flight check this surfaces as ERR_MODULE_NOT_FOUND naming an
        // internal `.wdio-failed-rerun-*` temp file the user never created.
        await expect(runWdio(missing, {})).rejects.toThrow(`WebdriverIO config not found: ${missing}`)
    })
})
