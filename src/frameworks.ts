import type { Frameworks } from '@wdio/types'
import * as z from 'zod'

import { serializeError } from '#src/errors'
import type {
    FailedRerunAttemptType,
    FailedRerunFramework,
    FailedRerunOutcome,
    FailedTestRecord
} from '#src/types'

interface RecordContext {
    attempt: FailedRerunAttemptType
    cid?: string
    framework?: FailedRerunFramework
    outcome?: FailedRerunOutcome
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
})
// Deliberately not `.passthrough()`: nothing here reads beyond the declared keys, and
// passing unknown ones through means enumerating every own key of a framework-supplied
// object. An accessor throwing on a key this code never wanted would otherwise cost the
// failure record.

export function createMochaFailedTestRecord(
    test: Frameworks.Test,
    result: Frameworks.TestResult,
    context: RecordContext,
    testContext?: unknown
): FailedTestRecord | undefined {
    const framework = context.framework === 'jasmine' ? 'jasmine' : 'mocha'
    const spec = getSpecFile(test)
    const fullTitle = framework === 'jasmine'
        ? getJasmineFullTitle(test)
        : getMochaFullTitle(test, testContext)

    if (!spec || !fullTitle) {
        return undefined
    }

    return {
        attempt: context.attempt,
        framework,
        spec,
        fullTitle,
        title: test.title || parseNonEmptyString(readProperty(test, 'description')),
        cid: context.cid,
        ...passedOutcome(context),
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
        ...passedOutcome(context),
        error: serializeError(result.error)
    }
}

// A failure record carries no `outcome`, which keeps the manifest format unchanged for the
// records that existed before outcomes were tracked. A `passed` record is written for every
// test that completes, and does two jobs: during a focused rerun it is the evidence that a
// targeted test actually executed, and in any attempt it supersedes an earlier failure for
// the same test - which is how a WebdriverIO spec-file retry retires the attempt it replaced.
function passedOutcome(context: RecordContext) {
    return context.outcome === 'failed' || context.outcome === undefined
        ? {}
        : { outcome: context.outcome }
}

function getSpecFile(test: Frameworks.Test) {
    return parseNonEmptyString(test.file)
}

// `@wdio/jasmine-framework` hands `afterTest` a spread of Jasmine's own spec result,
// which carries `fullName` (what `jasmineOpts.grep` is matched against) and `description`
// rather than Mocha's `fullTitle`/`title`.
function getJasmineFullTitle(test: Frameworks.Test) {
    return parseNonEmptyString(readProperty(test, 'fullName'))
        || parseNonEmptyString(readProperty(test, 'fullTitle'))
}

function getMochaFullTitle(test: Frameworks.Test, testContext?: unknown) {
    const fromTest = resolveFullTitleFrom(test)
    if (fromTest) {
        return fromTest
    }

    // `@wdio/mocha-framework` builds the `afterTest` argument as
    // `{ ...context.test, parent: context.test?.parent?.title }`. That spread copies
    // only own enumerable properties, and Mocha's `fullTitle` is a prototype method,
    // so it never survives; `parent` is reduced to the immediate parent's title.
    // Rebuilding the title from `parent + title` therefore DROPS every outer
    // `describe`, and the resulting `mochaOpts.grep` cannot match the title Mocha
    // actually greps against. The live context still holds the real Runnable, whose
    // `fullTitle()` is exactly what Mocha filters on.
    const fromContext = resolveContextFullTitle(testContext)
    if (fromContext) {
        return fromContext
    }

    return parseNonEmptyString([test.parent, test.title].filter(Boolean).join(' '))
}

// `fullTitle` must be invoked AS A METHOD of the runnable that owns it: Mocha's
// implementation is `this.titlePath().join(' ')`, so calling a detached reference throws
// `this.titlePath is not a function` and takes the whole afterTest hook down with it.
function resolveFullTitleFrom(owner: unknown) {
    if (!owner || typeof owner !== 'object') {
        return undefined
    }

    const fullTitle = readProperty(owner, 'fullTitle') as FullTitle | undefined

    const stringTitle = parseNonEmptyString(fullTitle)
    if (stringTitle) {
        return stringTitle
    }

    if (!fullTitleCallbackSchema.safeParse(fullTitle).success) {
        return undefined
    }

    try {
        return parseNonEmptyString((owner as { fullTitle(): unknown }).fullTitle())
    } catch {
        // A framework whose accessor throws must not cost us the failure record.
        return undefined
    }
}

// Mocha exposes the running test as `this.test`; `afterEach`-style contexts use
// `this.currentTest` instead.
function resolveContextFullTitle(testContext: unknown) {
    if (!testContext || typeof testContext !== 'object') {
        return undefined
    }

    for (const key of ['test', 'currentTest'] as const) {
        const resolved = resolveFullTitleFrom(readProperty(testContext, key))
        if (resolved) {
            return resolved
        }
    }

    return undefined
}

function getCucumberScenarioName(world: Frameworks.World) {
    return getCucumberWorld(world)?.pickle?.name
}

function getCucumberSpecFile(world: Frameworks.World) {
    const cucumberWorld = getCucumberWorld(world)
    return cucumberWorld?.pickle?.uri || cucumberWorld?.gherkinDocument?.uri || cucumberWorld?.uri
}

function getCucumberWorld(world: Frameworks.World): CucumberScenarioWorld | undefined {
    try {
        // `safeParse` is only safe about the shape it finds, not about reading it: the
        // passthrough enumerates every own key, so an accessor that throws anywhere on the
        // world - `result` included - escapes as an exception and costs the failure record.
        const result = cucumberScenarioWorldSchema.safeParse(world)
        return result.success ? result.data : undefined
    } catch {
        return undefined
    }
}

// Every property here is read off a framework-supplied object, and a partially
// initialised or hostile runnable can expose an accessor that throws. Losing the
// afterTest hook to that would lose the failure the rerun exists to fix.
export function readProperty(value: object, key: string) {
    try {
        return (value as Record<string, unknown>)[key]
    } catch {
        return undefined
    }
}

function parseNonEmptyString(value: unknown) {
    const result = nonEmptyStringSchema.safeParse(value)
    return result.success ? result.data : undefined
}
