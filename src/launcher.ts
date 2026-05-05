import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import * as z from 'zod'

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

async function createConfigWithExtraServices(configPath: string, services: NonNullable<FailedRerunRunArgs['services']>) {
    const configDirectory = path.dirname(configPath)
    const configExtension = path.extname(configPath)
    const wrapperExtension = configExtension === '.ts' ? '.ts' : '.mjs'
    const wrapperPath = path.join(configDirectory, `.wdio-failed-rerun-${randomUUID()}${wrapperExtension}`)
    const serializedServices = JSON.stringify(assertJsonSerializable(services), null, 4)

    await fs.writeFile(wrapperPath, `const baseModule = await import(${JSON.stringify(`./${path.basename(configPath)}`)})
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
