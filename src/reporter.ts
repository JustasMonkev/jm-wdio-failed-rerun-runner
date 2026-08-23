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

export function getFailureKeyForSummary(record: FailedTestRecord) {
    return `${record.framework}\0${record.spec}\0${record.fullTitle}`
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

    for (const attempt of attempts) {
        if (attempt.type !== 'rerun') {
            continue
        }

        const failed = new Set(attempt.failures.map(getFailureKeyForSummary))
        const missing = new Set(attempt.notExecuted.map(getFailureKeyForSummary))
        // The run reported failure yet recorded nothing: it crashed, or records collided
        // because two tests share a full title. Either way it says nothing about whether
        // the targeted tests recovered, so it must not be read as a pass.
        const inconclusive = attempt.exitCode !== 0 && attempt.failures.length === 0

        for (const record of attempt.targeted) {
            const key = getFailureKeyForSummary(record)

            if (missing.has(key) || (inconclusive && !failed.has(key))) {
                latest.set(key, 'noResult')
                noResultRecords.set(key, record)
                continue
            }

            noResultRecords.delete(key)
            latest.set(key, failed.has(key) ? 'failed' : 'passed')
        }
    }

    const flaky: FailedTestRecord[] = []
    const broken: FailedTestRecord[] = []

    for (const record of initialFailures) {
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
