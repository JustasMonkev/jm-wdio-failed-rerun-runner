import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { glob } from 'tinyglobby'

import type { BrokenGlob, MissingFile, SpecEntry, SuiteEntry, WdioConfigShape } from './types.js'
import type { LoadedConfig } from './configFiles.js'

/** Aggregated spec/suite resolution across every loaded config. */
export interface ResolvedSpecs {
    specs: SpecEntry[]
    suites: SuiteEntry[]
    resolvedTestFiles: string[]
    /** Files matched by `exclude` patterns — referenced, but never run. */
    excludedFiles: string[]
    brokenGlobs: BrokenGlob[]
    missingFiles: MissingFile[]
}

interface PatternResolution {
    files: string[]
    broken: boolean
    missing: string | null
}

/** True when a pattern contains glob magic characters. */
export function isGlobPattern(pattern: string): boolean {
    return /[*?[\]{}()!]/.test(pattern)
}

/**
 * Resolve a single spec pattern relative to the directory of the config file
 * that declares it (WDIO semantics).
 */
export async function resolvePattern(pattern: string, configDir: string): Promise<PatternResolution> {
    if (isGlobPattern(pattern)) {
        const files = await glob(toPosix(pattern), { cwd: configDir, absolute: true, onlyFiles: true })
        return {
            files: files.map((file) => path.normalize(file)).sort(),
            broken: files.length === 0,
            missing: null,
        }
    }
    const absolute = path.resolve(configDir, pattern)
    if (existsSync(absolute) && statSync(absolute).isFile()) {
        return { files: [absolute], broken: false, missing: null }
    }
    return { files: [], broken: false, missing: absolute }
}

/**
 * Resolve specs, suites and excludes of every loaded config, recording
 * broken globs and missing literal file references along the way.
 */
export async function resolveAllSpecs(configs: LoadedConfig[]): Promise<ResolvedSpecs> {
    const specs: SpecEntry[] = []
    const suites: SuiteEntry[] = []
    const brokenGlobs: BrokenGlob[] = []
    const missingFiles: MissingFile[] = []
    const allFiles = new Set<string>()
    const excluded = new Set<string>()

    for (const { info, config } of configs) {
        if (config === null) {
            continue
        }
        const configDir = path.dirname(info.path)

        for (const pattern of flattenSpecs(config.specs)) {
            const resolution = await resolvePattern(pattern, configDir)
            specs.push({ pattern, configPath: info.path, resolvedFiles: resolution.files })
            collect(resolution, pattern, info.path, undefined, { brokenGlobs, missingFiles, allFiles })
        }

        for (const [suiteName, suitePatterns] of Object.entries(config.suites ?? {})) {
            const patterns = flattenSpecs(suitePatterns)
            const resolved = new Set<string>()
            for (const pattern of patterns) {
                const resolution = await resolvePattern(pattern, configDir)
                for (const file of resolution.files) {
                    resolved.add(file)
                }
                collect(resolution, pattern, info.path, suiteName, { brokenGlobs, missingFiles, allFiles })
            }
            suites.push({
                name: suiteName,
                configPath: info.path,
                patterns,
                resolvedFiles: [...resolved].sort(),
            })
        }

        for (const pattern of config.exclude ?? []) {
            const resolution = await resolvePattern(pattern, configDir)
            for (const file of resolution.files) {
                excluded.add(file)
            }
        }
    }

    const resolvedTestFiles = [...allFiles].filter((file) => !excluded.has(file)).sort()
    return { specs, suites, resolvedTestFiles, excludedFiles: [...excluded].sort(), brokenGlobs, missingFiles }
}

function collect(
    resolution: PatternResolution,
    pattern: string,
    configPath: string,
    suite: string | undefined,
    sinks: { brokenGlobs: BrokenGlob[]; missingFiles: MissingFile[]; allFiles: Set<string> }
): void {
    for (const file of resolution.files) {
        sinks.allFiles.add(file)
    }
    if (resolution.broken) {
        sinks.brokenGlobs.push(suite === undefined ? { pattern, configPath } : { pattern, configPath, suite })
    }
    if (resolution.missing !== null) {
        sinks.missingFiles.push(
            suite === undefined
                ? { path: resolution.missing, pattern, configPath }
                : { path: resolution.missing, pattern, configPath, suite }
        )
    }
}

/** Flatten WDIO spec declarations (entries may be grouped into arrays). */
export function flattenSpecs(specs: WdioConfigShape['specs']): string[] {
    if (specs === undefined) {
        return []
    }
    const flat: string[] = []
    for (const entry of specs) {
        if (typeof entry === 'string') {
            flat.push(entry)
        } else {
            flat.push(...entry)
        }
    }
    return flat
}

function toPosix(pattern: string): string {
    return pattern.replaceAll('\\', '/')
}
