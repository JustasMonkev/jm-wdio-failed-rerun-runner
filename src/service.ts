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

    async afterTest(test: Frameworks.Test, context: unknown, result: Frameworks.TestResult) {
        if (willBeRetriedByWdio(result)) {
            return
        }

        if (result.passed && !this.#recordsPassedTests()) {
            return
        }

        await this.#appendRecord(createMochaFailedTestRecord(
            test,
            result,
            this.#recordContext(result.passed),
            context
        ))
    }

    async afterScenario(world: Frameworks.World, result: Frameworks.PickleResult, _context: unknown) {
        if (willBeRetriedByWdioScenario(world)) {
            return
        }

        if (result.passed && !this.#recordsPassedTests()) {
            return
        }

        await this.#appendRecord(createCucumberFailedScenarioRecord(
            world,
            result,
            this.#recordContext(result.passed)
        ))
    }

    // During a focused rerun the runner must be able to prove that the tests it
    // targeted actually executed: a filter that matches nothing produces an empty
    // manifest, which is indistinguishable from "everything passed". Recording
    // passed tests too is only affordable here because a rerun's test set is small
    // by construction, so the initial run still records failures only.
    #recordsPassedTests() {
        return this.options.attempt === 'rerun'
    }

    #recordContext(passed?: boolean) {
        return {
            attempt: this.options.attempt || 'initial',
            cid: process.env.WDIO_WORKER_ID,
            outcome: passed ? 'passed' as const : 'failed' as const
        }
    }

    async #appendRecord(record: FailedTestRecord | undefined) {
        if (record) {
            await appendFailedTest(this.options.manifestPath, record)
        }
    }
}

// WDIO retries the test in-run when `retries` is configured; only the final
// attempt should decide whether the test lands in the rerun manifest.
function willBeRetriedByWdio(result: Frameworks.TestResult) {
    return Boolean(result.retries && result.retries.attempts < result.retries.limit)
}

function willBeRetriedByWdioScenario(world: Frameworks.World) {
    return Boolean(world.result?.willBeRetried)
}
