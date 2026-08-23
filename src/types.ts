import type { Services } from '@wdio/types'

import type { FailedRerunLogger } from '#src/reporter'

export type FailedRerunAttemptType = 'initial' | 'rerun'
export type FailedRerunOutcome = 'failed' | 'passed'
export type FailedRerunFramework = 'mocha' | 'jasmine' | 'cucumber'
export type FailedRerunJsonValue =
    | string
    | number
    | boolean
    | null
    | FailedRerunJsonValue[]
    | { [key: string]: FailedRerunJsonValue }

export interface FailedTestRecord {
    attempt: FailedRerunAttemptType
    framework: FailedRerunFramework
    spec: string
    fullTitle: string
    title?: string
    cid?: string
    // Absent on manifests written before outcome tracking existed; those only ever
    // contained failures, so a missing value reads as 'failed'.
    outcome?: FailedRerunOutcome
    error?: FailedTestError
}

export interface FailedTestError {
    name?: string
    message?: string
    stack?: string
    cause?: FailedRerunJsonValue
    details?: Record<string, FailedRerunJsonValue>
}

export interface FailedRerunServiceOptions {
    manifestPath: string
    attempt?: FailedRerunAttemptType
}

export interface FailedRerunRunArgs {
    spec?: string[]
    services?: Services.ServiceEntry[]
    mochaOpts?: WebdriverIO.MochaOpts
    jasmineOpts?: WebdriverIO.JasmineOpts
    cucumberOpts?: WebdriverIO.CucumberOpts
    [key: string]: unknown
}

export type FailedRerunRun = (
    configPath: string,
    args: FailedRerunRunArgs
) => Promise<number | undefined>

export interface FailedTestsRerunOptions {
    args?: FailedRerunRunArgs
    cwd?: string
    manifestPath?: string
    rerunManifestPath?: string
    maxReruns?: number
    passOnSuccessfulRerun?: boolean
    quiet?: boolean
    run?: FailedRerunRun
}

export interface FailedTestsRerunner {
    run(configPath: string, options?: FailedTestsRerunOptions): Promise<FailedRerunResult>
}

export interface FailedTestsRerunnerDeps {
    logger?: FailedRerunLogger
    run?: FailedRerunRun
    manifests?: FailedTestManifestStore
    retryEnv?: FailedRerunRetryEnv
    browserstackEnv?: FailedRerunBrowserStackEnv
}

export interface FailedTestManifestStore {
    reset(manifestPath: string): Promise<void>
    read(manifestPath: string): Promise<FailedTestRecord[]>
    // Every record a rerun wrote, passed ones included, so the runner can prove which
    // targeted tests actually executed. Optional so existing custom stores keep compiling,
    // but a store that omits it CANNOT distinguish "the rerun passed" from "the rerun's
    // filter matched nothing", so execution verification is skipped and a rerun that ran
    // no tests will be reported as a pass. Implement it whenever that matters.
    readAll?(manifestPath: string): Promise<FailedTestRecord[]>
}

export interface FailedRerunRetryEnv {
    withRetry<T>(retry: number, run: () => Promise<T>): Promise<T>
}

export interface FailedRerunBrowserStackEnv {
    withRerun<T>(specs: string[], run: () => Promise<T>): Promise<T>
}

export type RerunSpecPlan = MochaRerunSpecPlan | JasmineRerunSpecPlan | CucumberRerunSpecPlan
export type RerunPlan = RerunSpecPlan
export type MochaRerunPlan = MochaRerunSpecPlan
export type JasmineRerunPlan = JasmineRerunSpecPlan
export type CucumberRerunPlan = CucumberRerunSpecPlan

interface RerunSpecPlanBase {
    framework: FailedRerunFramework
    spec: string
    specs: string[]
    tests: FailedTestRecord[]
}

export interface MochaRerunSpecPlan extends RerunSpecPlanBase {
    framework: 'mocha'
    grep: string
}

export interface JasmineRerunSpecPlan extends RerunSpecPlanBase {
    framework: 'jasmine'
    grep: string
}

export interface CucumberRerunSpecPlan extends RerunSpecPlanBase {
    framework: 'cucumber'
}

interface FailedRerunAttemptResultBase {
    type: FailedRerunAttemptType
    exitCode: number
    failures: FailedTestRecord[]
}

export interface FailedRerunInitialAttemptResult extends FailedRerunAttemptResultBase {
    type: 'initial'
}

export interface FailedRerunMochaRerunAttemptResult extends FailedRerunAttemptResultBase {
    type: 'rerun'
    framework: 'mocha'
    spec: string
    specs: string[]
    // Targeted tests the rerun never executed, i.e. tests the filter failed to match.
    notExecuted: FailedTestRecord[]
    grep: string
}

export interface FailedRerunJasmineRerunAttemptResult extends FailedRerunAttemptResultBase {
    type: 'rerun'
    framework: 'jasmine'
    spec: string
    specs: string[]
    notExecuted: FailedTestRecord[]
    grep: string
}

export interface FailedRerunCucumberRerunAttemptResult extends FailedRerunAttemptResultBase {
    type: 'rerun'
    framework: 'cucumber'
    spec: string
    specs: string[]
    notExecuted: FailedTestRecord[]
    name: string[]
}

export type FailedRerunAttemptResult =
    | FailedRerunInitialAttemptResult
    | FailedRerunMochaRerunAttemptResult
    | FailedRerunJasmineRerunAttemptResult
    | FailedRerunCucumberRerunAttemptResult

export interface FailedRerunSummary {
    // Failed the initial run, passed a rerun.
    flaky: FailedTestRecord[]
    // Failed the initial run and every rerun.
    broken: FailedTestRecord[]
    // Targeted by a rerun that never executed them, so the rerun proves nothing.
    notExecuted: FailedTestRecord[]
}

export interface FailedRerunResult {
    exitCode: number
    attempts: FailedRerunAttemptResult[]
    failures: FailedTestRecord[]
    summary: FailedRerunSummary
}
