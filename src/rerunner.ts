import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { runWdio } from '#src/launcher.js'
import { readFailedTests, resetManifest } from '#src/manifest.js'
import { buildExactTitleRegExps, createRerunSpecPlans } from '#src/planner.js'
import type {
    FailedRerunAttemptResult,
    FailedRerunAttemptType,
    FailedRerunRetryEnv,
    FailedRerunRun,
    FailedRerunRunArgs,
    FailedRerunResult,
    FailedTestManifestStore,
    FailedTestRecord,
    FailedTestsRerunOptions,
    FailedTestsRerunner,
    FailedTestsRerunnerDeps,
    RerunSpecPlan
} from '#src/types.js'

interface RerunSettings {
    args: FailedRerunRunArgs
    cwd: string
    manifestPath: string
    manifests: FailedTestManifestStore
    maxReruns: number
    passOnSuccessfulRerun: boolean
    rerunManifestPath?: string
    retryEnv: FailedRerunRetryEnv
    run: FailedRerunRun
}

interface RerunRoundResult {
    exitCode: number
    failures: FailedTestRecord[]
    hadHardFailure: boolean
}

interface RerunSummary {
    failures: FailedTestRecord[]
    hadHardFailure: boolean
    lastExitCode: number
}

export const FAILED_RERUN_RETRY_ENV = 'WDIO_FAILED_RERUN_RETRY'

const fileSystemManifestStore: FailedTestManifestStore = {
    reset: resetManifest,
    read: readFailedTests
}

const processRetryEnv: FailedRerunRetryEnv = {
    withRetry: runWithRetryEnv
}

export function createFailedTestsRerunner(deps: FailedTestsRerunnerDeps = {}): FailedTestsRerunner {
    return {
        run: (configPath, options = {}) => runFailedTestsRerunWithDeps(configPath, options, deps)
    }
}

export const runFailedTestsRerun = createFailedTestsRerunner().run

async function runFailedTestsRerunWithDeps(
    configPath: string,
    options: FailedTestsRerunOptions,
    deps: FailedTestsRerunnerDeps
): Promise<FailedRerunResult> {
    const settings = createRerunSettings(options, deps)
    const initialAttempt = await runInitialAttempt(configPath, settings)
    const attempts: FailedRerunAttemptResult[] = [initialAttempt]

    if (!shouldRerun(initialAttempt, settings.maxReruns)) {
        return createResult(initialAttempt.exitCode, attempts, initialAttempt.failures)
    }

    const reruns = await runRerunRounds(configPath, settings, initialAttempt.failures, attempts)
    return createRerunResult(initialAttempt.exitCode, attempts, reruns, settings.passOnSuccessfulRerun)
}

function createRerunSettings(
    options: FailedTestsRerunOptions,
    deps: FailedTestsRerunnerDeps
): RerunSettings {
    const cwd = options.cwd || process.cwd()

    return {
        args: options.args || {},
        cwd,
        manifestPath: resolveManifestPath(options.manifestPath, cwd, 'initial'),
        manifests: deps.manifests || fileSystemManifestStore,
        maxReruns: options.maxReruns ?? 1,
        passOnSuccessfulRerun: options.passOnSuccessfulRerun ?? true,
        rerunManifestPath: options.rerunManifestPath,
        retryEnv: deps.retryEnv || processRetryEnv,
        run: options.run || deps.run || runWdio
    }
}

async function runInitialAttempt(configPath: string, settings: RerunSettings): Promise<FailedRerunAttemptResult> {
    await settings.manifests.reset(settings.manifestPath)

    const args = withFailureService(settings.args, {
        manifestPath: settings.manifestPath,
        attempt: 'initial'
    })
    const exitCode = await settings.retryEnv.withRetry(
        0,
        () => normalizeExitCode(settings.run(configPath, args))
    )

    return {
        type: 'initial',
        exitCode,
        failures: await readManifestFailures(settings, settings.manifestPath)
    }
}

function shouldRerun(initialAttempt: FailedRerunAttemptResult, maxReruns: number) {
    return initialAttempt.exitCode !== 0 && initialAttempt.failures.length > 0 && maxReruns > 0
}

async function runRerunRounds(
    configPath: string,
    settings: RerunSettings,
    initialFailures: FailedTestRecord[],
    attempts: FailedRerunAttemptResult[]
): Promise<RerunSummary> {
    let failures = initialFailures
    let lastExitCode = 0
    let hadHardFailure = false

    for (let round = 0; round < settings.maxReruns && failures.length > 0; round++) {
        const result = await runRerunRound(configPath, settings, round, failures, attempts)

        failures = result.failures
        lastExitCode = result.exitCode
        hadHardFailure = hadHardFailure || result.hadHardFailure

        if (result.hadHardFailure) {
            break
        }
    }

    return {
        failures,
        hadHardFailure,
        lastExitCode
    }
}

async function runRerunRound(
    configPath: string,
    settings: RerunSettings,
    round: number,
    failures: FailedTestRecord[],
    attempts: FailedRerunAttemptResult[]
): Promise<RerunRoundResult> {
    const nextFailures: FailedTestRecord[] = []
    let roundExitCode = 0
    let hadHardFailure = false

    for (const [index, plan] of createRerunSpecPlans(failures).entries()) {
        const attempt = await runRerunPlan(configPath, settings, round, index, plan)

        attempts.push(attempt)
        roundExitCode = roundExitCode || attempt.exitCode
        nextFailures.push(...attempt.failures)
        hadHardFailure = hadHardFailure || isHardFailure(attempt)
    }

    return {
        exitCode: roundExitCode,
        failures: nextFailures,
        hadHardFailure
    }
}

async function runRerunPlan(
    configPath: string,
    settings: RerunSettings,
    round: number,
    index: number,
    plan: RerunSpecPlan
): Promise<FailedRerunAttemptResult> {
    const manifestPath = resolveManifestPath(settings.rerunManifestPath, settings.cwd, `rerun-${round}-${index}`)
    await settings.manifests.reset(manifestPath)

    const exitCode = await settings.retryEnv.withRetry(
        round + 1,
        () => normalizeExitCode(settings.run(configPath, createRerunArgs(settings.args, plan, manifestPath)))
    )
    const failures = await readManifestFailures(settings, manifestPath)

    const rerunAttempt = {
        exitCode,
        failures,
        spec: plan.spec,
        type: 'rerun' as const
    }

    if (plan.framework === 'mocha') {
        return {
            ...rerunAttempt,
            framework: 'mocha',
            grep: plan.grep
        }
    }

    return {
        ...rerunAttempt,
        framework: 'cucumber',
        name: buildExactTitleRegExps(plan.tests.map((test) => test.fullTitle)).map(String)
    }
}

function createRerunArgs(baseArgs: FailedRerunRunArgs, plan: RerunSpecPlan, manifestPath: string) {
    const frameworkArgs = plan.framework === 'cucumber'
        ? createCucumberRerunArgs(baseArgs, plan)
        : createMochaRerunArgs(baseArgs, plan)

    return withFailureService(frameworkArgs, {
        manifestPath,
        attempt: 'rerun'
    })
}

function createMochaRerunArgs(baseArgs: FailedRerunRunArgs, plan: Extract<RerunSpecPlan, { framework: 'mocha' }>) {
    return {
        ...baseArgs,
        spec: [plan.spec],
        mochaOpts: {
            ...(baseArgs.mochaOpts || {}),
            grep: plan.grep
        }
    }
}

function createCucumberRerunArgs(baseArgs: FailedRerunRunArgs, plan: Extract<RerunSpecPlan, { framework: 'cucumber' }>) {
    return {
        ...baseArgs,
        spec: [plan.spec],
        cucumberOpts: {
            ...(baseArgs.cucumberOpts || {}),
            name: buildExactTitleRegExps(plan.tests.map((test) => test.fullTitle))
        }
    }
}

function isHardFailure(attempt: FailedRerunAttemptResult) {
    return attempt.exitCode !== 0 && attempt.failures.length === 0
}

function createRerunResult(
    initialExitCode: number,
    attempts: FailedRerunAttemptResult[],
    reruns: RerunSummary,
    passOnSuccessfulRerun: boolean
) {
    const rerunsPassed = !reruns.hadHardFailure && reruns.failures.length === 0 && reruns.lastExitCode === 0
    const exitCode = getFinalExitCode(rerunsPassed, initialExitCode, passOnSuccessfulRerun)

    return createResult(exitCode, attempts, reruns.failures)
}

function getFinalExitCode(rerunsPassed: boolean, initialExitCode: number, passOnSuccessfulRerun: boolean) {
    if (!rerunsPassed) {
        return 1
    }

    return passOnSuccessfulRerun ? 0 : initialExitCode
}

async function runWithRetryEnv<T>(retry: number, run: () => Promise<T>) {
    const previousRetry = process.env[FAILED_RERUN_RETRY_ENV]
    process.env[FAILED_RERUN_RETRY_ENV] = String(retry)

    try {
        return await run()
    } finally {
        if (previousRetry === undefined) {
            delete process.env[FAILED_RERUN_RETRY_ENV]
        } else {
            process.env[FAILED_RERUN_RETRY_ENV] = previousRetry
        }
    }
}

function createResult(exitCode: number, attempts: FailedRerunAttemptResult[], failures: FailedTestRecord[]) {
    return {
        exitCode,
        attempts,
        failures
    }
}

function withFailureService(args: FailedRerunRunArgs, options: {
    manifestPath: string
    attempt: FailedRerunAttemptType
}): FailedRerunRunArgs {
    return {
        ...args,
        services: [
            ...(args.services || []),
            ['@wdio/failed-rerun-runner', options]
        ]
    }
}

async function readManifestFailures(settings: RerunSettings, manifestPath: string) {
    return dedupeFailedTests(await settings.manifests.read(manifestPath))
}

function dedupeFailedTests(records: FailedTestRecord[]) {
    const seen = new Set<string>()
    const deduped: FailedTestRecord[] = []

    for (const record of records) {
        const key = getFailureKey(record)
        if (seen.has(key)) {
            continue
        }
        seen.add(key)
        deduped.push(record)
    }

    return deduped
}

function getFailureKey(record: FailedTestRecord) {
    return `${record.framework}\0${record.spec}\0${record.fullTitle}`
}

async function normalizeExitCode(exitCode: ReturnType<FailedRerunRun>) {
    return (await exitCode) ?? 0
}

function resolveManifestPath(manifestPath: string | undefined, cwd: string, label: string) {
    if (manifestPath) {
        return path.isAbsolute(manifestPath)
            ? manifestPath
            : path.resolve(cwd, manifestPath)
    }

    return path.join(os.tmpdir(), `wdio-failed-rerun-${randomUUID()}-${label}.ndjson`)
}
