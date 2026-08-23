import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { processBrowserStackEnv } from '#src/browserstack'
import { runWdio } from '#src/launcher'
import {
    appendFailedTest,
    countUnreadableLines,
    dedupeFailedTests,
    getExecutionKey,
    readFailedTests,
    readManifest,
    resetManifest
} from '#src/manifest'
import { buildExactTitleFilters, createRerunSpecPlans } from '#src/planner'
import {
    consoleLogger,
    reportInitialFailures,
    reportRerunStart,
    reportUnreadableManifest,
    reportSummary,
    summarize
} from '#src/reporter'
import type { FailedRerunLogger } from '#src/reporter'
import type {
    FailedRerunAttemptResult,
    FailedRerunAttemptType,
    FailedRerunBrowserStackEnv,
    FailedRerunRetryEnv,
    FailedRerunRun,
    FailedRerunRunArgs,
    FailedRerunResult,
    FailedRerunSummary,
    FailedTestManifestStore,
    FailedTestRecord,
    FailedTestsRerunOptions,
    FailedTestsRerunner,
    FailedTestsRerunnerDeps,
    RerunPlan
} from '#src/types'

interface RerunSettings {
    args: FailedRerunRunArgs
    // Accumulates manifest lines that could not be read, across every attempt.
    unreadable: { lines: number }
    // Manifests this run invented a temp path for. A path the caller supplied is their
    // artifact and is left alone; these are internal scratch and must not pile up in the
    // temp directory, since a green run now records every passing test.
    generatedManifests: string[]
    logger: FailedRerunLogger
    browserstackEnv: FailedRerunBrowserStackEnv
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

// Each rerun round launches WebdriverIO once per failing spec group, so an absurd count is
// always a mistake rather than intent. Without a ceiling a permanently failing test would
// rerun effectively forever.
export const MAX_RERUNS_LIMIT = 100

// WebdriverIO resolves bare service names as `@wdio/<name>-service` or
// `wdio-<name>-service`, so the only name-independent way to self-inject
// the worker service is an absolute path, which the plugin loader imports
// directly as a file URL.
export const FAILED_RERUN_SERVICE_PATH = fileURLToPath(new URL('./index.js', import.meta.url))

const fileSystemManifestStore: FailedTestManifestStore = {
    reset: resetManifest,
    read: readFailedTests,
    readAll: readManifest,
    append: appendFailedTest,
    countUnreadable: countUnreadableLines
}

const processRetryEnv: FailedRerunRetryEnv = {
    withRetry: runWithRetryEnv
}

const silentLogger: FailedRerunLogger = {
    log: () => {}
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

    if (!options.manifestPath) {
        settings.generatedManifests.push(settings.manifestPath)
    }

    try {
        return await runWithSettings(configPath, settings)
    } finally {
        await removeGeneratedManifests(settings)
    }
}

// Deleting through the store keeps a substituted adapter in charge of its own storage.
async function removeGeneratedManifests(settings: RerunSettings) {
    for (const manifestPath of settings.generatedManifests) {
        await settings.manifests.reset(manifestPath).catch(() => {})
    }
}

async function runWithSettings(
    configPath: string,
    settings: RerunSettings
): Promise<FailedRerunResult> {
    const initialAttempt = await runInitialAttempt(configPath, settings)
    const attempts: FailedRerunAttemptResult[] = [initialAttempt]

    if (!shouldRerun(initialAttempt, settings.maxReruns)) {
        reportUnreadableManifest(settings.unreadable.lines, settings.logger)

        return createResult(
            settings.unreadable.lines > 0 ? initialAttempt.exitCode || 1 : initialAttempt.exitCode,
            attempts,
            initialAttempt.failures,
            summarize(initialAttempt.failures, attempts)
        )
    }

    reportInitialFailures(initialAttempt.failures, settings.logger)

    const reruns = await runRerunRounds(configPath, settings, initialAttempt.failures, attempts)
    await writeCombinedRerunManifest(settings, attempts)
    const result = createRerunResult(
        initialAttempt.exitCode,
        attempts,
        reruns,
        settings.passOnSuccessfulRerun,
        summarize(initialAttempt.failures, attempts),
        settings.unreadable.lines
    )

    reportUnreadableManifest(settings.unreadable.lines, settings.logger)
    reportSummary(result, settings.logger)

    return result
}

function createRerunSettings(
    options: FailedTestsRerunOptions,
    deps: FailedTestsRerunnerDeps
): RerunSettings {
    const cwd = options.cwd || process.cwd()

    return {
        args: options.args || {},
        unreadable: { lines: 0 },
        generatedManifests: [],
        browserstackEnv: deps.browserstackEnv || processBrowserStackEnv,
        cwd,
        manifestPath: resolveManifestPath(options.manifestPath, cwd, 'initial'),
        manifests: deps.manifests || fileSystemManifestStore,
        logger: options.quiet ? silentLogger : (deps.logger || consoleLogger),
        maxReruns: clampMaxReruns(options.maxReruns),
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

// The CLI validates this, but the programmatic API takes a plain number. A non-finite or
// absurd count would loop the rerun rounds effectively forever, launching WebdriverIO each
// time, so clamp it to the same ceiling the CLI enforces.
function clampMaxReruns(maxReruns: number | undefined) {
    if (maxReruns === undefined) {
        return 1
    }

    if (!Number.isFinite(maxReruns) || maxReruns < 0) {
        return 0
    }

    return Math.min(Math.floor(maxReruns), MAX_RERUNS_LIMIT)
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

    const plans = createRerunSpecPlans(failures)
    reportRerunStart(round, settings.maxReruns, plans, settings.logger)

    for (const [index, plan] of plans.entries()) {
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
    plan: RerunPlan
): Promise<FailedRerunAttemptResult> {
    const manifestPath = resolveManifestPath(settings.rerunManifestPath, settings.cwd, `rerun-${round}-${index}`)
    if (!settings.rerunManifestPath) {
        settings.generatedManifests.push(manifestPath)
    }
    await settings.manifests.reset(manifestPath)

    const exitCode = await settings.retryEnv.withRetry(
        round + 1,
        () => settings.browserstackEnv.withRerun(
            plan.specs,
            () => normalizeExitCode(settings.run(configPath, createRerunArgs(settings.args, plan, manifestPath)))
        )
    )
    await countUnreadable(settings, manifestPath)
    const { records, canVerifyExecution } = await readRerunRecords(settings, manifestPath)
    const notExecuted = canVerifyExecution ? findTestsThatDidNotRun(plan, records) : []
    // Deduplicate first: filtering passes out beforehand would discard the very record
    // that supersedes an earlier failure. The built-in store already returns deduplicated
    // records, but `readAll` is documented as every record a rerun wrote, and a custom
    // adapter honouring that literally would otherwise keep a recovered test failing.
    const failures = dedupeFailedTests(records).filter((record) => record.outcome !== 'passed')

    const rerunAttempt = {
        exitCode,
        failures,
        targeted: plan.tests,
        notExecuted,
        spec: plan.spec,
        specs: plan.specs,
        type: 'rerun' as const
    }

    if (plan.framework === 'mocha' || plan.framework === 'jasmine') {
        return {
            ...rerunAttempt,
            framework: plan.framework,
            grep: plan.grep
        }
    }

    return {
        ...rerunAttempt,
        framework: 'cucumber',
        name: buildExactTitleFilters(plan.tests.map((test) => test.fullTitle))
    }
}

function createRerunArgs(baseArgs: FailedRerunRunArgs, plan: RerunPlan, manifestPath: string) {
    const frameworkArgs = plan.framework === 'cucumber'
        ? createCucumberRerunArgs(baseArgs, plan)
        : createTitleGrepRerunArgs(baseArgs, plan)

    return withFailureService(frameworkArgs, {
        manifestPath,
        attempt: 'rerun'
    })
}

// Mocha and Jasmine both filter by full test name, under their own options key.
// Jasmine matches `jasmineOpts.grep` against `spec.getFullName()` with `new RegExp(grep)`,
// so the same anchored pattern works for both.
function createTitleGrepRerunArgs(
    baseArgs: FailedRerunRunArgs,
    plan: Extract<RerunPlan, { framework: 'mocha' | 'jasmine' }>
) {
    if (plan.framework === 'jasmine') {
        return {
            ...baseArgs,
            spec: plan.specs,
            jasmineOpts: {
                ...(baseArgs.jasmineOpts || {}),
                grep: plan.grep,
                // A project that inverts its own grep would otherwise keep the inversion
                // and have this filter EXCLUDE the very test being retried, running
                // everything else instead. The focused filter names exactly what must run.
                invertGrep: false
            }
        }
    }

    return {
        ...baseArgs,
        spec: plan.specs,
        mochaOpts: {
            ...(baseArgs.mochaOpts || {}),
            grep: plan.grep,
            invert: false
        }
    }
}

function createCucumberRerunArgs(baseArgs: FailedRerunRunArgs, plan: Extract<RerunPlan, { framework: 'cucumber' }>) {
    return {
        ...baseArgs,
        spec: plan.specs,
        cucumberOpts: {
            ...(baseArgs.cucumberOpts || {}),
            name: buildExactTitleFilters(plan.tests.map((test) => test.fullTitle))
        }
    }
}

function isHardFailure(attempt: FailedRerunAttemptResult) {
    if (attempt.type === 'rerun' && attempt.notExecuted.length > 0) {
        return true
    }

    return attempt.exitCode !== 0 && attempt.failures.length === 0
}

function createRerunResult(
    initialExitCode: number,
    attempts: FailedRerunAttemptResult[],
    reruns: RerunSummary,
    passOnSuccessfulRerun: boolean,
    summary: FailedRerunSummary,
    unreadableLines: number
) {
    // A manifest we could not fully read may have described a failure that is now
    // invisible, so nothing here proves the suite is healthy.
    const rerunsPassed = unreadableLines === 0
        && !reruns.hadHardFailure
        && reruns.failures.length === 0
        && reruns.lastExitCode === 0
    const exitCode = getFinalExitCode(rerunsPassed, initialExitCode, passOnSuccessfulRerun)

    return createResult(exitCode, attempts, reruns.failures, summary)
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

function createResult(
    exitCode: number,
    attempts: FailedRerunAttemptResult[],
    failures: FailedTestRecord[],
    summary: FailedRerunSummary
) {
    return {
        exitCode,
        attempts,
        failures,
        summary
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
            [FAILED_RERUN_SERVICE_PATH, options]
        ]
    }
}

async function readManifestFailures(settings: RerunSettings, manifestPath: string) {
    await countUnreadable(settings, manifestPath)
    return dedupeFailedTests(await settings.manifests.read(manifestPath))
}

async function countUnreadable(settings: RerunSettings, manifestPath: string) {
    const count = await settings.manifests.countUnreadable?.(manifestPath)
    settings.unreadable.lines += count ?? 0
}

// `--rerun-manifest-path` is documented as a build artifact, so the literal path the user
// gave must end up holding every rerun failure, not just whichever group happened to run last.
async function writeCombinedRerunManifest(settings: RerunSettings, attempts: FailedRerunAttemptResult[]) {
    const append = settings.manifests.append?.bind(settings.manifests)
    if (!settings.rerunManifestPath || !append) {
        return
    }

    const failures = dedupeFailedTests(
        attempts.flatMap((attempt) => attempt.type === 'rerun' ? attempt.failures : [])
    )
    const combinedPath = path.isAbsolute(settings.rerunManifestPath)
        ? settings.rerunManifestPath
        : path.resolve(settings.cwd, settings.rerunManifestPath)

    await settings.manifests.reset(combinedPath)
    for (const failure of failures) {
        await append(combinedPath, failure)
    }
}

async function readRerunRecords(settings: RerunSettings, manifestPath: string) {
    const readAll = settings.manifests.readAll?.bind(settings.manifests)
    if (!readAll) {
        return {
            records: await settings.manifests.read(manifestPath),
            canVerifyExecution: false
        }
    }

    return {
        records: await readAll(manifestPath),
        canVerifyExecution: true
    }
}

// A focused rerun narrows the run with a title filter. If that filter matches nothing -
// a stale or mis-reconstructed title, a spec the config excludes, an unresolvable path -
// the framework exits 0 having run no tests, and an empty manifest is indistinguishable
// from "everything passed". Treating that as success turns a red build green, so a test
// the rerun never executed stays a failure.
function findTestsThatDidNotRun(plan: RerunPlan, records: FailedTestRecord[]) {
    const executed = new Set(records.map(getExecutionKey))
    return plan.tests.filter((test) => !executed.has(getExecutionKey(test)))
}

async function normalizeExitCode(exitCode: ReturnType<FailedRerunRun>) {
    return (await exitCode) ?? 0
}

function resolveManifestPath(manifestPath: string | undefined, cwd: string, label: string) {
    if (!manifestPath) {
        return path.join(os.tmpdir(), `wdio-failed-rerun-${randomUUID()}-${label}.ndjson`)
    }

    const absolute = path.isAbsolute(manifestPath)
        ? manifestPath
        : path.resolve(cwd, manifestPath)

    if (label === 'initial') {
        return absolute
    }

    // Each rerun group needs its own file: they are reset before every group, so sharing
    // one path would leave only the last group's failures behind, and reading a shared
    // file would let one group's records vouch for another group's tests.
    const extension = path.extname(absolute)
    return `${absolute.slice(0, absolute.length - extension.length)}.${label}${extension}`
}
