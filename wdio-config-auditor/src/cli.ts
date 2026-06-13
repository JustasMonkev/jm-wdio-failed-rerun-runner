#!/usr/bin/env node
import process from 'node:process'

import { audit } from './audit.js'
import type { AuditOptions } from './types.js'

const HELP = `wdio-config-auditor — validate WDIO test declarations

Usage:
  wdio-config-auditor [options]

Options:
  --cwd <path>       Project root (default: current directory)
  --config <path>    Audit a specific config file (repeatable)
  --no-fail-orphans  Do not fail on orphaned test files
  --help             Show this help

Prints the structured AuditResult as JSON and exits 1 when the audit fails.`

export async function main(argv: string[]): Promise<number> {
    const options: AuditOptions = {}
    const configPaths: string[] = []
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]!
        switch (arg) {
            case '--help':
            case '-h':
                console.log(HELP)
                return 0
            case '--cwd': {
                const cwd = argv[++i]
                if (cwd !== undefined) {
                    options.cwd = cwd
                }
                break
            }
            case '--config':
                configPaths.push(argv[++i] ?? '')
                break
            case '--no-fail-orphans':
                options.failOn = { ...options.failOn, orphanedTestFiles: false }
                break
            default:
                console.error(`Unknown option: ${arg}\n\n${HELP}`)
                return 2
        }
    }
    if (configPaths.length > 0) {
        options.configPaths = configPaths
    }
    const result = await audit(options)
    console.log(JSON.stringify(result, null, 2))
    return result.status === 'pass' ? 0 : 1
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/'))
if (isDirectRun) {
    main(process.argv.slice(2)).then(
        (code) => process.exit(code),
        (error: unknown) => {
            console.error(error instanceof Error ? error.message : String(error))
            process.exit(2)
        }
    )
}
