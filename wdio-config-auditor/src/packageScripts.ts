import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

import type { DiscoveredScript } from './types.js'

const CONFIG_EXTENSIONS = ['.js', '.ts', '.mjs', '.mts', '.cjs', '.cts']

interface PackageJsonShape {
    scripts?: Record<string, string>
}

/**
 * Read and parse a package.json file.
 * Throws when the file is missing or contains invalid JSON.
 */
export async function readPackageJson(cwd: string): Promise<PackageJsonShape> {
    const filePath = path.join(cwd, 'package.json')
    const raw = await readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
        throw new Error(`Invalid package.json at ${filePath}: expected an object`)
    }
    return parsed as PackageJsonShape
}

/**
 * Find package.json scripts that invoke the WDIO test runner and resolve
 * the config file each one points at.
 */
export function discoverWdioScripts(pkg: PackageJsonShape, cwd: string): DiscoveredScript[] {
    const scripts = pkg.scripts ?? {}
    const discovered: DiscoveredScript[] = []

    for (const [name, command] of Object.entries(scripts)) {
        const configArg = extractWdioConfigArg(command)
        if (configArg === undefined) {
            continue
        }
        let configPath: string | null = null
        if (configArg !== null) {
            const resolved = path.resolve(cwd, configArg)
            configPath = existsSync(resolved) ? resolved : null
        }
        discovered.push({ name, command, configArg, configPath })
    }
    return discovered
}

/**
 * Inspect a shell command. Returns `undefined` when the command does not
 * invoke WDIO, `null` when it does but without an explicit config argument,
 * and the config argument string otherwise.
 */
export function extractWdioConfigArg(command: string): string | null | undefined {
    // Audit each sub-command of compound commands separately
    const segments = command.split(/&&|\|\||;/)
    for (const segment of segments) {
        const tokens = segment.trim().split(/\s+/).filter(Boolean)
        const wdioIndex = tokens.findIndex((token) => isWdioToken(token))
        if (wdioIndex === -1) {
            continue
        }
        let i = wdioIndex + 1
        if (tokens[i] === 'run') {
            i += 1
        }
        // The config is the positional argument with a config-like extension;
        // flags and flag values (e.g. `--suite smoke`) are skipped.
        for (; i < tokens.length; i++) {
            const bare = stripQuotes(tokens[i]!)
            if (bare.startsWith('-')) {
                continue
            }
            if (CONFIG_EXTENSIONS.some((ext) => bare.endsWith(ext))) {
                return bare
            }
        }
        return null
    }
    return undefined
}

function isWdioToken(token: string): boolean {
    const bare = stripQuotes(token)
    return bare === 'wdio' || bare.endsWith('/wdio') || bare.endsWith('\\wdio')
}

function stripQuotes(value: string): string {
    return value.replace(/^['"]|['"]$/g, '')
}
