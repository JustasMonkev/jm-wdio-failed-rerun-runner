import type {
    CucumberRerunSpecPlan,
    FailedRerunFramework,
    FailedTestRecord,
    MochaRerunSpecPlan,
    RerunSpecPlan
} from '#src/types.js'

export function createRerunSpecPlans(records: FailedTestRecord[]): RerunSpecPlan[] {
    const recordsByFrameworkAndSpec = groupByFrameworkAndSpec(records)

    return Array.from(recordsByFrameworkAndSpec.values()).map(createRerunSpecPlan)
}

export function buildExactTitleGrep(fullTitles: string[]) {
    const uniqueTitles = Array.from(new Set(fullTitles)).sort()
    return `^(?:${uniqueTitles.map(escapeRegExp).join('|')})$`
}

export function buildExactTitleRegExps(fullTitles: string[]) {
    return Array.from(new Set(fullTitles))
        .sort()
        .map((title) => new RegExp(`^${escapeRegExp(title)}$`))
}

function escapeRegExp(value: string) {
    return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function createRerunSpecPlan(tests: FailedTestRecord[]): RerunSpecPlan {
    const [firstTest] = tests
    if (firstTest.framework === 'cucumber') {
        return createCucumberRerunSpecPlan(firstTest.spec, tests)
    }

    return createMochaRerunSpecPlan(firstTest.spec, tests)
}

function createMochaRerunSpecPlan(spec: string, tests: FailedTestRecord[]): MochaRerunSpecPlan {
    return {
        framework: 'mocha',
        spec,
        tests,
        grep: buildExactTitleGrep(tests.map((test) => test.fullTitle))
    }
}

function createCucumberRerunSpecPlan(spec: string, tests: FailedTestRecord[]): CucumberRerunSpecPlan {
    return {
        framework: 'cucumber',
        spec,
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
