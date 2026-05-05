import type { Frameworks } from '@wdio/types'

import { serializeError } from '#src/errors.js'
import type {
    FailedRerunAttemptType,
    FailedTestRecord
} from '#src/types.js'

interface RecordContext {
    attempt: FailedRerunAttemptType
    cid?: string
}

type FullTitle = string | (() => string)

interface CucumberScenarioWorld {
    gherkinDocument?: {
        uri?: string
    }
    pickle?: {
        name?: string
        uri?: string
    }
    uri?: string
}

export function createMochaFailedTestRecord(
    test: Frameworks.Test,
    result: Frameworks.TestResult,
    context: RecordContext
): FailedTestRecord | undefined {
    const spec = getSpecFile(test)
    const fullTitle = getMochaFullTitle(test)

    if (!spec || !fullTitle) {
        return undefined
    }

    return {
        attempt: context.attempt,
        framework: 'mocha',
        spec,
        fullTitle,
        title: test.title,
        cid: context.cid,
        error: serializeError(result.error)
    }
}

export function createCucumberFailedScenarioRecord(
    world: Frameworks.World,
    result: Frameworks.PickleResult,
    context: RecordContext
): FailedTestRecord | undefined {
    const spec = getCucumberSpecFile(world)
    const scenarioName = getCucumberScenarioName(world)

    if (!spec || !scenarioName) {
        return undefined
    }

    return {
        attempt: context.attempt,
        framework: 'cucumber',
        spec,
        fullTitle: scenarioName,
        title: scenarioName,
        cid: context.cid,
        error: serializeError(result.error)
    }
}

function getSpecFile(test: Frameworks.Test) {
    return typeof test.file === 'string' ? test.file : undefined
}

function getMochaFullTitle(test: Frameworks.Test) {
    const fullTitle = readProperty(test, 'fullTitle') as FullTitle | undefined

    if (typeof fullTitle === 'string' && fullTitle) {
        return fullTitle
    }

    if (typeof fullTitle === 'function') {
        return fullTitle() || undefined
    }

    return [test.parent, test.title].filter(Boolean).join(' ') || undefined
}

function getCucumberScenarioName(world: Frameworks.World) {
    return getCucumberWorld(world)?.pickle?.name
}

function getCucumberSpecFile(world: Frameworks.World) {
    const cucumberWorld = getCucumberWorld(world)
    return cucumberWorld?.pickle?.uri || cucumberWorld?.gherkinDocument?.uri || cucumberWorld?.uri
}

function getCucumberWorld(world: Frameworks.World): CucumberScenarioWorld | undefined {
    return isObject(world) ? world : undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object'
}

function readProperty(value: object, key: string) {
    return (value as Record<string, unknown>)[key]
}
