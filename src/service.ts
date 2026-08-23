import { createHash } from 'node:crypto'

import type { Frameworks, Services } from '@wdio/types'

import { appendFailedTest } from '#src/manifest'
import { failedRerunServiceOptionsSchema } from '#src/schemas'
import {
    createCucumberFailedScenarioRecord,
    createMochaFailedTestRecord,
    readProperty
} from '#src/frameworks'
import type { FailedRerunServiceOptions, FailedTestRecord } from '#src/types'

export default class FailedTestRerunService implements Services.ServiceInstance {
    readonly #capabilityFingerprint?: string
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
        this.#capabilityFingerprint = fingerprintCapabilities(capabilities)
    }

    // A skipped test reaches this hook as `passed: false`, and recording that as a failure
    // would queue a test that can never pass. It is recorded as a skip instead of dropped:
    // dropping it leaves an earlier failure for the same test standing as the manifest's
    // last word, so a `specFileRetries` attempt that ends in a skip could never retire the
    // failure it replaced. A skip still proves nothing about the test, so it never counts
    // as evidence that a focused rerun executed what it targeted.
    async afterTest(test: Frameworks.Test, context: unknown, result: Frameworks.TestResult) {
        const passed = Boolean(readProperty(result, 'passed'))
        const skipped = isSkipped(test, result)

        // The retry guard exists to keep a non-final attempt out of the manifest, so it
        // must only apply to something that will actually be retried. Neither a pass nor a
        // skip is: Mocha stamps its retry counters on every runnable, so a skipped test can
        // carry `_retries > 0` with `_currentRetry: 0` and look exactly like a first failed
        // attempt. Returning there would drop the skip, leaving an earlier failure for the
        // same test standing as the manifest's last word.
        if (!passed && !skipped && willBeRetriedByWdio(test, result)) {
            return
        }

        await this.#appendRecord(createMochaFailedTestRecord(
            test,
            result,
            this.#recordContext(passed, skipped),
            context
        ))
    }

    // `@wdio/cucumber-framework` reports a SKIPPED scenario as `passed: true`. Taking that
    // at face value would let a rerun whose scenario was skipped - by a tag filter, or a
    // Before hook that skips - be reported as a recovery, turning a failing build green.
    async afterScenario(world: Frameworks.World, result: Frameworks.PickleResult, _context: unknown) {
        const passed = Boolean(readProperty(result, 'passed'))
        const skipped = isSkippedScenario(world)

        if (!passed && !skipped && willBeRetriedByWdioScenario(world)) {
            return
        }

        await this.#appendRecord(createCucumberFailedScenarioRecord(
            world,
            result,
            this.#recordContext(passed, skipped)
        ))
    }

    #recordContext(passed?: boolean, skipped?: boolean) {
        return {
            attempt: this.options.attempt || 'initial',
            cid: process.env.WDIO_WORKER_ID,
            capabilityFingerprint: this.#capabilityFingerprint,
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
    return Boolean(readProperty(test, 'pending')) || Boolean(readProperty(result, 'skipped'))
}

function isSkippedScenario(world: Frameworks.World) {
    const status = readNestedProperty(world, 'result', 'status')
    // Checking the type rather than calling defensively: a status that is not a string
    // cannot be the marker, and this way a hostile `toUpperCase` is never reached.
    return typeof status === 'string' && status.toUpperCase() === 'SKIPPED'
}

// Only the final in-run attempt should decide whether a test lands in the manifest.
//
// `result.retries` cannot answer this on its own: @wdio/utils recurses inside
// `executeAsync` until the budget is spent before it ever returns, so by the time this
// hook runs `attempts` already equals `limit`. Mocha's own retry counters do survive on
// the test object as plain properties, and they are the reliable signal.
function willBeRetriedByWdio(test: Frameworks.Test, result: Frameworks.TestResult) {
    const currentRetry = readProperty(test, '_currentRetry')
    const retries = readProperty(test, '_retries')

    if (typeof currentRetry === 'number' && typeof retries === 'number' && currentRetry < retries) {
        return true
    }

    const attempts = readNestedProperty(result, 'retries', 'attempts')
    const limit = readNestedProperty(result, 'retries', 'limit')
    return typeof attempts === 'number' && typeof limit === 'number' && attempts < limit
}

// cucumber-js sets `willBeRetried` on the hook parameter itself; @wdio/types declares it
// nested under `result`, which is why reading only `result.willBeRetried` silently never
// matched. Accept both.
function willBeRetriedByWdioScenario(world: Frameworks.World) {
    const willBeRetried = readProperty(world, 'willBeRetried')
    return Boolean(willBeRetried ?? readNestedProperty(world, 'result', 'willBeRetried'))
}

// The nested reads have the same hazard as the shallow ones: `world.result` and
// `result.retries` are framework-supplied objects too, and an accessor throwing anywhere
// along the way would cost the failure record the rerun exists to fix.
function readNestedProperty(value: object, key: string, nestedKey: string) {
    const nested = readProperty(value, key)
    return nested && typeof nested === 'object' ? readProperty(nested, nestedKey) : undefined
}

// The worker id identifies only a slot in the current capability array, which a config
// may reorder between attempts. Hashing a canonical form follows the actual capability
// without writing credentials from vendor options into the manifest.
function fingerprintCapabilities(capabilities: WebdriverIO.Capabilities | undefined) {
    try {
        const serialized = JSON.stringify(capabilities, sortObjectKeys)
        if (!serialized || serialized === '{}') {
            return undefined
        }

        return createHash('sha256').update(serialized).digest('hex')
    } catch {
        return undefined
    }
}

function sortObjectKeys(_key: string, value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value
    }

    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
        sorted[key] = (value as Record<string, unknown>)[key]
    }
    return sorted
}
