import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { glob } from 'tinyglobby'
import { createJiti } from 'jiti'

import type { ConfigDiscoveryMethod, ConfigFileInfo, WdioConfigShape } from './types.js'

const CONFIG_GLOB = '**/*wdio*.conf*.{js,ts,mjs,mts,cjs,cts}'
const RESOLVE_EXTENSIONS = ['', '.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']
const INDEX_SUFFIXES = ['/index.ts', '/index.mts', '/index.js', '/index.mjs', '/index.cjs', '/index.cts']

/** A config file together with its (possibly failed) loaded content. */
export interface LoadedConfig {
    info: ConfigFileInfo
    config: WdioConfigShape | null
}

/**
 * Discover WDIO config files by naming convention, e.g. `wdio.conf.ts`,
 * `wdio.ios.conf.js` or `configs/wdio.shared.conf.mts`.
 */
export async function discoverConfigsByConvention(
    cwd: string,
    ignorePatterns: string[]
): Promise<string[]> {
    const matches = await glob(CONFIG_GLOB, {
        cwd,
        ignore: ignorePatterns,
        absolute: true,
        onlyFiles: true,
    })
    return matches.map((file) => path.normalize(file)).sort()
}

/**
 * Load every config file, following relative imports between config files so
 * that shared/merged base configs are audited too.
 *
 * @param entries map of absolute config path -> how it was discovered
 */
export async function loadConfigs(
    entries: Map<string, ConfigDiscoveryMethod>,
    cwd: string
): Promise<LoadedConfig[]> {
    const jiti = createJiti(import.meta.url, { interopDefault: true })
    const queue = [...entries.keys()]
    const seen = new Set(queue)
    const results: LoadedConfig[] = []

    while (queue.length > 0) {
        const configPath = queue.shift()!
        const discoveredVia = entries.get(configPath) ?? 'import'
        const loaded = await loadSingleConfig(jiti, configPath, discoveredVia)
        results.push(loaded)

        // Follow relative imports that look like further config modules
        for (const imported of await findImportedConfigFiles(configPath, cwd)) {
            if (!seen.has(imported)) {
                seen.add(imported)
                entries.set(imported, 'import')
                queue.push(imported)
            }
        }
    }
    return results
}

async function loadSingleConfig(
    jiti: ReturnType<typeof createJiti>,
    configPath: string,
    discoveredVia: ConfigDiscoveryMethod
): Promise<LoadedConfig> {
    if (!existsSync(configPath)) {
        return {
            info: { path: configPath, discoveredVia, loaded: false, loadError: 'File does not exist' },
            config: null,
        }
    }
    try {
        const mod = await jiti.import<Record<string, unknown>>(configPath)
        const config = extractConfigExport(mod)
        if (config === null) {
            return {
                info: {
                    path: configPath,
                    discoveredVia,
                    loaded: false,
                    loadError: 'Module does not export a `config` object',
                },
                config: null,
            }
        }
        return { info: { path: configPath, discoveredVia, loaded: true }, config }
    } catch (error) {
        return {
            info: {
                path: configPath,
                discoveredVia,
                loaded: false,
                loadError: error instanceof Error ? error.message : String(error),
            },
            config: null,
        }
    }
}

const CONFIG_MARKER_KEYS = ['specs', 'suites', 'exclude', 'capabilities', 'framework', 'runner']

function extractConfigExport(mod: Record<string, unknown>): WdioConfigShape | null {
    const defaultExport = typeof mod.default === 'object' && mod.default !== null
        ? (mod.default as Record<string, unknown>)
        : undefined
    const candidate = mod.config ?? defaultExport?.config
    if (typeof candidate === 'object' && candidate !== null) {
        return candidate as WdioConfigShape
    }
    // `export default { specs: [...] }` — accept the default export itself
    // only when it actually looks like a testrunner config (jiti's interop
    // mirrors the whole namespace onto `default`, so shape-check it).
    if (defaultExport !== undefined && CONFIG_MARKER_KEYS.some((key) => key in defaultExport)) {
        return defaultExport as WdioConfigShape
    }
    return null
}

/**
 * Statically scan a config file for relative imports that resolve to other
 * WDIO config modules (files exporting a `config` value). This is how
 * shared base configs (`import { config as base } from './wdio.shared.conf'`)
 * are discovered.
 */
export async function findImportedConfigFiles(configPath: string, cwd: string): Promise<string[]> {
    let source: string
    try {
        source = await readFile(configPath, 'utf8')
    } catch {
        return []
    }
    const dir = path.dirname(configPath)
    const specifiers = extractRelativeSpecifiers(source)
    const found: string[] = []

    for (const specifier of specifiers) {
        const resolved = resolveRelativeImport(dir, specifier)
        if (resolved === null || !isInside(cwd, resolved)) {
            continue
        }
        if (await exportsConfig(resolved)) {
            found.push(resolved)
        }
    }
    return found
}

/** Extract relative module specifiers from import/export/require statements. */
export function extractRelativeSpecifiers(source: string): string[] {
    const pattern =
        /(?:import|export)\s+[^'"]*?from\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|require\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+)['"]/g
    const specifiers = new Set<string>()
    for (const match of source.matchAll(pattern)) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? match[4]
        if (specifier !== undefined) {
            specifiers.add(specifier)
        }
    }
    return [...specifiers]
}

function resolveRelativeImport(fromDir: string, specifier: string): string | null {
    const base = path.resolve(fromDir, specifier)
    const candidates: string[] = []
    for (const ext of RESOLVE_EXTENSIONS) {
        candidates.push(base + ext)
    }
    // TS-style `./foo.js` specifiers that actually point at `./foo.ts`
    if (/\.(js|mjs|cjs)$/.test(base)) {
        candidates.push(base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'))
    }
    for (const suffix of INDEX_SUFFIXES) {
        candidates.push(base + suffix)
    }
    for (const candidate of candidates) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
            return path.normalize(candidate)
        }
    }
    return null
}

async function exportsConfig(filePath: string): Promise<boolean> {
    try {
        const source = await readFile(filePath, 'utf8')
        return /\bexport\s+(?:const|let|var)\s+config\b|\bexports\.config\s*=|\bexport\s*\{[^}]*\bconfig\b|module\.exports\s*=\s*\{[^]*?\bconfig\b/.test(
            source
        )
    } catch {
        return false
    }
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child)
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}
