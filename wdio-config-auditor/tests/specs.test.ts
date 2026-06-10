import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { flattenSpecs, isGlobPattern, resolvePattern } from '../src/specs.js'
import { createFixtureProject } from './helpers.js'

describe('isGlobPattern', () => {
    it('detects glob magic', () => {
        expect(isGlobPattern('./specs/**/*.e2e.ts')).toBe(true)
        expect(isGlobPattern('./specs/login.{ts,js}')).toBe(true)
        expect(isGlobPattern('./specs/login?.ts')).toBe(true)
    })

    it('treats literal paths as non-globs', () => {
        expect(isGlobPattern('./specs/login.e2e.ts')).toBe(false)
        expect(isGlobPattern('specs/checkout.spec.js')).toBe(false)
    })
})

describe('flattenSpecs', () => {
    it('flattens grouped spec entries', () => {
        expect(flattenSpecs(['a.ts', ['b.ts', 'c.ts'], 'd.ts'])).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
    })

    it('handles undefined', () => {
        expect(flattenSpecs(undefined)).toEqual([])
    })
})

describe('resolvePattern', () => {
    it('resolves glob patterns relative to the config directory', async () => {
        const { dir, cleanup } = await createFixtureProject({
            'specs/a.e2e.ts': '',
            'specs/nested/b.e2e.ts': '',
            'specs/c.unit.ts': '',
        })
        try {
            const result = await resolvePattern('./specs/**/*.e2e.ts', dir)
            expect(result.broken).toBe(false)
            expect(result.missing).toBeNull()
            expect(result.files).toEqual([
                path.join(dir, 'specs/a.e2e.ts'),
                path.join(dir, 'specs/nested/b.e2e.ts'),
            ])
        } finally {
            await cleanup()
        }
    })

    it('marks globs with zero matches as broken', async () => {
        const { dir, cleanup } = await createFixtureProject({})
        try {
            const result = await resolvePattern('./specs/**/*.e2e.ts', dir)
            expect(result.broken).toBe(true)
            expect(result.files).toEqual([])
        } finally {
            await cleanup()
        }
    })

    it('resolves existing literal paths', async () => {
        const { dir, cleanup } = await createFixtureProject({ 'specs/login.e2e.ts': '' })
        try {
            const result = await resolvePattern('./specs/login.e2e.ts', dir)
            expect(result.files).toEqual([path.join(dir, 'specs/login.e2e.ts')])
            expect(result.broken).toBe(false)
            expect(result.missing).toBeNull()
        } finally {
            await cleanup()
        }
    })

    it('reports non-existing literal paths as missing', async () => {
        const { dir, cleanup } = await createFixtureProject({})
        try {
            const result = await resolvePattern('./specs/gone.e2e.ts', dir)
            expect(result.missing).toBe(path.join(dir, 'specs/gone.e2e.ts'))
            expect(result.broken).toBe(false)
            expect(result.files).toEqual([])
        } finally {
            await cleanup()
        }
    })
})
