import type { Frameworks, Services } from '@wdio/types'

import { appendFailedTest } from '#src/manifest'
import { failedRerunServiceOptionsSchema } from '#src/schemas'
import {
    createCucumberFailedScenarioRecord,
    createMochaFailedTestRecord
} from '#src/frameworks'
import type { FailedRerunServiceOptions, FailedTestRecord } from '#src/types'

export default class FailedTestRerunService implements Services.ServiceInstance {
    public readonly options: FailedRerunServiceOptions
    public readonly capabilities?: WebdriverIO.Capabilities
    public readonly config?: WebdriverIO.Config

    constructor(
        options: FailedRerunServiceOptions,
        capabilities?: WebdriverIO.Capabilities,
        config?: WebdriverIO.Config
    ) {
        const parsedOptions = failedRerunServiceOptionsSchema.safeParse(options)
        if (!parsedOptions.success) {
            throw new Error(parsedOptions.error.issues[0]?.message || 'Invalid FailedTestRerunService options')
        }

        this.options = parsedOptions.data
        this.capabilities = capabilities
        this.config = config
    }

    // A skipped test reaches this hook as `passed: false`, and recording that as a failure
    // would queue a test that can never pass. It is recorded as a skip instead of dropped:
    // dropping it leaves an earlier failure for the same test standing as the manifest's
    // last word, so a `specFileRetries` attempt that ends in a skip could never retire the
    // failure it replaced. A skip still proves nothing about the test, so it never counts
    // as evidence that a focused rerun executed what it targeted.
    async afterTest(test: Frameworks.Test, context: unknown, result: Frameworks.TestResult) {
        // A passing test is never retried, so the retry guard must not apply to it.
        if (!result.passed && willBeRetriedByWdio(test, result)) {
            return
        }

        await this.#appendRecord(createMochaFailedTestRecord(
            test,
            result,
            this.#recordContext(result.passed, isSkipped(test, result)),
            context
        ))
    }

    // `@wdio/cucumber-framework` reports a SKIPPED scenario as `passed: true`. Taking that
    // at face value would let a rerun whose scenario was skipped - by a tag filter, or a
    // Before hook that skips - be reported as a recovery, turning a failing build green.
    async afterScenario(world: Frameworks.World, result: Frameworks.PickleResult, _context: unknown) {
        if (!result.passed && willBeRetriedByWdioScenario(world)) {
            return
        }

        await this.#appendRecord(createCucumberFailedScenarioRecord(
            world,
            result,
            this.#recordContext(result.passed, isSkippedScenario(world))
        ))
    }

    #recordContext(passed?: boolean, skipped?: boolean) {
        return {
            attempt: this.options.attempt || 'initial',
            cid: process.env.WDIO_WORKER_ID,
            framework: this.#framework(),
            outcome: skipped ? 'skipped' as const : (passed ? 'passed' as const : 'failed' as const)
        }
    }

    // Mocha and Jasmine share the `afterTest` hook but expose different fields and take
    // different filter options, and the hook payload alone cannot tell them apart. The
    // resolved WebdriverIO config can.
    #framework() {
        return this.config?.framework === 'jasmine' ? 'jasmine' as const : 'mocha' as const
    }

    async #appendRecord(record: FailedTestRecord | undefined) {
        if (record) {
            await appendFailedTest(this.options.manifestPath, record)
        }
    }
}

// WebdriverIO derives `skipped` by string-matching the error a framework throws to signal
// a skip, which can miss. Mocha and Jasmine also mark the test itself as pending, and that
// flag comes from the framework rather than from a message match, so consult both.
function isSkipped(test: Frameworks.Test, result: Frameworks.TestResult) {
    const { pending } = test as { pending?: boolean }
    return Boolean(pending) || Boolean((result as { skipped?: boolean }).skipped)
}

function isSkippedScenario(world: Frameworks.World) {
    const { result } = world as { result?: { status?: string } }
    return result?.status?.toUpperCase() === 'SKIPPED'
}

// Only the final in-run attempt should decide whether a test lands in the manifest.
//
// `result.retries` cannot answer this on its own: @wdio/utils recurses inside
// `executeAsync` until the budget is spent before it ever returns, so by the time this
// hook runs `attempts` already equals `limit`. Mocha's own retry counters do survive on
// the test object as plain properties, and they are the reliable signal.
function willBeRetriedByWdio(test: Frameworks.Test, result: Frameworks.TestResult) {
    const { _currentRetry: currentRetry, _retries: retries } = test as {
        _currentRetry?: number
        _retries?: number
    }

    if (typeof currentRetry === 'number' && typeof retries === 'number' && currentRetry < retries) {
        return true
    }

    return Boolean(result.retries && result.retries.attempts < result.retries.limit)
}

// cucumber-js sets `willBeRetried` on the hook parameter itself; @wdio/types declares it
// nested under `result`, which is why reading only `result.willBeRetried` silently never
// matched. Accept both.
function willBeRetriedByWdioScenario(world: Frameworks.World) {
    const { willBeRetried } = world as { willBeRetried?: boolean }
    return Boolean(willBeRetried ?? world.result?.willBeRetried)
}
