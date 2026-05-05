import type { Frameworks } from '@wdio/types'
import * as z from 'zod'

import { serializeError } from '#src/errors'
import type {
    FailedRerunAttemptType,
    FailedTestRecord
} from '#src/types'

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

const nonEmptyStringSchema = z.string().min(1)
const fullTitleCallbackSchema = z.custom<() => string>((value) => typeof value === 'function')
const cucumberScenarioWorldSchema: z.ZodType<CucumberScenarioWorld> = z.object({
    gherkinDocument: z.object({
        uri: z.string().optional()
    }).optional(),
    pickle: z.object({
        name: z.string().optional(),
        uri: z.string().optional()
    }).optional(),
    uri: z.string().optional()
}).passthrough()

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
    return parseNonEmptyString(test.file)
}

function getMochaFullTitle(test: Frameworks.Test) {
    const fullTitle = readProperty(test, 'fullTitle') as FullTitle | undefined
    const stringTitle = parseNonEmptyString(fullTitle)

    if (stringTitle) {
        return stringTitle
    }

    const callbackTitle = fullTitleCallbackSchema.safeParse(fullTitle)
    if (callbackTitle.success) {
        return parseNonEmptyString(callbackTitle.data())
    }

    return parseNonEmptyString([test.parent, test.title].filter(Boolean).join(' '))
}

function getCucumberScenarioName(world: Frameworks.World) {
    return getCucumberWorld(world)?.pickle?.name
}

function getCucumberSpecFile(world: Frameworks.World) {
    const cucumberWorld = getCucumberWorld(world)
    return cucumberWorld?.pickle?.uri || cucumberWorld?.gherkinDocument?.uri || cucumberWorld?.uri
}

function getCucumberWorld(world: Frameworks.World): CucumberScenarioWorld | undefined {
    const result = cucumberScenarioWorldSchema.safeParse(world)
    return result.success ? result.data : undefined
}

function readProperty(value: object, key: string) {
    return (value as Record<string, unknown>)[key]
}

function parseNonEmptyString(value: unknown) {
    const result = nonEmptyStringSchema.safeParse(value)
    return result.success ? result.data : undefined
}
