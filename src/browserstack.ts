import type { FailedRerunBrowserStackEnv } from '#src/types'

export const BROWSERSTACK_RERUN_ENV = 'BROWSERSTACK_RERUN'
export const BROWSERSTACK_RERUN_TESTS_ENV = 'BROWSERSTACK_RERUN_TESTS'

export const processBrowserStackEnv: FailedRerunBrowserStackEnv = {
    withRerun: runWithBrowserStackRerunEnv
}

async function runWithBrowserStackRerunEnv<T>(specs: string[], run: () => Promise<T>) {
    // The BrowserStack service splits BROWSERSTACK_RERUN_TESTS on commas, so a
    // spec path containing a comma cannot be represented; skip the rerun
    // marking instead of narrowing the run to bogus spec paths.
    if (specs.some((spec) => spec.includes(','))) {
        return run()
    }

    const previousValues = setBrowserStackRerunEnv(specs)

    try {
        return await run()
    } finally {
        restoreEnv(previousValues)
    }
}

function setBrowserStackRerunEnv(specs: string[]) {
    const previousValues = new Map<string, string | undefined>([
        [BROWSERSTACK_RERUN_ENV, process.env[BROWSERSTACK_RERUN_ENV]],
        [BROWSERSTACK_RERUN_TESTS_ENV, process.env[BROWSERSTACK_RERUN_TESTS_ENV]]
    ])

    process.env[BROWSERSTACK_RERUN_ENV] = 'true'
    process.env[BROWSERSTACK_RERUN_TESTS_ENV] = specs.join(',')

    return previousValues
}

function restoreEnv(previousValues: Map<string, string | undefined>) {
    for (const [name, value] of previousValues) {
        if (value === undefined) {
            delete process.env[name]
        } else {
            process.env[name] = value
        }
    }
}
