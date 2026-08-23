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
// A capability fingerprint stays attached to the browser when a config replaces or
// reorders its capability array between attempts. The slot supplements it here so equal
// fingerprints remain distinct while deduplicating one manifest; cross-attempt matching
// below can then pair them one-to-one. Older records have no fingerprint, so they fall
// back to WebdriverIO's cid. Its `<capabilityIndex>-<runCounter>` form requires dropping
// the run counter: that part changes for every fresh worker and spec-file retry.
export function getExecutionKey(record: FailedTestRecord) {
    const slot = getCapabilityId(record.cid)
    const capability = record.capabilityFingerprint
        ? `fingerprint:${record.capabilityFingerprint}\0slot:${slot}`
        : `slot:${slot}`
    return `${getFailureKey(record)}\0${capability}`
}

// Match evidence to the executions it can vouch for. The exact fingerprint+slot key is
// tried first so one of two colliding capabilities cannot steal the other's evidence.
// Any records left over may match by fingerprint alone: that is what lets a unique
// capability follow a config reorder between attempts. Matching is one-to-one, so two
// equal fingerprints still require two records before both executions are considered run.
export function matchExecutionRecords(expected: FailedTestRecord[], actual: FailedTestRecord[]) {
    const matchedActual = new Set<number>()
    const actualByExactKey = indexRecords(actual, getExecutionKey)
    const matches = new Map<number, number>()

    for (const [expectedIndex, record] of expected.entries()) {
        const actualIndex = takeUnmatched(actualByExactKey.get(getExecutionKey(record)), matchedActual)
        if (actualIndex !== undefined) {
            matches.set(expectedIndex, actualIndex)
        }
    }

    const actualByFingerprint = indexRecords(actual, getFingerprintExecutionKey, matchedActual)
    for (const [expectedIndex, record] of expected.entries()) {
        if (matches.has(expectedIndex)) {
            continue
        }

        const fingerprintKey = getFingerprintExecutionKey(record)
        if (!fingerprintKey) {
            continue
        }

        const actualIndex = takeUnmatched(actualByFingerprint.get(fingerprintKey), matchedActual)
        if (actualIndex !== undefined) {
            matches.set(expectedIndex, actualIndex)
        }
    }

    return {
        pairs: Array.from(matches.entries())
            .sort(([left], [right]) => left - right)
            .map(([expectedIndex, actualIndex]) => ({
                expected: expected[expectedIndex],
                expectedIndex,
                actual: actual[actualIndex],
                actualIndex
            })),
        unmatchedExpected: expected.filter((_record, index) => !matches.has(index)),
        unmatchedActual: actual.filter((_record, index) => !matchedActual.has(index))
    }
}

function indexRecords(
    records: FailedTestRecord[],
    getKey: (record: FailedTestRecord) => string | undefined,
    excluded = new Set<number>()
) {
    const indexed = new Map<string, number[]>()

    for (const [index, record] of records.entries()) {
        if (excluded.has(index)) {
            continue
        }

        const key = getKey(record)
        if (!key) {
            continue
        }

        const indices = indexed.get(key)
        if (indices) {
            indices.push(index)
        } else {
            indexed.set(key, [index])
        }
    }

    return indexed
}

function takeUnmatched(indices: number[] | undefined, matched: Set<number>) {
    if (!indices) {
        return undefined
    }

    while (indices.length > 0) {
        const index = indices.shift()!
        if (!matched.has(index)) {
            matched.add(index)
            return index
        }
    }

    return undefined
}

function getFingerprintExecutionKey(record: FailedTestRecord) {
    return record.capabilityFingerprint
        ? `${getFailureKey(record)}\0fingerprint:${record.capabilityFingerprint}`
        : undefined
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
