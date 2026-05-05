import fs from 'node:fs/promises'
import path from 'node:path'

import type { FailedTestRecord } from '#src/types.js'

export async function resetManifest(manifestPath: string) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.rm(manifestPath, { force: true })
}

export async function appendFailedTest(manifestPath: string, record: FailedTestRecord) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.appendFile(manifestPath, `${JSON.stringify(record)}\n`, 'utf8')
}

export async function readFailedTests(manifestPath: string): Promise<FailedTestRecord[]> {
    try {
        const content = await fs.readFile(manifestPath, 'utf8')
        return dedupeFailedTests(parseManifest(content))
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return []
        }
        throw error
    }
}

function parseManifest(content: string) {
    return content
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FailedTestRecord)
}

function dedupeFailedTests(records: FailedTestRecord[]) {
    const seen = new Set<string>()
    const deduped: FailedTestRecord[] = []

    for (const record of records) {
        const key = getFailureKey(record)
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        deduped.push(record)
    }

    return deduped
}

function getFailureKey(record: FailedTestRecord) {
    return `${record.framework}\0${record.spec}\0${record.fullTitle}`
}
