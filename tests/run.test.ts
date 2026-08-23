import { afterEach, describe, expect, it, vi } from 'vitest'

import run, { CliUsageError, parseCliArgs } from '#src/run'

describe('CLI argument parsing', () => {
    it('accepts the run subcommand with focused-rerun options', () => {
        expect(parseCliArgs([
            'run',
            './wdio.conf.ts',
            '--max-reruns',
            '3',
            '--manifest-path=./failed.ndjson',
            '--rerun-manifest-path',
            './rerun.ndjson',
            '--no-pass-on-successful-rerun'
        ])).toEqual({
            configPath: './wdio.conf.ts',
            help: false,
            options: {
                maxReruns: 3,
                manifestPath: './failed.ndjson',
                rerunManifestPath: './rerun.ndjson',
                passOnSuccessfulRerun: false
            }
        })
    })

    it('accepts a direct config path without the run subcommand', () => {
        expect(parseCliArgs([
            './wdio.conf.ts',
            '--pass-on-successful-rerun'
        ])).toEqual({
            configPath: './wdio.conf.ts',
            help: false,
            options: {
                passOnSuccessfulRerun: true
            }
        })
    })

    it('returns help without requiring a config path', () => {
        expect(parseCliArgs(['--help'])).toEqual({
            help: true,
            options: {}
        })
    })

    it('rejects invalid rerun counts', () => {
        expect(() => parseCliArgs(['./wdio.conf.ts', '--max-reruns', '-1']))
            .toThrow(CliUsageError)
        expect(() => parseCliArgs(['./wdio.conf.ts', '--max-reruns=1.5']))
            .toThrow('--max-reruns must be a non-negative integer')
    })

    it('rejects unknown or ambiguous arguments', () => {
        expect(() => parseCliArgs(['./wdio.conf.ts', '--wat']))
            .toThrow('Unknown option: --wat')
        expect(() => parseCliArgs(['./wdio.conf.ts', './second.conf.ts']))
            .toThrow('Unexpected argument: ./second.conf.ts')
    })
})

describe('CLI entry point', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('returns a failing code regardless of WDIO_UNIT_TESTS', async () => {
        // WDIO_UNIT_TESTS belongs to @wdio/cli, not to this package. Keying exit-code
        // behaviour off it meant anyone who had it exported got a CLI that reported
        // success on failure.
        const previous = process.env.WDIO_UNIT_TESTS
        process.env.WDIO_UNIT_TESTS = '1'
        vi.spyOn(console, 'error').mockImplementation(() => {})

        try {
            await expect(run([])).resolves.toBe(1)
        } finally {
            if (previous === undefined) {
                delete process.env.WDIO_UNIT_TESTS
            } else {
                process.env.WDIO_UNIT_TESTS = previous
            }
        }
    })

    it('prints usage and succeeds for --help', async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})

        await expect(run(['--help'])).resolves.toBe(0)
        expect(log.mock.calls[0][0]).toContain('Usage: wdio-failed-rerun-runner run <configPath>')
    })

    it('reports the usage error and fails when no config path is given', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(run([])).resolves.toBe(1)
        expect(error.mock.calls[0][0]).toContain('Missing required configPath argument')
    })

    it('reports the offending flag and fails on an unknown option', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(run(['./wdio.conf.ts', '--nope'])).resolves.toBe(1)
        expect(error.mock.calls[0][0]).toContain('Unknown option: --nope')
    })

    it('fails when the rerun itself throws', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})

        // No such config file, so the launcher rejects and `run` must surface it.
        await expect(run(['./definitely-missing-wdio.conf.ts', '--max-reruns', '0'])).resolves.toBe(1)
        expect(error).toHaveBeenCalled()
    })
})
