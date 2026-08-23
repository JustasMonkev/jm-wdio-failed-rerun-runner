import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

import { purgeCommonJsCache } from '#src/configCache'

const require = createRequire(import.meta.url)
const tempDirs: string[] = []

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function makeProject(files: Record<string, string>) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-config-cache-'))
    tempDirs.push(dir)

    for (const [name, contents] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
        await fs.writeFile(path.join(dir, name), contents)
    }

    return dir
}

describe('purging the CommonJS cache before an attempt', () => {
    it('drops the entry so the module is evaluated again', async () => {
        const dir = await makeProject({
            'wdio.conf.js': 'exports.config = { seen: process.env.WDIO_TEST_ATTEMPT }\n'
        })
        const entry = path.join(dir, 'wdio.conf.js')

        process.env.WDIO_TEST_ATTEMPT = 'first'
        expect(require(entry).config.seen).toBe('first')

        process.env.WDIO_TEST_ATTEMPT = 'second'
        // Without the purge this still reports 'first'.
        purgeCommonJsCache(entry)

        expect(require(entry).config.seen).toBe('second')
        delete process.env.WDIO_TEST_ATTEMPT
    })

    it('drops helpers the entry requires, not just the entry', async () => {
        const dir = await makeProject({
            'helper.js': 'exports.seen = process.env.WDIO_TEST_ATTEMPT\n',
            'wdio.conf.js': "const h = require('./helper')\nexports.config = { seen: h.seen }\n"
        })
        const entry = path.join(dir, 'wdio.conf.js')

        process.env.WDIO_TEST_ATTEMPT = 'first'
        expect(require(entry).config.seen).toBe('first')

        process.env.WDIO_TEST_ATTEMPT = 'second'
        purgeCommonJsCache(entry)

        expect(require(entry).config.seen).toBe('second')
        delete process.env.WDIO_TEST_ATTEMPT
    })

    it('leaves node_modules cached so third-party singletons survive', async () => {
        const dir = await makeProject({
            'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', version: '1.0.0', main: 'index.js' }),
            'node_modules/pkg/index.js': 'module.exports = { seen: process.env.WDIO_TEST_ATTEMPT }\n',
            'wdio.conf.js': "const pkg = require('pkg')\nexports.config = { seen: pkg.seen }\n"
        })
        const entry = path.join(dir, 'wdio.conf.js')

        process.env.WDIO_TEST_ATTEMPT = 'first'
        expect(require(entry).config.seen).toBe('first')

        process.env.WDIO_TEST_ATTEMPT = 'second'
        const dropped = purgeCommonJsCache(entry)

        // The config is re-evaluated, but it reads the same package instance as before.
        expect(require(entry).config.seen).toBe('first')
        expect([...dropped].some((file) => file.includes('node_modules'))).toBe(false)
        delete process.env.WDIO_TEST_ATTEMPT
    })

    it('terminates on a circular require', async () => {
        // `children` is a genuine graph: a lists b and b lists a, so without a visited set
        // this recurses until the stack gives out - hanging every rerun in a project whose
        // config helpers reference each other.
        //
        // Driven in a real Node process: under Vitest the cycle does not end up in the
        // CommonJS cache the same way, and the check would pass with or without the guard.
        const dir = await makeProject({
            'a.js': "const b = require('./b')\nexports.name = 'a'\nexports.b = b\n",
            'b.js': "const a = require('./a')\nexports.name = 'b'\nexports.a = a\n",
            'wdio.conf.js': "const a = require('./a')\nexports.config = { seen: a.name }\n"
        })
        const entry = path.join(dir, 'wdio.conf.js')
        const modulePath = fileURLToPath(new URL('../build/configCache.js', import.meta.url))

        const { stdout } = await promisify(execFile)(process.execPath, [
            '--input-type=module',
            '-e',
            `const { createRequire } = await import('node:module')
             const { purgeCommonJsCache } = await import(process.argv[1])
             const require = createRequire(process.argv[2])
             require(process.argv[2])

             // Guard the premise: this proves nothing unless the cycle is really present.
             const children = (name) => (require.cache[name]?.children ?? []).map((c) => c.filename)
             const a = process.argv[2].replace('wdio.conf.js', 'a.js')
             const b = process.argv[2].replace('wdio.conf.js', 'b.js')
             if (!children(a).includes(b) || !children(b).includes(a)) {
                 process.stdout.write('NO_CYCLE')
             } else {
                 const dropped = purgeCommonJsCache(process.argv[2])
                 process.stdout.write(JSON.stringify([...dropped].map((f) => f.split('/').pop()).sort()))
             }`,
            pathToFileURL(modulePath).href,
            entry
        ], { timeout: 30_000 })

        expect(JSON.parse(stdout)).toEqual(['a.js', 'b.js', 'wdio.conf.js'])
    })

    it('ignores an entry with no CommonJS cache entry', async () => {
        const dir = await makeProject({ 'wdio.conf.mjs': 'export const config = {}\n' })

        expect([...purgeCommonJsCache(path.join(dir, 'does-not-exist.js'))]).toEqual([])
    })
})
