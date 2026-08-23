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
    return (await readManifest(manifestPath)).filter(isUnresolvedFailure)
}

// Only a recorded failure keeps a test queued. A pass or a skip retires it: both mean the
// last thing that happened to this test under this capability was not a failure.
export function isUnresolvedFailure(record: FailedTestRecord) {
    return record.outcome !== 'passed' && record.outcome !== 'skipped'
}

// A skipped test did not run, so it can never stand as proof that a focused rerun executed
// what it targeted.
export function provesExecution(record: FailedTestRecord) {
    return record.outcome !== 'skipped'
}

// Skipping an unreadable line keeps one bad write from destroying the whole run, but the
// failure it described is then invisible: rerunning only what survived and passing would
// report success for a test that was never retried. The caller needs to know the manifest
// was incomplete so it can refuse to call the run green.
export async function countUnreadableLines(manifestPath: string): Promise<number> {
    try {
        const content = await fs.readFile(manifestPath, 'utf8')
        return content
            .split('\n')
            .filter(Boolean)
            .filter((line) => !parseManifestLine(line))
            .length
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return 0
        }
        throw error
    }
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

// Last record wins within one capability: a test can be written more than once - an in-run
// retry, or a spec-file retry that WebdriverIO runs in a fresh worker - and the final entry
// reflects how it actually ended. Keying by capability rather than by worker is what makes
// both collapse correctly, while still keeping separate capabilities apart so one browser's
// pass cannot erase another browser's failure. Insertion order is preserved so the manifest
// still reads chronologically.
export function dedupeFailedTests(records: FailedTestRecord[]) {
    const byIdentity = new Map<string, FailedTestRecord>()

    for (const record of records) {
        byIdentity.set(getExecutionKey(record), record)
    }

    return Array.from(byIdentity.values())
}

// Identifies one test under one capability. Used both to deduplicate records and to match
// a rerun's records against the failures it targeted.
//
// WebdriverIO's cid is `<capabilityIndex>-<runCounter>`, and only the capability index
// carries meaning here. The counter changes whenever a new worker starts - a focused
// rerun, or a `specFileRetries` attempt - so keying on the whole cid would both make every
// rerun look like it ran nothing and keep a stale failure alive after WebdriverIO's own
// retry passed. Ignoring the cid entirely would instead let one capability's pass vouch
// for another capability that never ran.
export function getExecutionKey(record: FailedTestRecord) {
    return `${getFailureKey(record)}\0${getCapabilityId(record.cid)}`
}

function getCapabilityId(cid: string | undefined) {
    if (!cid) {
        return ''
    }

    const separator = cid.indexOf('-')
    return separator === -1 ? cid : cid.slice(0, separator)
}

// Identifies a test across attempts, ignoring which worker ran it.
export function getFailureKey(record: FailedTestRecord) {
    return `${record.framework}\0${record.spec}\0${record.fullTitle}`
}
