import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'

import * as z from 'zod'

import { FailedRerunUsageError } from '#src/errors'
import { jsonSerializableValueSchema } from '#src/schemas'
import type {
    FailedRerunRun,
    FailedRerunRunArgs
} from '#src/types'

type LauncherConstructor = new (
    configPath: string,
    args: FailedRerunRunArgs
) => {
    run(): Promise<number | undefined>
}

type WdioCliModule = {
    Launcher?: LauncherConstructor
}

const wdioCliModuleSchema = z.object({
    Launcher: z.custom<LauncherConstructor>((value) => typeof value === 'function')
}).passthrough()

export const runWdio = createWdioRun()

export function createWdioRun(loadWdioCli: () => Promise<WdioCliModule> = importWdioCli): FailedRerunRun {
    return async (configPath, args) => {
        const Launcher = await loadWdioLauncher(loadWdioCli)
        return runWithWdioLauncher(Launcher, configPath, args)
    }
}

export async function loadWdioLauncher(loadWdioCli: () => Promise<WdioCliModule> = importWdioCli) {
    const result = wdioCliModuleSchema.safeParse(await loadWdioCli())
    if (!result.success) {
        throw new Error('@wdio/cli did not export Launcher')
    }

    return result.data.Launcher
}

async function importWdioCli(): Promise<WdioCliModule> {
    const wdioCli: string = '@wdio/cli'
    return import(wdioCli) as Promise<WdioCliModule>
}

async function runWithWdioLauncher(Launcher: LauncherConstructor, configPath: string, args: FailedRerunRunArgs) {
    // Check before writing the wrapper: otherwise a mistyped config path surfaces as a
    // module-resolution stack trace naming an internal `.wdio-failed-rerun-*` temp file
    // the user never created, or as a raw ENOENT from writing the wrapper itself.
    await assertConfigExists(configPath)

    if (!args.services?.length) {
        return new Launcher(configPath, args).run()
    }

    const wrappedConfigPath = await createConfigWithExtraServices(configPath, args.services)

    try {
        return await new Launcher(wrappedConfigPath, withoutServices(args)).run()
    } finally {
        await fs.rm(wrappedConfigPath, { force: true })
    }
}

// Services cannot be injected through launcher args. WebdriverIO's ConfigParser merges
// `services` with a custom array strategy that keeps `oldValue.filter(v => typeof v !== 'object')`,
// so passing `args.services` SILENTLY DROPS every tuple-form service already configured in the
// user's own config: a config declaring `['chromedriver', ['browserstack', {...}]]` comes back as
// `[injectedService, 'chromedriver']`. That would break any service configured with options -
// including `@wdio/browserstack-service`, which this package explicitly supports. Wrapping the
// config instead leaves the user's `services` array untouched. Keep it that way.
async function assertConfigExists(configPath: string) {
    try {
        await fs.access(configPath)
    } catch {
        throw new FailedRerunUsageError(`WebdriverIO config not found: ${configPath}`)
    }
}

async function createConfigWithExtraServices(configPath: string, services: NonNullable<FailedRerunRunArgs['services']>) {
    const configDirectory = path.dirname(configPath)
    const configExtension = path.extname(configPath)
    const wrapperExtension = configExtension === '.ts' ? '.ts' : '.mjs'
    const wrapperPath = path.join(configDirectory, `.wdio-failed-rerun-${randomUUID()}${wrapperExtension}`)
    const serializedServices = JSON.stringify(assertJsonSerializable(services), null, 4)

    // A relative specifier is resolved as a URL, not as a filesystem path, so a config whose
    // name contains `#`, `?` or `%` imports the wrong thing: the first two truncate at the
    // fragment or query, and `%20` percent-decodes to a different filename. Service
    // injection sends every normal run through this wrapper, so that would fail a config
    // WebdriverIO itself would have loaded. A file URL carries the literal path through.
    await fs.writeFile(wrapperPath, `const baseModule = await import(${JSON.stringify(pathToFileURL(configPath).href)})
const baseConfig = baseModule.config || baseModule.default?.config || baseModule.default || {}
const extraServices = ${serializedServices}

export const config = {
    ...baseConfig,
    services: [
        ...(baseConfig.services || []),
        ...extraServices
    ]
}
`)

    return wrapperPath
}

function withoutServices(args: FailedRerunRunArgs): FailedRerunRunArgs {
    const { services: _services, ...launcherArgs } = args
    return launcherArgs
}

function assertJsonSerializable<T>(value: T): T {
    const result = jsonSerializableValueSchema.safeParse(value)
    if (!result.success) {
        throw new Error('WDIO service injection only supports JSON-serializable service entries')
    }

    return value
}
