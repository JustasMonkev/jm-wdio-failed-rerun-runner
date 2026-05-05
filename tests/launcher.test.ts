import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { createWdioRun, loadWdioLauncher } from '#src/launcher'

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

        await expect(run('/repo/wdio.conf.ts', {
            spec: ['/repo/spec.e2e.ts']
        })).resolves.toBe(17)
        expect(calls).toEqual([
            {
                configPath: '/repo/wdio.conf.ts',
                args: {
                    spec: ['/repo/spec.e2e.ts']
                }
            }
        ])
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
})
