import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { discoverWdioScripts, extractWdioConfigArg } from '../src/packageScripts.js'
import { createFixtureProject } from './helpers.js'

describe('extractWdioConfigArg', () => {
    it('returns undefined for commands that do not invoke wdio', () => {
        expect(extractWdioConfigArg('vitest run')).toBeUndefined()
        expect(extractWdioConfigArg('tsc -p tsconfig.json')).toBeUndefined()
        expect(extractWdioConfigArg('npm run build')).toBeUndefined()
    })

    it('does not treat wdio-prefixed package names as the runner', () => {
        expect(extractWdioConfigArg('wdio-config-auditor --cwd .')).toBeUndefined()
        expect(extractWdioConfigArg('npx wdio-failed-rerun-runner')).toBeUndefined()
    })

    it('extracts the config from a plain invocation', () => {
        expect(extractWdioConfigArg('wdio wdio.conf.ts')).toBe('wdio.conf.ts')
        expect(extractWdioConfigArg('wdio ./configs/wdio.conf.js')).toBe('./configs/wdio.conf.js')
    })

    it('supports the `run` subcommand and runner prefixes', () => {
        expect(extractWdioConfigArg('wdio run ./wdio.conf.ts')).toBe('./wdio.conf.ts')
        expect(extractWdioConfigArg('npx wdio run wdio.conf.mts')).toBe('wdio.conf.mts')
        expect(extractWdioConfigArg('yarn wdio run ./e2e/wdio.conf.cjs')).toBe('./e2e/wdio.conf.cjs')
    })

    it('returns null when wdio runs with the default config', () => {
        expect(extractWdioConfigArg('wdio run')).toBeNull()
        expect(extractWdioConfigArg('wdio')).toBeNull()
    })

    it('skips flags and their values', () => {
        expect(extractWdioConfigArg('wdio run --watch ./wdio.conf.ts')).toBe('./wdio.conf.ts')
        expect(extractWdioConfigArg('wdio run --suite smoke wdio.conf.ts')).toBe('wdio.conf.ts')
        expect(extractWdioConfigArg('wdio run --logLevel=debug wdio.conf.ts')).toBe('wdio.conf.ts')
    })

    it('inspects each part of compound commands', () => {
        expect(extractWdioConfigArg('npm run build && wdio run ./wdio.conf.ts')).toBe('./wdio.conf.ts')
        expect(extractWdioConfigArg('wdio run a.conf.ts; echo done')).toBe('a.conf.ts')
    })

    it('strips quotes around the config path', () => {
        expect(extractWdioConfigArg('wdio run "./wdio.conf.ts"')).toBe('./wdio.conf.ts')
    })
})

describe('discoverWdioScripts', () => {
    it('resolves existing config references and flags missing ones', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'wdio.conf.ts': 'export const config = {}',
        })
        try {
            const scripts = discoverWdioScripts(
                {
                    scripts: {
                        'test:e2e': 'wdio run ./wdio.conf.ts',
                        'test:missing': 'wdio run ./nope.conf.ts',
                        build: 'tsc',
                    },
                },
                dir
            )
            expect(scripts).toHaveLength(2)
            const existing = scripts.find((script) => script.name === 'test:e2e')
            expect(existing?.configPath).toBe(path.join(dir, 'wdio.conf.ts'))
            expect(existing?.configArg).toBe('./wdio.conf.ts')
            const missing = scripts.find((script) => script.name === 'test:missing')
            expect(missing?.configPath).toBeNull()
            expect(missing?.configArg).toBe('./nope.conf.ts')
        } finally {
            await cleanup()
        }
    })
})
