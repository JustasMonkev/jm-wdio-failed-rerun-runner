import os from 'node:os'
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

const TYPESCRIPT_CONFIG_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts'])

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

    const wrapper = await createConfigWithExtraServices(configPath, args.services)

    try {
        return await new Launcher(wrapper.path, withoutServices(args)).run()
    } finally {
        await wrapper.remove()
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
    const wrapperId = randomUUID()
    const rootDirectory = JSON.stringify(configDirectory)
    // A `.ts` wrapper is compiled to CommonJS in a project without `"type": "module"`,
    // where the top-level await below is a syntax error - so every run with a TypeScript
    // config in such a project failed here. `.mts` is always ESM, and WebdriverIO both
    // accepts it as a config extension and registers its TypeScript loader by suffix.
    const wrapperExtension = TYPESCRIPT_CONFIG_EXTENSIONS.has(path.extname(configPath)) ? '.mts' : '.mjs'
    const wrapperPath = path.join(configDirectory, `.wdio-failed-rerun-${wrapperId}${wrapperExtension}`)
    const serializedServices = JSON.stringify(assertJsonSerializable(services), null, 4)

    // A relative specifier is resolved as a URL, not as a filesystem path, so a config whose
    // name contains `#`, `?` or `%` imports the wrong thing: the first two truncate at the
    // fragment or query, and `%20` percent-decodes to a different filename. Service
    // injection sends every normal run through this wrapper, so that would fail a config
    // WebdriverIO itself would have loaded. A file URL carries the literal path through.
    //
    // Every attempt runs in this same process, so without the query Node's module registry
    // would hand a rerun the config object the initial attempt evaluated - stale for any
    // config that reads the rerun environment at module scope. The wrapper's own id makes
    // each attempt a distinct module. A CommonJS config is cached by filename whatever the
    // query says, which is equally true of how WebdriverIO loads it without this wrapper.
    return writeWrapper(wrapperPath, `const baseModule = await import(${JSON.stringify(`${pathToFileURL(configPath).href}?wdio-failed-rerun=${wrapperId}`)})
const baseConfig = baseModule.config || baseModule.default?.config || baseModule.default || {}
const extraServices = ${serializedServices}

export const config = {
    ...baseConfig,
    rootDir: baseConfig.rootDir ?? ${rootDirectory},
    services: [
        ...(baseConfig.services || []),
        ...extraServices
    ]
}
`)
}

// The wrapper goes beside the config so that anything WebdriverIO resolves from the config
// file's own path keeps working. A project mounted read-only cannot take it, though, and
// service injection sends every run through here - so rather than fail outright, fall back
// to a writable temporary directory. `rootDir` above is what makes that safe: without it a
// relocated wrapper resolves relative `specs` against the temporary directory and matches
// nothing, which for a rerun tool reads as "everything passed".
async function writeWrapper(wrapperPath: string, contents: string) {
    try {
        await fs.writeFile(wrapperPath, contents)
        return {
            path: wrapperPath,
            remove: () => fs.rm(wrapperPath, { force: true })
        }
    } catch (error) {
        if (!isReadOnlyError(error)) {
            throw error
        }

        // The directory is ours, so it goes with the wrapper: leaving one behind per run
        // would accumulate in the temp directory for as long as the project is deployed
        // read-only.
        const fallbackDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-'))
        const fallbackPath = path.join(fallbackDirectory, path.basename(wrapperPath))
        await fs.writeFile(fallbackPath, contents)
        return {
            path: fallbackPath,
            remove: () => fs.rm(fallbackDirectory, { force: true, recursive: true })
        }
    }
}

function isReadOnlyError(error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EROFS' || code === 'EACCES' || code === 'EPERM'
}

function withoutServices(args: FailedRerunRunArgs): FailedRerunRunArgs {
    const { services: _services, ...launcherArgs } = args
    return launcherArgs
}

// Services passed as launcher arguments are written into the wrapper's source, and
// WebdriverIO hands every worker the wrapper's *path* rather than the loaded object - so a
// service class, an instance, or an option that is a function cannot survive the trip.
// Services declared in the config's own `services` array are a different matter: the
// wrapper spreads them at runtime, so those keep working and are the way to register one.
function assertJsonSerializable(services: NonNullable<FailedRerunRunArgs['services']>) {
    const offending = services.findIndex((service) => !jsonSerializableValueSchema.safeParse(service).success)
    if (offending === -1) {
        return services
    }

    throw new FailedRerunUsageError([
        `Service entry ${offending} passed to the runner cannot be injected: ${describeServiceEntry(services[offending])}.`,
        'Injected services are written into a generated config that each WebdriverIO worker loads by path,',
        'so they have to be JSON-serializable.',
        "Declare it in your config's own `services` array instead - those are passed through untouched."
    ].join(' '))
}

function describeServiceEntry(service: unknown) {
    if (typeof service === 'function') {
        return `it is a service class${service.name ? ` (${service.name})` : ''}`
    }

    if (Array.isArray(service)) {
        return `the options for '${String(service[0])}' are not JSON-serializable`
    }

    if (service && typeof service === 'object') {
        return 'it is a service instance'
    }

    return `it is ${typeof service}`
}
