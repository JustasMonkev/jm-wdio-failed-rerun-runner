import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { audit } from '../src/index.js'
import { createFixtureProject, pkgJson } from './helpers.js'

describe('audit (end to end)', () => {
    it('passes on a healthy project and reports the full structure', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({ 'test:e2e': 'wdio run ./wdio.conf.ts' }),
            'wdio.conf.ts': `
                import { config as shared } from './wdio.shared.conf.js'
                export const config = {
                    ...shared,
                    specs: ['./specs/**/*.e2e.ts'],
                    exclude: ['./specs/wip.e2e.ts'],
                }
            `,
            'wdio.shared.conf.ts': `
                export const config = {
                    suites: { smoke: ['./specs/login.e2e.ts'] },
                }
            `,
            'specs/login.e2e.ts': 'describe("login", () => {})',
            'specs/checkout.e2e.ts': 'describe("checkout", () => {})',
            'specs/wip.e2e.ts': 'describe("wip", () => {})',
        })
        try {
            const result = await audit({ cwd: dir })

            expect(result.errors).toEqual([])
            expect(result.status).toBe('pass')

            expect(result.scripts).toHaveLength(1)
            expect(result.scripts[0]?.name).toBe('test:e2e')
            expect(result.scripts[0]?.configPath).toBe(path.join(dir, 'wdio.conf.ts'))

            const configPaths = result.configFiles.map((info) => info.path).sort()
            expect(configPaths).toEqual([
                path.join(dir, 'wdio.conf.ts'),
                path.join(dir, 'wdio.shared.conf.ts'),
            ])
            expect(result.configFiles.every((info) => info.loaded)).toBe(true)

            // specs: declared in wdio.conf.ts and inherited (merged) suites
            const mainSpecs = result.specs.filter(
                (spec) => spec.configPath === path.join(dir, 'wdio.conf.ts')
            )
            expect(mainSpecs.map((spec) => spec.pattern)).toEqual(['./specs/**/*.e2e.ts'])

            const suiteNames = result.suites.map((suite) => suite.name)
            expect(suiteNames).toContain('smoke')

            // wip.e2e.ts is excluded; login + checkout remain
            expect(result.resolvedTestFiles).toEqual([
                path.join(dir, 'specs/checkout.e2e.ts'),
                path.join(dir, 'specs/login.e2e.ts'),
            ])

            expect(result.brokenGlobs).toEqual([])
            expect(result.missingFiles).toEqual([])
            // wip.e2e.ts is excluded on purpose — referenced, hence not orphaned
            expect(result.orphanedTestFiles).toEqual([])
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('fails and reports broken globs, missing files and orphans', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({ e2e: 'wdio run ./wdio.conf.ts' }),
            'wdio.conf.ts': `
                export const config = {
                    specs: ['./specs/**/*.e2e.ts', './gone/**/*.e2e.ts'],
                    suites: { smoke: ['./specs/deleted.e2e.ts'] },
                }
            `,
            'specs/login.e2e.ts': '',
            'specs/forgotten.spec.ts': '',
        })
        try {
            const result = await audit({ cwd: dir })
            expect(result.status).toBe('fail')

            expect(result.brokenGlobs).toEqual([
                { pattern: './gone/**/*.e2e.ts', configPath: path.join(dir, 'wdio.conf.ts') },
            ])
            expect(result.missingFiles).toEqual([
                {
                    path: path.join(dir, 'specs/deleted.e2e.ts'),
                    pattern: './specs/deleted.e2e.ts',
                    configPath: path.join(dir, 'wdio.conf.ts'),
                    suite: 'smoke',
                },
            ])
            expect(result.orphanedTestFiles).toEqual([path.join(dir, 'specs/forgotten.spec.ts')])
            expect(result.resolvedTestFiles).toEqual([path.join(dir, 'specs/login.e2e.ts')])
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('fails when no config exists and reports script references to missing configs', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({ e2e: 'wdio run ./wdio.conf.ts' }),
        })
        try {
            const result = await audit({ cwd: dir })
            expect(result.status).toBe('fail')
            expect(result.configFiles).toEqual([])
            expect(result.errors.some((message) => message.includes('./wdio.conf.ts'))).toBe(true)
            expect(result.errors.some((message) => message.includes('No WDIO config'))).toBe(true)
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('discovers configs by convention when scripts use the default config', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({ e2e: 'wdio run' }),
            'wdio.conf.js': 'export const config = { specs: ["./tests/*.spec.js"] }',
            'tests/a.spec.js': '',
        })
        try {
            const result = await audit({ cwd: dir })
            expect(result.status).toBe('pass')
            expect(result.configFiles).toHaveLength(1)
            expect(result.configFiles[0]?.path).toBe(path.join(dir, 'wdio.conf.js'))
            expect(result.resolvedTestFiles).toEqual([path.join(dir, 'tests/a.spec.js')])
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('audits only explicit configs when configPaths is given', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({}),
            'wdio.a.conf.ts': 'export const config = { specs: ["./a/*.e2e.ts"] }',
            'wdio.b.conf.ts': 'export const config = { specs: ["./missing/*.e2e.ts"] }',
            'a/one.e2e.ts': '',
        })
        try {
            const result = await audit({ cwd: dir, configPaths: ['wdio.a.conf.ts'] })
            expect(result.configFiles).toHaveLength(1)
            expect(result.configFiles[0]?.discoveredVia).toBe('explicit')
            expect(result.status).toBe('pass')
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('serialises to structured JSON', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({}),
            'wdio.conf.ts': 'export const config = { specs: ["./specs/*.e2e.ts"] }',
            'specs/a.e2e.ts': '',
        })
        try {
            const result = await audit({ cwd: dir })
            const roundTripped: unknown = JSON.parse(JSON.stringify(result))
            expect(roundTripped).toEqual(result)
        } finally {
            await cleanup()
        }
    }, 30_000)
})
