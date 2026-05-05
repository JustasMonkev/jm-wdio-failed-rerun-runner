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

    async afterTest(test: Frameworks.Test, _context: unknown, result: Frameworks.TestResult) {
        if (result.passed) {
            return
        }

        await this.#appendRecord(createMochaFailedTestRecord(test, result, this.#recordContext()))
    }

    async afterScenario(world: Frameworks.World, result: Frameworks.PickleResult, _context: unknown) {
        if (result.passed) {
            return
        }

        await this.#appendRecord(createCucumberFailedScenarioRecord(world, result, this.#recordContext()))
    }

    #recordContext() {
        return {
            attempt: this.options.attempt || 'initial',
            cid: process.env.WDIO_WORKER_ID
        }
    }

    async #appendRecord(record: FailedTestRecord | undefined) {
        if (record) {
            await appendFailedTest(this.options.manifestPath, record)
        }
    }
}
