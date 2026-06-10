import path from 'node:path'

import { glob } from 'tinyglobby'

/** Default patterns identifying candidate test files for orphan detection. */
export const DEFAULT_TEST_FILE_PATTERNS: readonly string[] = [
    '**/*.spec.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
    '**/*.test.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
    '**/*.e2e.{js,jsx,ts,tsx,mjs,mts,cjs,cts}',
]

/** Default patterns excluded from discovery and orphan detection. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/coverage/**',
    '**/.git/**',
]

/**
 * Find test files on disk that are not referenced by any WDIO spec or suite.
 */
export async function findOrphanedTestFiles(
    cwd: string,
    resolvedTestFiles: readonly string[],
    testFilePatterns: readonly string[],
    ignorePatterns: readonly string[]
): Promise<string[]> {
    const candidates = await glob([...testFilePatterns], {
        cwd,
        ignore: [...ignorePatterns],
        absolute: true,
        onlyFiles: true,
    })
    const referenced = new Set(resolvedTestFiles.map((file) => path.normalize(file)))
    return candidates
        .map((file) => path.normalize(file))
        .filter((file) => !referenced.has(file))
        .sort()
}
