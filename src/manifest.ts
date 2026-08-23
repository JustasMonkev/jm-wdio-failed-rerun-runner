import fs from 'node:fs/promises'
import path from 'node:path'

import { failedTestRecordSchema } from '#src/schemas'
import type { FailedTestRecord } from '#src/types'

export async function resetManifest(manifestPath: string) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.rm(manifestPath, { force: true })
}

export async function appendFailedTest(manifestPath: string, record: FailedTestRecord) {
    await fs.mkdir(path.dirname(manifestPath), { recursive: true })
    await fs.appendFile(manifestPath, `${JSON.stringify(failedTestRecordSchema.parse(record))}\n`, 'utf8')
}

export async function readManifest(manifestPath: string): Promise<FailedTestRecord[]> {
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

export async function readFailedTests(manifestPath: string): Promise<FailedTestRecord[]> {
    return (await readManifest(manifestPath)).filter((record) => record.outcome !== 'passed')
}

// A worker killed mid-write, a full disk, or an unrelated process appending to the
// manifest would otherwise abort the whole rerun. A manifest is diagnostic data, so a
// line we cannot read is skipped rather than allowed to destroy the run.
function parseManifest(content: string) {
    const records: FailedTestRecord[] = []

    for (const line of content.split('\n')) {
        if (!line) {
            continue
        }

        const record = parseManifestLine(line)
        if (record) {
            records.push(record)
        }
    }

    return records
}

function parseManifestLine(line: string) {
    try {
        const parsed = failedTestRecordSchema.safeParse(JSON.parse(line))
        return parsed.success ? parsed.data : undefined
    } catch {
        return undefined
    }
}

export function dedupeFailedTests(records: FailedTestRecord[]) {
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

export function getFailureKey(record: FailedTestRecord) {
    return `${record.framework}\0${record.spec}\0${record.fullTitle}`
}
