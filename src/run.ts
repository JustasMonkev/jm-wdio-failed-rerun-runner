import path from 'node:path'

import * as z from 'zod'

import { runFailedTestsRerun } from '#src/launcher'

const nonNegativeIntegerStringSchema = z.string().transform((value, context) => {
    const maxReruns = Number(value)

    if (!Number.isInteger(maxReruns) || maxReruns < 0) {
        context.issues.push({
            code: 'custom',
            input: value,
            message: '--max-reruns must be a non-negative integer'
        })
        return z.NEVER
    }

    return maxReruns
})

const cliFlagValueSchema = z.string().min(1).refine((value) => !value.startsWith('-'))

const parsedCliArgsSchema = z.object({
    configPath: z.string().optional(),
    help: z.boolean(),
    options: z.object({
        manifestPath: z.string().optional(),
        maxReruns: nonNegativeIntegerStringSchema.optional(),
        passOnSuccessfulRerun: z.boolean().optional(),
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

export class CliUsageError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'CliUsageError'
    }
}

export default async function run(argv = process.argv.slice(2)) {
    let parsedArgs: ParsedCliArgs
    try {
        parsedArgs = parseCliArgs(argv)
    } catch (error) {
        console.error((error as Error).message)
        printUsage(console.error)
        if (!process.env.WDIO_UNIT_TESTS) {
            process.exit(1)
        }
        return 1
    }

    if (parsedArgs.help) {
        printUsage(console.log)
        if (!process.env.WDIO_UNIT_TESTS) {
            process.exit(0)
        }
        return 0
    }

    try {
        const result = await runFailedTestsRerun(
            path.resolve(process.cwd(), parsedArgs.configPath!),
            parsedArgs.options
        )
        if (!process.env.WDIO_UNIT_TESTS) {
            process.exit(result.exitCode)
        }
        return result.exitCode
    } catch (error) {
        console.error(error)
        if (!process.env.WDIO_UNIT_TESTS) {
            process.exit(1)
        }
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
  -h, --help                        Show this help message.`)
}
