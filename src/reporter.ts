import { getExecutionKey } from '#src/manifest'
import type {
    FailedRerunAttemptResult,
    FailedRerunResult,
    FailedRerunSummary,
    FailedTestRecord
} from '#src/types'

const PREFIX = '[wdio-failed-rerun]'

export interface FailedRerunLogger {
    log(message: string): void
}

export const consoleLogger: FailedRerunLogger = {
    log: (message) => console.log(message)
}

// Scoped to the capability for the same reason the execution check is: a test that
// recovered under one capability says nothing about another that never ran.
export function getFailureKeyForSummary(record: FailedTestRecord) {
    return getExecutionKey(record)
}

// A test that failed the initial run and passed a rerun is flaky; one that failed
// every time is broken. Separating them is the whole point of running a rerun: a
// build that is green only because of retries should still tell you what retried.
export function summarize(
    initialFailures: FailedTestRecord[],
    attempts: FailedRerunAttemptResult[]
): FailedRerunSummary {
    // Rounds run in order, so the last attempt that targeted a test is the one that says
    // how it ended. Accumulating instead would keep an early round's failure forever and
    // report a test that later recovered as broken while the run exits 0.
    const latest = new Map<string, 'failed' | 'passed' | 'noResult'>()
    const noResultRecords = new Map<string, FailedTestRecord>()
    const failedRecords = new Map<string, FailedTestRecord>()

    for (const attempt of attempts) {
        if (attempt.type !== 'rerun') {
            continue
        }

        const failed = new Set(attempt.failures.map(getFailureKeyForSummary))
        const missing = new Set(attempt.notExecuted.map(getFailureKeyForSummary))

        for (const record of attempt.targeted) {
            const key = getFailureKeyForSummary(record)

            if (missing.has(key)) {
                latest.set(key, 'noResult')
                noResultRecords.set(key, record)
                continue
            }

            noResultRecords.delete(key)
            latest.set(key, failed.has(key) ? 'failed' : 'passed')
        }

        // A rerun launches the spec under every configured capability, so it can surface
        // failures the initial run never reported. They keep the run red, so leaving them
        // out would make the summary contradict the exit code.
        for (const record of attempt.failures) {
            const key = getFailureKeyForSummary(record)
            failedRecords.set(key, record)
            latest.set(key, 'failed')
        }
    }

    const flaky: FailedTestRecord[] = []
    const broken: FailedTestRecord[] = []
    const classified = new Set<string>()

    for (const record of initialFailures) {
        classified.add(getFailureKeyForSummary(record))
        // A test no rerun ever targeted - `maxReruns: 0`, or a round that stopped early -
        // recovered from nothing, so it is neither flaky nor proven broken.
        switch (latest.get(getFailureKeyForSummary(record))) {
            case 'passed':
                flaky.push(record)
                break
            case 'failed':
                broken.push(record)
                break
            default:
                break
        }
    }

    for (const [key, record] of failedRecords) {
        if (!classified.has(key) && latest.get(key) === 'failed') {
            broken.push(record)
        }
    }

    return {
        flaky,
        broken,
        notExecuted: Array.from(noResultRecords.values())
    }
}

export function reportInitialFailures(failures: FailedTestRecord[], logger: FailedRerunLogger) {
    const specs = new Set(failures.map((failure) => failure.spec))
    logger.log(`${PREFIX} initial run failed: ${count(failures.length, 'test')} across ${count(specs.size, 'spec')}`)
}

export function reportRerunStart(
    round: number,
    maxReruns: number,
    plans: Array<{ spec: string, tests: FailedTestRecord[] }>,
    logger: FailedRerunLogger
) {
    const specs = plans
        .map((plan) => `${basename(plan.spec)} (${count(plan.tests.length, 'test')})`)
        .join(', ')
    logger.log(`${PREFIX} rerun ${round + 1}/${maxReruns}: ${specs}`)
}

export function reportUnreadableManifest(lines: number, logger: FailedRerunLogger) {
    if (lines === 0) {
        return
    }

    logger.log(`${PREFIX} ${count(lines, 'manifest line')} could not be read: a failure may be missing, so this run cannot be reported as passing`)
}

export function reportSummary(result: FailedRerunResult, logger: FailedRerunLogger) {
    const { flaky, broken, notExecuted } = result.summary
    const parts = [`${count(flaky.length, 'flaky test')} (passed on rerun)`, `${broken.length} still failing`]

    if (notExecuted.length > 0) {
        parts.push(`${notExecuted.length} never ran`)
    }

    logger.log(`${PREFIX} summary: ${parts.join(', ')}`)

    for (const record of flaky) {
        logger.log(`${PREFIX}   flaky:  ${record.fullTitle}`)
    }

    for (const record of broken) {
        logger.log(`${PREFIX}   broken: ${record.fullTitle}`)
    }

    // The rerun recorded no outcome for these - its filter matched nothing, or it failed
    // without reporting which test. Either way it proves nothing about them, so say that
    // rather than implying they passed.
    for (const record of notExecuted) {
        logger.log(`${PREFIX}   no result: ${record.fullTitle} (the rerun recorded no outcome for it)`)
    }
}

function basename(spec: string) {
    const normalized = spec.replace(/\\/g, '/')
    return normalized.slice(normalized.lastIndexOf('/') + 1) || spec
}

function count(value: number, noun: string) {
    return `${value} ${noun}${value === 1 ? '' : 's'}`
}
