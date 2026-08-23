import { matchExecutionRecords } from '#src/manifest'
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

// A test that failed the initial run and passed a rerun is flaky; one that failed
// every time is broken. Separating them is the whole point of running a rerun: a
// build that is green only because of retries should still tell you what retried.
export function summarize(
    initialFailures: FailedTestRecord[],
    attempts: FailedRerunAttemptResult[]
): FailedRerunSummary {
    // A token follows one execution through the rounds. Matching prefers the exact slot
    // but can pair by fingerprint when a config reorder moves a capability. It is a
    // one-to-one match, so colliding fingerprints still produce separate tokens.
    const tokens: SummaryToken[] = initialFailures.map((record) => ({
        initial: true,
        record,
        current: record,
        state: 'pending'
    }))

    for (const attempt of attempts) {
        if (attempt.type !== 'rerun') {
            continue
        }

        const active = tokens.filter((token) => token.state !== 'passed')
        const targeted = matchExecutionRecords(active.map((token) => token.current), attempt.targeted)
        const failed = matchExecutionRecords(attempt.targeted, attempt.failures)
        const missing = matchExecutionRecords(attempt.targeted, attempt.notExecuted)
        const failedByTarget = new Map(failed.pairs.map((pair) => [pair.expectedIndex, pair.actual]))
        const missingTargets = new Set(missing.pairs.map((pair) => pair.expectedIndex))

        for (const pair of targeted.pairs) {
            const token = active[pair.expectedIndex]
            const targetIndex = pair.actualIndex

            if (missingTargets.has(targetIndex)) {
                token.current = pair.actual
                token.state = 'noResult'
                continue
            }

            const failure = failedByTarget.get(targetIndex)
            if (failure) {
                token.current = failure
                token.state = 'failed'
            } else {
                token.state = 'passed'
            }
        }

        // A rerun launches the spec under every configured capability, so it can surface
        // failures the initial run never reported. They keep the run red, so leaving them
        // out would make the summary contradict the exit code.
        for (const record of failed.unmatchedActual) {
            tokens.push({
                initial: false,
                record,
                current: record,
                state: 'failed'
            })
        }
    }

    return {
        flaky: tokens.filter((token) => token.initial && token.state === 'passed')
            .map((token) => token.record),
        broken: tokens.filter((token) => token.state === 'failed')
            .map((token) => token.record),
        notExecuted: tokens.filter((token) => token.state === 'noResult')
            .map((token) => token.current)
    }
}

interface SummaryToken {
    initial: boolean
    record: FailedTestRecord
    current: FailedTestRecord
    state: 'pending' | 'failed' | 'passed' | 'noResult'
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
