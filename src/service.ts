import type { Frameworks, Services } from '@wdio/types'

import { appendFailedTest } from '#src/manifest.js'
import {
    createCucumberFailedScenarioRecord,
    createMochaFailedTestRecord
} from '#src/frameworks.js'
import type { FailedRerunServiceOptions, FailedTestRecord } from '#src/types.js'

export default class FailedTestRerunService implements Services.ServiceInstance {
    constructor(
        public readonly options: FailedRerunServiceOptions,
        public readonly capabilities?: WebdriverIO.Capabilities,
        public readonly config?: WebdriverIO.Config
    ) {
        if (!options.manifestPath) {
            throw new Error('FailedTestRerunService requires a manifestPath option')
        }
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
