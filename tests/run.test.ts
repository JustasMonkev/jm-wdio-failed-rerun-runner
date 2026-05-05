import { describe, expect, it } from 'vitest'

import { CliUsageError, parseCliArgs } from '#src/run'

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
