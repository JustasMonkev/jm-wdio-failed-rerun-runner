import type {
    CucumberRerunSpecPlan,
    JasmineRerunSpecPlan,
    FailedRerunFramework,
    FailedTestRecord,
    MochaRerunSpecPlan,
    RerunSpecPlan
} from '#src/types'

export function createRerunPlans(records: FailedTestRecord[]): RerunSpecPlan[] {
    return createRerunSpecPlans(records)
}

export function createRerunSpecPlans(records: FailedTestRecord[]): RerunSpecPlan[] {
    const recordsByFrameworkAndSpec = groupByFrameworkAndSpec(records)

    return Array.from(recordsByFrameworkAndSpec.values()).map(createRerunSpecPlan)
}

export function buildExactTitleGrep(fullTitles: string[]) {
    const uniqueTitles = Array.from(new Set(fullTitles)).sort()
    return `^(?:${uniqueTitles.map(escapeRegExp).join('|')})$`
}

// Cucumber's `name` filter is typed `string[]` and is handed to the launcher, which
// forwards it to worker processes over `childProcess.send()`. That uses Node's default
// JSON serialization, so a RegExp would arrive in the worker as `{}` and match nothing.
// Anchored strings survive the trip and are what WebdriverIO documents.
export function buildExactTitleFilters(fullTitles: string[]) {
    return Array.from(new Set(fullTitles))
        .sort()
        .map((title) => `^${escapeRegExp(title)}$`)
}

function escapeRegExp(value: string) {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function createRerunSpecPlan(tests: FailedTestRecord[]): RerunSpecPlan {
    const [firstTest] = tests
    if (firstTest.framework === 'cucumber') {
        return createCucumberRerunSpecPlan(firstTest.spec, tests)
    }

    if (firstTest.framework === 'jasmine') {
        return createJasmineRerunSpecPlan(firstTest.spec, tests)
    }

    return createMochaRerunSpecPlan(firstTest.spec, tests)
}

function createMochaRerunSpecPlan(spec: string, tests: FailedTestRecord[]): MochaRerunSpecPlan {
    return {
        framework: 'mocha',
        spec,
        specs: [spec],
        tests,
        grep: buildExactTitleGrep(tests.map((test) => test.fullTitle))
    }
}

function createJasmineRerunSpecPlan(spec: string, tests: FailedTestRecord[]): JasmineRerunSpecPlan {
    return {
        framework: 'jasmine',
        spec,
        specs: [spec],
        tests,
        grep: buildExactTitleGrep(tests.map((test) => test.fullTitle))
    }
}

function createCucumberRerunSpecPlan(spec: string, tests: FailedTestRecord[]): CucumberRerunSpecPlan {
    return {
        framework: 'cucumber',
        spec,
        specs: [spec],
        tests
    }
}

function groupByFrameworkAndSpec(records: FailedTestRecord[]) {
    const recordsByFrameworkAndSpec = new Map<string, FailedTestRecord[]>()

    for (const record of records) {
        const key = getGroupKey(record.framework, record.spec)
        const tests = recordsByFrameworkAndSpec.get(key)
        if (tests) {
            tests.push(record)
        } else {
            recordsByFrameworkAndSpec.set(key, [record])
        }
    }

    return recordsByFrameworkAndSpec
}

function getGroupKey(framework: FailedRerunFramework, spec: string) {
    return `${framework}\0${spec}`
}
