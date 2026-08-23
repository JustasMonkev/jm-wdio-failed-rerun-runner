import path from 'node:path'

import * as z from 'zod'

import { FailedRerunUsageError } from '#src/errors'
import { MAX_RERUNS_LIMIT, runFailedTestsRerun } from '#src/rerunner'

const nonNegativeIntegerStringSchema = z.string().transform((value, context) => {
    const fail = (message: string) => {
        context.issues.push({ code: 'custom', input: value, message })
        return z.NEVER
    }

    // Parse strictly: `Number()` would silently accept '1e3', '0x10', '+5' and ' 5'.
    if (!/^\d+$/.test(value)) {
        return fail('--max-reruns must be a non-negative integer')
    }

    const maxReruns = Number(value)
    if (!Number.isSafeInteger(maxReruns) || maxReruns > MAX_RERUNS_LIMIT) {
        return fail(`--max-reruns must be between 0 and ${MAX_RERUNS_LIMIT}`)
    }

    return maxReruns
})

// A leading '-' normally means the next flag, i.e. a missing value. A negative number is
// the exception: treat it as a value so it reaches the validator and gets an error that
// names the real problem instead of "Missing value".
const cliFlagValueSchema = z.string().min(1)
    .refine((value) => !value.startsWith('-') || /^-\d+$/.test(value))

const parsedCliArgsSchema = z.object({
    configPath: z.string().optional(),
    help: z.boolean(),
    options: z.object({
        manifestPath: z.string().optional(),
        maxReruns: nonNegativeIntegerStringSchema.optional(),
        passOnSuccessfulRerun: z.boolean().optional(),
        quiet: z.boolean().optional(),
        rerunManifestPath: z.string().optional()
    })
}).superRefine((value, context) => {
    if (!value.help && !value.configPath) {
        context.addIssue({
            code: 'custom',
            message: 'Missing required configPath argument',
            path: ['configPath']
        })
    }
})

type ParsedCliArgs = z.output<typeof parsedCliArgsSchema>
type ParsedCliArgsInput = z.input<typeof parsedCliArgsSchema>

// WebdriverIO's launcher registers an `async-exit-hook` handler, which replaces the
// process exit path in a way that discards `process.exitCode`: a process that only sets it
// still exits 0, so every failing run would report success. Exiting explicitly is the only
// reliable way to signal failure, but `process.exit` truncates pending asynchronous writes
// to a pipe, which would swallow the summary the reporter just printed. Drain first, then
// exit.
export async function exitWith(exitCode: number) {
    process.exitCode = exitCode
    await Promise.all([flushStream(process.stdout), flushStream(process.stderr)])
    process.exit(exitCode)
}

export function flushStream(stream: NodeJS.WriteStream) {
    return new Promise<void>((resolve) => {
        if (stream.writableLength === 0) {
            resolve()
            return
        }

        stream.write('', () => resolve())
    })
}

export class CliUsageError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CliUsageError'
    }
}

export default async function run(argv = process.argv.slice(2)): Promise<number> {
    let parsedArgs: ParsedCliArgs
    try {
        parsedArgs = parseCliArgs(argv)
    } catch (error) {
        console.error((error as Error).message)
        printUsage(console.error)
        return 1
    }

    if (parsedArgs.help) {
        printUsage(console.log)
        return 0
    }

    try {
        const result = await runFailedTestsRerun(
            path.resolve(process.cwd(), parsedArgs.configPath!),
            parsedArgs.options
        )
        return result.exitCode
    } catch (error) {
        console.error(error instanceof FailedRerunUsageError ? error.message : error)
        return 1
    }
}

export function parseCliArgs(argv: string[]): ParsedCliArgs {
    const args = argv[0] === 'run' ? argv.slice(1) : argv
    const parsed: ParsedCliArgsInput = {
        help: false,
        options: {}
    }

    for (let index = 0; index < args.length; index++) {
        const arg = args[index]

        if (arg === '--help' || arg === '-h') {
            parsed.help = true
            break
        }

        if (arg === '--quiet' || arg === '-q') {
            parsed.options.quiet = true
            continue
        }

        if (arg === '--pass-on-successful-rerun') {
            parsed.options.passOnSuccessfulRerun = true
            continue
        }

        if (arg === '--no-pass-on-successful-rerun') {
            parsed.options.passOnSuccessfulRerun = false
            continue
        }

        if (arg === '--max-reruns' || arg.startsWith('--max-reruns=')) {
            const { value, nextIndex } = readFlagValue(args, index, '--max-reruns')
            parsed.options.maxReruns = value
            index = nextIndex
            continue
        }

        if (arg === '--manifest-path' || arg.startsWith('--manifest-path=')) {
            const { value, nextIndex } = readFlagValue(args, index, '--manifest-path')
            parsed.options.manifestPath = value
            index = nextIndex
            continue
        }

        if (arg === '--rerun-manifest-path' || arg.startsWith('--rerun-manifest-path=')) {
            const { value, nextIndex } = readFlagValue(args, index, '--rerun-manifest-path')
            parsed.options.rerunManifestPath = value
            index = nextIndex
            continue
        }

        if (arg.startsWith('-')) {
            throw new CliUsageError(`Unknown option: ${arg}`)
        }

        if (parsed.configPath) {
            throw new CliUsageError(`Unexpected argument: ${arg}`)
        }

        parsed.configPath = arg
    }

    const result = parsedCliArgsSchema.safeParse(parsed)
    if (!result.success) {
        throw new CliUsageError(result.error.issues[0]?.message || 'Invalid CLI arguments')
    }

    return result.data
}

function readFlagValue(args: string[], index: number, flag: string) {
    const arg = args[index]
    const inlineValue = arg.startsWith(`${flag}=`)
        ? arg.slice(flag.length + 1)
        : undefined

    if (inlineValue !== undefined) {
        if (!inlineValue) {
            throw new CliUsageError(`Missing value for ${flag}`)
        }

        return {
            value: inlineValue,
            nextIndex: index
        }
    }

    const value = args[index + 1]
    if (!cliFlagValueSchema.safeParse(value).success) {
        throw new CliUsageError(`Missing value for ${flag}`)
    }

    return {
        value,
        nextIndex: index + 1
    }
}

function printUsage(write: (message?: unknown, ...optionalParams: unknown[]) => void) {
    write(`Usage: wdio-failed-rerun-runner run <configPath> [options]

Options:
  --max-reruns <count>              Maximum focused rerun rounds. Defaults to 1.
  --manifest-path <path>            Path for the initial-run failure manifest.
  --rerun-manifest-path <path>      Path for rerun failure manifests.
  --pass-on-successful-rerun        Return 0 when focused reruns pass. This is the default.
  --no-pass-on-successful-rerun     Keep the initial failing exit code after successful reruns.
  -q, --quiet                       Suppress rerun progress and the final summary.
  -h, --help                        Show this help message.`)
}
