import type { Services } from '@wdio/types'

export type FailedRerunAttemptType = 'initial' | 'rerun'
export type FailedRerunFramework = 'mocha' | 'cucumber'
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
    cucumberOpts?: WebdriverIO.CucumberOpts & {
        name?: RegExp[]
    }
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
    run?: FailedRerunRun
}

export type RerunSpecPlan = MochaRerunSpecPlan | CucumberRerunSpecPlan

interface RerunSpecPlanBase {
    framework: FailedRerunFramework
    spec: string
    tests: FailedTestRecord[]
}

export interface MochaRerunSpecPlan extends RerunSpecPlanBase {
    framework: 'mocha'
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
    grep: string
}

export interface FailedRerunCucumberRerunAttemptResult extends FailedRerunAttemptResultBase {
    type: 'rerun'
    framework: 'cucumber'
    spec: string
    name: string[]
}

export type FailedRerunAttemptResult =
    | FailedRerunInitialAttemptResult
    | FailedRerunMochaRerunAttemptResult
    | FailedRerunCucumberRerunAttemptResult

export interface FailedRerunResult {
    exitCode: number
    attempts: FailedRerunAttemptResult[]
    failures: FailedTestRecord[]
}
