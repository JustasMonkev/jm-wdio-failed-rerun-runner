import { afterEach, describe, expect, it, vi } from 'vitest'

import { main } from '../src/cli.js'
import type { AuditResult } from '../src/index.js'
import { createFixtureProject, pkgJson } from './helpers.js'

describe('cli', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('prints the AuditResult as JSON and exits 0 on pass', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({ e2e: 'wdio run ./wdio.conf.ts' }),
            'wdio.conf.ts': 'export const config = { specs: ["./specs/*.e2e.ts"] }',
            'specs/a.e2e.ts': '',
        })
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            const code = await main(['--cwd', dir])
            expect(code).toBe(0)
            const output = log.mock.calls.at(-1)?.[0] as string
            const result = JSON.parse(output) as AuditResult
            expect(result.status).toBe('pass')
            expect(result.resolvedTestFiles).toHaveLength(1)
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('exits 1 on a failing audit', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({}),
            'wdio.conf.ts': 'export const config = { specs: ["./gone/*.e2e.ts"] }',
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            const code = await main(['--cwd', dir])
            expect(code).toBe(1)
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('supports --no-fail-orphans', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'package.json': pkgJson({}),
            'wdio.conf.ts': 'export const config = { specs: ["./specs/*.e2e.ts"] }',
            'specs/a.e2e.ts': '',
            'stray.spec.ts': '',
        })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            expect(await main(['--cwd', dir])).toBe(1)
            expect(await main(['--cwd', dir, '--no-fail-orphans'])).toBe(0)
        } finally {
            await cleanup()
        }
    }, 30_000)

    it('rejects unknown options', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(await main(['--bogus'])).toBe(2)
    })

    it('prints help', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        expect(await main(['--help'])).toBe(0)
        expect(log.mock.calls[0]?.[0]).toContain('wdio-config-auditor')
    })
})
