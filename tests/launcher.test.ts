import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { ConfigParser } from '@wdio/config/node'

import { FailedRerunUsageError } from '#src/errors'
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

    // Two module registries cache a config: the ESM one by URL, the CommonJS one by
    // filename. A query defeats only the first, so each of these shapes has to be covered.
    it.each([
        ['an ES module config', 'module', 'wdio.conf.mjs', false],
        ['a CommonJS config', undefined, 'wdio.conf.js', true],
        ['an explicitly CommonJS config', 'module', 'wdio.conf.cjs', true],
        ['a TypeScript config compiled to CommonJS', undefined, 'wdio.conf.ts', false]
    ])('re-evaluates %s that reads the rerun environment on every attempt', async (_label, type, configName, commonjs) => {
        // Every attempt runs in one process, so this has to load both wrappers in one
        // process too. Spawning a fresh Node per attempt would clear the module registry
        // and pass whether or not the base import is cache-busted.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-cache-'))
        const configPath = path.join(workspace, configName)

        await fs.writeFile(path.join(workspace, 'package.json'),
            JSON.stringify({ name: 'p', private: true, ...(type ? { type } : {}) }))
        await fs.writeFile(configPath, commonjs
            ? 'exports.config = { retryAttempt: process.env.WDIO_FAILED_RERUN_RETRY }\n'
            : 'export const config = { retryAttempt: process.env.WDIO_FAILED_RERUN_RETRY }\n')

        const wrappers: string[] = []

        class CapturingLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                // Keep each attempt's generated wrapper: the runner deletes it, and both
                // are needed alive at once to replay them in a single process.
                const kept = path.join(workspace, `kept-${wrappers.length}${path.extname(this.configPath)}`)
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
                '--import', pathToFileURL(require.resolve('tsx')).href,
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

    // Like the cache test, these have to replay both attempts in ONE process: a fresh Node
    // per attempt caches nothing, so the assertion would hold whether or not anything is
    // purged.
    async function captureWrappers(configPath: string, workspace: string) {
        const wrappers: string[] = []

        class CapturingLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                const kept = path.join(workspace, `kept-${wrappers.length}${path.extname(this.configPath)}`)
                await fs.copyFile(this.configPath, kept)
                wrappers.push(kept)
                return 0
            }
        }

        const run = createWdioRun(async () => ({ Launcher: CapturingLauncher }))
        const args = { services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]] }
        await run(configPath, args as never)
        await run(configPath, args as never)

        const { stdout } = await promisify(execFile)(process.execPath, [
            '--import', pathToFileURL(require.resolve('tsx')).href,
            '--input-type=module',
            '-e',
            `const { pathToFileURL } = await import('node:url')
             const seen = []
             for (const [index, wrapper] of process.argv.slice(1).entries()) {
                 process.env.WDIO_FAILED_RERUN_RETRY = String(index)
                 const m = await import(pathToFileURL(wrapper).href)
                 seen.push(m.config.retryAttempt ?? m.config.loadedAt ?? null)
             }
             process.stdout.write(JSON.stringify(seen))`,
            ...wrappers
        ])

        return JSON.parse(stdout) as unknown[]
    }

    it.each([
        ['a CommonJS helper', undefined, 'wdio.conf.js', 'helper.js', true],
        ['a TypeScript helper compiled to CommonJS', undefined, 'wdio.conf.ts', 'helper.ts', false]
    ])('re-evaluates %s the config imports', async (_label, type, configName, helperName, commonjs) => {
        // Dropping the config's own cache entry is not enough - a helper it imports holds
        // its own module-scope reading of the environment.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-trans-'))
        const configPath = path.join(workspace, configName)

        await fs.writeFile(path.join(workspace, 'package.json'),
            JSON.stringify({ name: 'p', private: true, ...(type ? { type } : {}) }))
        await fs.writeFile(path.join(workspace, helperName), commonjs
            ? 'exports.retryAttempt = process.env.WDIO_FAILED_RERUN_RETRY\n'
            : 'export const retryAttempt = process.env.WDIO_FAILED_RERUN_RETRY\n')
        await fs.writeFile(configPath, commonjs
            ? `const h = require('./${helperName}')\nexports.config = { retryAttempt: h.retryAttempt }\n`
            : `import { retryAttempt } from './helper'\nexport const config = { retryAttempt }\n`)

        try {
            expect(await captureWrappers(configPath, workspace)).toEqual(['0', '1'])
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('leaves third-party modules cached so their singletons survive', async () => {
        // Re-evaluating node_modules would hand out fresh instances of modules WebdriverIO
        // itself holds references to, and they do not read the rerun environment anyway.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-nm-'))
        const packageDirectory = path.join(workspace, 'node_modules', 'pkg')
        await fs.mkdir(packageDirectory, { recursive: true })
        await fs.writeFile(path.join(workspace, 'package.json'), JSON.stringify({ name: 'p', private: true }))
        await fs.writeFile(path.join(packageDirectory, 'package.json'),
            JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }))
        await fs.writeFile(path.join(packageDirectory, 'index.js'),
            'module.exports = { loadedAt: process.env.WDIO_FAILED_RERUN_RETRY }\n')

        const configPath = path.join(workspace, 'wdio.conf.js')
        await fs.writeFile(configPath,
            "const pkg = require('pkg')\nexports.config = { loadedAt: pkg.loadedAt }\n")

        try {
            // The config reloaded on the second attempt, but the package it required did not.
            expect(await captureWrappers(configPath, workspace)).toEqual(['0', '0'])
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

    it('pins the config directory as rootDir so a relocated wrapper still finds the specs', async () => {
        // WebdriverIO derives rootDir from the config file it is handed, and resolves
        // relative `specs` against it. A wrapper written anywhere but beside the config
        // would therefore match nothing - and for a rerun tool, zero specs reads as
        // "everything passed" rather than as an error. Checked against the real parser.
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-root-'))
        const project = path.join(workspace, 'project')
        await fs.mkdir(path.join(project, 'test', 'specs'), { recursive: true })
        await fs.writeFile(path.join(project, 'test', 'specs', 'a.e2e.js'), '')
        await fs.writeFile(path.join(project, 'test', 'specs', 'b.e2e.js'), '')

        const configPath = path.join(project, 'wdio.conf.mjs')
        await fs.writeFile(configPath, `export const config = {
    specs: ['./test/specs/**/*.js'],
    capabilities: [{ browserName: 'chrome' }]
}
`)

        let resolved: number | undefined

        class ParsingLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                // Move the generated wrapper away from the config before parsing it, which
                // is exactly what the read-only fallback does.
                const moved = path.join(workspace, path.basename(this.configPath))
                await fs.copyFile(this.configPath, moved)

                const parser = new ConfigParser(moved)
                await parser.initialize({})
                resolved = parser.getSpecs().length
                return 0
            }
        }

        try {
            await expect(createWdioRun(async () => ({ Launcher: ParsingLauncher }))(configPath, {
                services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
            })).resolves.toBe(0)

            expect(resolved).toBe(2)
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    // Making a directory unwritable takes different tools depending on who is running:
    // mode bits are enough for an ordinary user, but root ignores them and needs a
    // genuinely read-only filesystem.
    async function makeUnwritable(directory: string) {
        await fs.chmod(directory, 0o555)
        if (!await canWrite(directory)) {
            return async () => { await fs.chmod(directory, 0o755) }
        }

        try {
            await promisify(execFile)('mount', ['-t', 'tmpfs', '-o', 'size=1m', 'tmpfs', directory])
        } catch {
            return undefined
        }

        return async () => {
            await promisify(execFile)('mount', ['-o', 'remount,rw', directory]).catch(() => {})
            await promisify(execFile)('umount', [directory]).catch(() => {})
            await fs.chmod(directory, 0o755).catch(() => {})
        }
    }

    async function canWrite(directory: string) {
        const probe = path.join(directory, '.probe')
        try {
            await fs.writeFile(probe, '')
            await fs.rm(probe, { force: true })
            return true
        } catch {
            return false
        }
    }

    it('falls back to a temporary directory when the config directory cannot be written', async (context) => {
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-ro-'))
        const project = path.join(workspace, 'project')
        await fs.mkdir(project)

        const restore = await makeUnwritable(project)
        if (!restore) {
            await fs.rm(workspace, { recursive: true, force: true })
            context.skip('cannot make a directory unwritable in this environment')
            return
        }

        let wrapperPath: string | undefined

        class RecordingLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                wrapperPath = this.configPath
                return 0
            }
        }

        try {
            // A tmpfs mount hides whatever was there, so the config is written through the
            // same mechanism that made the directory unwritable, then sealed.
            if (!await canWrite(project)) {
                await fs.writeFile(path.join(project, 'wdio.conf.mjs'), 'export const config = {}\n')
            } else {
                await promisify(execFile)('mount', ['-o', 'remount,rw', project])
                await fs.writeFile(path.join(project, 'wdio.conf.mjs'), 'export const config = {}\n')
                await promisify(execFile)('mount', ['-o', 'remount,ro', project])
            }

            expect(await canWrite(project)).toBe(false)

            await expect(createWdioRun(async () => ({ Launcher: RecordingLauncher }))(
                path.join(project, 'wdio.conf.mjs'),
                { services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]] }
            )).resolves.toBe(0)

            expect(path.dirname(wrapperPath as string)).not.toBe(project)
            // The fallback directory is ours, so it goes with the wrapper. One left behind
            // per run would accumulate for as long as the project is deployed read-only.
            await expect(fs.access(path.dirname(wrapperPath as string))).rejects.toMatchObject({
                code: 'ENOENT'
            })
        } finally {
            await restore()
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    it('surfaces a write failure that is not about permissions', async () => {
        // The fallback exists for a config directory that cannot be written to at all. Any
        // other write failure is a real problem, and quietly relocating would hide it - so
        // this uses a path long enough that the wrapper name overflows PATH_MAX while the
        // shorter config name still fits.
        let directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-long-'))
        while (directory.length < 4000) {
            const next = path.join(directory, 'd'.repeat(200))
            try {
                await fs.mkdir(next)
            } catch {
                break
            }
            directory = next
        }

        const configPath = path.join(directory, 'wdio.conf.mjs')
        await fs.writeFile(configPath, 'export const config = {}\n')

        class UnusedLauncher {
            constructor(public readonly configPath: string, public readonly args: unknown) {}

            async run() {
                return 0
            }
        }

        await expect(createWdioRun(async () => ({ Launcher: UnusedLauncher }))(configPath, {
            services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
        })).rejects.toMatchObject({ code: 'ENAMETOOLONG' })
    })

    it('keeps a rootDir the config sets for itself', async () => {
        const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-ownroot-'))
        const configPath = path.join(workspace, 'wdio.conf.mjs')
        const chosen = path.join(workspace, 'elsewhere')

        await fs.mkdir(chosen)
        await fs.writeFile(configPath, `export const config = { rootDir: ${JSON.stringify(chosen)} }\n`)

        let loaded: { rootDir?: string } | undefined

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

            expect(loaded?.rootDir).toBe(chosen)
        } finally {
            await fs.rm(workspace, { recursive: true, force: true })
        }
    })

    describe('services that cannot be injected', () => {
        class CustomService {
            onPrepare() {}
        }

        async function inject(services: unknown[]) {
            const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-svc-'))
            const configPath = path.join(workspace, 'wdio.conf.mjs')
            await fs.writeFile(configPath, 'export const config = {}\n')

            class FakeLauncher {
                constructor(public readonly configPath: string, public readonly args: unknown) {}

                async run() {
                    return 0
                }
            }

            try {
                return await createWdioRun(async () => ({ Launcher: FakeLauncher }))(
                    configPath,
                    { services } as never
                )
            } finally {
                await fs.rm(workspace, { recursive: true, force: true })
            }
        }

        // WebdriverIO hands every worker the generated config's path, not the loaded
        // object, so an injected service has to survive being written to a file. Saying so
        // - and naming the entry - beats a bare "not serializable".
        it.each([
            ['a service class', [CustomService], 'it is a service class (CustomService)'],
            ['a service instance', [new CustomService()], 'it is a service instance'],
            ['a tuple with a function option', [['custom', { onReady: () => {} }]], "the options for 'custom' are not JSON-serializable"]
        ])('explains what to do instead when given %s', async (_label, services, reason) => {
            const failure = inject(services)

            await expect(failure).rejects.toThrow(reason)
            await expect(failure).rejects.toThrow("config's own `services` array")
            await expect(failure).rejects.toBeInstanceOf(FailedRerunUsageError)
        })

        it('names the offending entry rather than the first one', async () => {
            await expect(inject([['fine', { key: 'value' }], CustomService]))
                .rejects.toThrow('Service entry 1')
        })

        it('injects service entries that are JSON-serializable', async () => {
            await expect(inject([['custom', { key: 'value' }]])).resolves.toBe(0)
        })

        it('leaves a class declared in the config alone, which is the supported route', async () => {
            const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-launcher-svc2-'))
            const configPath = path.join(workspace, 'wdio.conf.mjs')
            await fs.writeFile(path.join(workspace, 'package.json'),
                JSON.stringify({ name: 'p', private: true, type: 'module' }))
            await fs.writeFile(configPath, `export class Declared { onPrepare() {} }
export const config = { services: [Declared, ['custom', { onReady: () => 'live' }]] }
`)

            let kinds: string[] | undefined

            class LoadingLauncher {
                constructor(public readonly configPath: string, public readonly args: unknown) {}

                async run() {
                    // Load it by path, the way a worker process does.
                    const { stdout } = await promisify(execFile)(process.execPath, [
                        '--input-type=module',
                        '-e',
                        `const { pathToFileURL } = await import('node:url')
                         const m = await import(pathToFileURL(process.argv[1]).href)
                         process.stdout.write(JSON.stringify(m.config.services.map((s) =>
                             typeof s === 'function' ? 'class ' + s.name
                                 : Array.isArray(s) ? 'tuple ' + s[0] + ':' + typeof s[1].onReady
                                 : typeof s)))`,
                        this.configPath
                    ])
                    kinds = JSON.parse(stdout) as string[]
                    return 0
                }
            }

            try {
                await expect(createWdioRun(async () => ({ Launcher: LoadingLauncher }))(configPath, {
                    services: [['@wdio/failed-rerun-runner', { attempt: 'initial' }]]
                })).resolves.toBe(0)

                expect(kinds).toEqual([
                    'class Declared',
                    'tuple custom:function',
                    'tuple @wdio/failed-rerun-runner:undefined'
                ])
            } finally {
                await fs.rm(workspace, { recursive: true, force: true })
            }
        })
    })

    it('reports a missing config as a usage error, not a wrapper-file stack trace', async () => {
        const { runWdio } = await import('#src/launcher')
        const missing = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-missing-')), 'wdio.conf.ts')

        // Without a pre-flight check this surfaces as ERR_MODULE_NOT_FOUND naming an
        // internal `.wdio-failed-rerun-*` temp file the user never created.
        await expect(runWdio(missing, {})).rejects.toThrow(`WebdriverIO config not found: ${missing}`)
    })
})
