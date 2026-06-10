import path from 'node:path'
import { existsSync } from 'node:fs'

import type { AuditOptions, AuditResult, ConfigDiscoveryMethod, DiscoveredScript, FailOnOptions } from './types.js'
import { discoverWdioScripts, readPackageJson } from './packageScripts.js'
import { discoverConfigsByConvention, loadConfigs } from './configFiles.js'
import { resolveAllSpecs } from './specs.js'
import { DEFAULT_IGNORE_PATTERNS, DEFAULT_TEST_FILE_PATTERNS, findOrphanedTestFiles } from './orphans.js'

const DEFAULT_FAIL_ON: Required<FailOnOptions> = {
    brokenGlobs: true,
    missingFiles: true,
    orphanedTestFiles: true,
    noConfig: true,
    loadErrors: true,
}

/**
 * Audit a project: discover WDIO scripts and config files, resolve every
 * spec/suite pattern, and report broken globs, missing files and orphaned
 * test files.
 */
export async function audit(options: AuditOptions = {}): Promise<AuditResult> {
    const cwd = path.resolve(options.cwd ?? process.cwd())
    const ignorePatterns = options.ignorePatterns ?? [...DEFAULT_IGNORE_PATTERNS]
    const testFilePatterns = options.testFilePatterns ?? [...DEFAULT_TEST_FILE_PATTERNS]
    const failOn: Required<FailOnOptions> = { ...DEFAULT_FAIL_ON, ...options.failOn }
    const errors: string[] = []

    // 1. package.json scripts
    let scripts: DiscoveredScript[] = []
    try {
        const pkg = await readPackageJson(cwd)
        scripts = discoverWdioScripts(pkg, cwd)
        for (const script of scripts) {
            if (script.configArg !== null && script.configPath === null) {
                errors.push(
                    `Script "${script.name}" references config "${script.configArg}" which does not exist`
                )
            }
        }
    } catch (error) {
        errors.push(`Could not read package.json: ${error instanceof Error ? error.message : String(error)}`)
    }

    // 2. config file discovery
    const configEntries = new Map<string, ConfigDiscoveryMethod>()
    if (options.configPaths !== undefined) {
        for (const configPath of options.configPaths) {
            configEntries.set(path.resolve(cwd, configPath), 'explicit')
        }
    } else {
        for (const script of scripts) {
            if (script.configPath !== null) {
                configEntries.set(script.configPath, 'script')
            }
        }
        for (const found of await discoverConfigsByConvention(cwd, ignorePatterns)) {
            if (!configEntries.has(found)) {
                configEntries.set(found, 'convention')
            }
        }
        // Scripts that rely on the WDIO default config location
        for (const script of scripts) {
            if (script.configArg === null) {
                for (const ext of ['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']) {
                    const fallback = path.join(cwd, `wdio.conf${ext}`)
                    if (existsSync(fallback) && !configEntries.has(fallback)) {
                        configEntries.set(fallback, 'convention')
                    }
                }
            }
        }
    }

    // 3. load configs, following imported/merged base configs
    const loaded = await loadConfigs(configEntries, cwd)
    const configFiles = loaded.map((entry) => entry.info)
    for (const info of configFiles) {
        if (!info.loaded) {
            errors.push(`Could not load config ${info.path}: ${info.loadError ?? 'unknown error'}`)
        }
    }

    // 4. resolve specs/suites/excludes
    const { specs, suites, resolvedTestFiles, excludedFiles, brokenGlobs, missingFiles } =
        await resolveAllSpecs(loaded)

    // 5. orphan detection — excluded files are referenced on purpose, so they
    // do not count as orphans
    const orphanedTestFiles = await findOrphanedTestFiles(
        cwd,
        [...resolvedTestFiles, ...excludedFiles],
        testFilePatterns,
        ignorePatterns
    )

    const hasLoadedConfig = configFiles.some((info) => info.loaded)
    const hasLoadError = configFiles.some((info) => !info.loaded)
    const failed =
        (failOn.brokenGlobs && brokenGlobs.length > 0) ||
        (failOn.missingFiles && missingFiles.length > 0) ||
        (failOn.orphanedTestFiles && orphanedTestFiles.length > 0) ||
        (failOn.noConfig && !hasLoadedConfig) ||
        (failOn.loadErrors && hasLoadError)

    if (failOn.noConfig && !hasLoadedConfig) {
        errors.push('No WDIO config file could be found and loaded')
    }

    return {
        status: failed ? 'fail' : 'pass',
        scripts,
        configFiles,
        specs,
        suites,
        resolvedTestFiles,
        orphanedTestFiles,
        brokenGlobs,
        missingFiles,
        errors,
    }
}
