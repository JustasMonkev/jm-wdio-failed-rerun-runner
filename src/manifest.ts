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

// Last record wins WITHIN one execution: a test retried in-run is written more than once
// and the final entry reflects how it actually ended. Executions are keyed by worker as
// well as by title, because the same test runs once per capability in separate workers -
// collapsing those together would let one browser's pass erase another browser's failure.
// Insertion order is preserved so the manifest still reads chronologically.
export function dedupeFailedTests(records: FailedTestRecord[]) {
    const byIdentity = new Map<string, FailedTestRecord>()

    for (const record of records) {
        byIdentity.set(getRecordIdentity(record), record)
    }

    return Array.from(byIdentity.values())
}

// Identifies one execution of a test. Used for deduplication only.
export function getRecordIdentity(record: FailedTestRecord) {
    return `${getFailureKey(record)}\0${record.cid ?? ''}`
}

// Identifies a test across attempts. Deliberately excludes the worker id: a rerun runs in
// a fresh worker, so matching initial failures against rerun records must ignore it.
export function getFailureKey(record: FailedTestRecord) {
    return `${record.framework}\0${record.spec}\0${record.fullTitle}`
}
