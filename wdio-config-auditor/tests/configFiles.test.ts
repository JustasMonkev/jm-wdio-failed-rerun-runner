import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    discoverConfigsByConvention,
    extractRelativeSpecifiers,
    findImportedConfigFiles,
    loadConfigs,
} from '../src/configFiles.js'
import { DEFAULT_IGNORE_PATTERNS } from '../src/orphans.js'
import { createFixtureProject } from './helpers.js'

const IGNORE = [...DEFAULT_IGNORE_PATTERNS]

describe('discoverConfigsByConvention', () => {
    it('finds wdio config files in any directory, skipping ignored ones', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'wdio.conf.ts': 'export const config = {}',
            'configs/wdio.ios.conf.js': 'export const config = {}',
            'node_modules/pkg/wdio.conf.js': 'export const config = {}',
            'src/index.ts': '',
        })
        try {
            const found = await discoverConfigsByConvention(dir, IGNORE)
            expect(found).toEqual([
                path.join(dir, 'configs/wdio.ios.conf.js'),
                path.join(dir, 'wdio.conf.ts'),
            ])
        } finally {
            await cleanup()
        }
    })
})

describe('extractRelativeSpecifiers', () => {
    it('extracts static imports, re-exports, require and dynamic imports', () => {
        const source = `
            import { config as base } from './wdio.shared.conf.js'
            import './side-effect.js'
            export { config } from "../base/wdio.base.conf"
            const a = require('./legacy.conf.cjs')
            const b = await import('./dynamic.conf.mjs')
            import notRelative from 'webdriverio'
        `
        expect(extractRelativeSpecifiers(source).sort()).toEqual([
            '../base/wdio.base.conf',
            './dynamic.conf.mjs',
            './legacy.conf.cjs',
            './side-effect.js',
            './wdio.shared.conf.js',
        ])
    })
})

describe('findImportedConfigFiles', () => {
    it('follows relative imports that export a config, resolving TS-style .js specifiers', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'wdio.conf.ts': `
                import { config as base } from './wdio.shared.conf.js'
                import { helper } from './utils/helper.js'
                export const config = { ...base, specs: helper([]) }
            `,
            'wdio.shared.conf.ts': 'export const config = { specs: [] }',
            'utils/helper.ts': 'export const helper = (x: unknown) => x',
        })
        try {
            const found = await findImportedConfigFiles(path.join(dir, 'wdio.conf.ts'), dir)
            expect(found).toEqual([path.join(dir, 'wdio.shared.conf.ts')])
        } finally {
            await cleanup()
        }
    })
})

describe('loadConfigs', () => {
    it('loads TypeScript and JavaScript configs and follows merged base configs', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'wdio.conf.ts': `
                import { config as base } from './base/wdio.shared.conf.js'
                export const config = { ...base, specs: ['./specs/**/*.e2e.ts'] }
            `,
            'base/wdio.shared.conf.ts': `
                export const config = { suites: { smoke: ['./smoke/*.e2e.ts'] } }
            `,
            'wdio.legacy.conf.js': 'export const config = { specs: ["./legacy/*.e2e.js"] }',
        })
        try {
            const entries = new Map([
                [path.join(dir, 'wdio.conf.ts'), 'script' as const],
                [path.join(dir, 'wdio.legacy.conf.js'), 'convention' as const],
            ])
            const loaded = await loadConfigs(entries, dir)
            expect(loaded).toHaveLength(3)

            const main = loaded.find((entry) => entry.info.path === path.join(dir, 'wdio.conf.ts'))
            expect(main?.info.loaded).toBe(true)
            expect(main?.config?.specs).toEqual(['./specs/**/*.e2e.ts'])
            // merged content from the base config is visible on the main config
            expect(main?.config?.suites).toEqual({ smoke: ['./smoke/*.e2e.ts'] })

            const base = loaded.find(
                (entry) => entry.info.path === path.join(dir, 'base/wdio.shared.conf.ts')
            )
            expect(base?.info.discoveredVia).toBe('import')
            expect(base?.info.loaded).toBe(true)

            const legacy = loaded.find(
                (entry) => entry.info.path === path.join(dir, 'wdio.legacy.conf.js')
            )
            expect(legacy?.info.loaded).toBe(true)
            expect(legacy?.config?.specs).toEqual(['./legacy/*.e2e.js'])
        } finally {
            await cleanup()
        }
    })

    it('records a load error for configs that throw', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'wdio.conf.ts': 'throw new Error("boom")',
        })
        try {
            const entries = new Map([[path.join(dir, 'wdio.conf.ts'), 'script' as const]])
            const [loaded] = await loadConfigs(entries, dir)
            expect(loaded?.info.loaded).toBe(false)
            expect(loaded?.info.loadError).toContain('boom')
        } finally {
            await cleanup()
        }
    })

    it('records an error for modules without a config export', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'wdio.conf.ts': 'export const somethingElse = 1',
        })
        try {
            const entries = new Map([[path.join(dir, 'wdio.conf.ts'), 'script' as const]])
            const [loaded] = await loadConfigs(entries, dir)
            expect(loaded?.info.loaded).toBe(false)
            expect(loaded?.info.loadError).toMatch(/config/)
        } finally {
            await cleanup()
        }
    })

    it('records missing files', async () => {
        const { dir, cleanup } = await createFixtureProject({})
        try {
            const entries = new Map([[path.join(dir, 'wdio.conf.ts'), 'explicit' as const]])
            const [loaded] = await loadConfigs(entries, dir)
            expect(loaded?.info.loaded).toBe(false)
            expect(loaded?.info.loadError).toBe('File does not exist')
        } finally {
            await cleanup()
        }
    })
})
