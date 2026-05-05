import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import FailedTestRerunService, { FAILED_RERUN_RETRY_ENV, runFailedTestsRerun } from '#src/index'
import type { FailedRerunRunArgs, FailedRerunServiceOptions } from '#src/types'

type RecordedRun = {
    configPath: string
    args: FailedRerunRunArgs
}

const tempDirs: string[] = []

async function makeTempDir() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-'))
    tempDirs.push(tempDir)
    return tempDir
}

function getServiceOptions(args: FailedRerunRunArgs) {
    const service = args.services?.find((entry) => Array.isArray(entry) && entry[0] === '@wdio/failed-rerun-runner')
    expect(service).toBeDefined()
    return (service as ['@wdio/failed-rerun-runner', FailedRerunServiceOptions])[1]
}

async function recordFailedTest(args: FailedRerunRunArgs, specFile: string, fullTitle: string) {
    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
    await service.afterTest({
        title: fullTitle.split(' ').at(-1) || fullTitle,
        fullTitle,
        file: specFile
    } as any, {}, {
        passed: false,
        duration: 1,
        retries: { attempts: 0, limit: 0 }
    } as any)
}

async function recordFailedScenario(args: FailedRerunRunArgs, featureFile: string, scenarioName: string) {
    const service = new FailedTestRerunService(getServiceOptions(args), {}, {} as WebdriverIO.Config)
    await service.afterScenario({
        pickle: {
            name: scenarioName,
            uri: featureFile
        }
    } as any, {
        passed: false,
        duration: 1,
        error: 'Scenario failed'
    }, {})
}

describe('failed test rerun integration', () => {
    afterEach(async () => {
        while (tempDirs.length > 0) {
            await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
        }
    })

    it('reruns only failed tests after a failed initial run', async () => {
        const workspace = await makeTempDir()
        const firstSpec = path.join(workspace, 'specs', 'checkout.e2e.ts')
        const secondSpec = path.join(workspace, 'specs', 'account.e2e.ts')
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedTest(args, firstSpec, 'checkout rejects expired card')
                    await recordFailedTest(args, secondSpec, 'account updates profile')
                    return 1
                }

                return 0
            }
        })

        expect(result.exitCode).toBe(0)
        expect(runs).toHaveLength(3)
        expect(runs[1].args.spec).toEqual([firstSpec])
        expect(runs[1].args.mochaOpts?.grep).toBe('^(?:checkout rejects expired card)$')
        expect(runs[2].args.spec).toEqual([secondSpec])
        expect(runs[2].args.mochaOpts?.grep).toBe('^(?:account updates profile)$')
    })

    it('exposes retry count as zero on the initial run and one on the first rerun', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'flaky-mobile.e2e.ts')
        const retries: Array<string | undefined> = []
        const previousRetry = process.env[FAILED_RERUN_RETRY_ENV]

        process.env[FAILED_RERUN_RETRY_ENV] = 'outside'

        try {
            const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
                cwd: workspace,
                run: async (configPath, args) => {
                    retries.push(process.env[FAILED_RERUN_RETRY_ENV])

                    if (retries.at(-1) === '0') {
                        await recordFailedTest(args, spec, 'flaky mobile action recovers')
                        return 1
                    }

                    return 0
                }
            })

            expect(result.exitCode).toBe(0)
            expect(retries).toEqual(['0', '1'])
            expect(process.env[FAILED_RERUN_RETRY_ENV]).toBe('outside')
        } finally {
            if (previousRetry === undefined) {
                delete process.env[FAILED_RERUN_RETRY_ENV]
            } else {
                process.env[FAILED_RERUN_RETRY_ENV] = previousRetry
            }
        }
    })

    it('narrows later rerun rounds to tests that still fail', async () => {
        const workspace = await makeTempDir()
        const firstSpec = path.join(workspace, 'specs', 'checkout.e2e.ts')
        const secondSpec = path.join(workspace, 'specs', 'account.e2e.ts')
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            maxReruns: 2,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedTest(args, firstSpec, 'checkout rejects expired card')
                    await recordFailedTest(args, secondSpec, 'account updates profile')
                    return 1
                }

                if (runs.length === 3) {
                    await recordFailedTest(args, secondSpec, 'account updates profile')
                    return 1
                }

                return 0
            }
        })

        expect(result.exitCode).toBe(0)
        expect(runs).toHaveLength(4)
        expect(runs[3].args.spec).toEqual([secondSpec])
        expect(runs[3].args.mochaOpts?.grep).toBe('^(?:account updates profile)$')
    })

    it('preserves BrowserStack Appium mobile settings when rerunning a failed Mocha test', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'mobile-checkout.e2e.ts')
        const browserstackService = ['browserstack', {
            app: {
                id: 'bs://mobile-app-id'
            },
            browserstackLocal: true,
            opts: {
                localIdentifier: 'mobile-build-42'
            }
        }]
        const mobileCapability = {
            platformName: 'Android',
            browserName: '',
            'appium:automationName': 'UiAutomator2',
            'appium:deviceName': 'Google Pixel 8',
            'appium:platformVersion': '14.0',
            'appium:app': 'bs://mobile-app-id',
            'bstack:options': {
                projectName: 'Mobile Checkout',
                buildName: 'Nightly Android',
                sessionName: 'checkout flow'
            }
        }
        const mobileArgs: FailedRerunRunArgs = {
            user: 'browserstack-user',
            key: 'browserstack-key',
            hostname: 'hub.browserstack.com',
            protocol: 'https',
            services: [browserstackService as any],
            capabilities: [mobileCapability],
            mochaOpts: {
                ui: 'bdd',
                timeout: 120000
            }
        }
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.browserstack.appium.conf.ts'), {
            args: mobileArgs,
            cwd: workspace,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedTest(args, spec, 'mobile checkout accepts wallet payment')
                    return 1
                }

                return 0
            }
        })

        expect(result.exitCode).toBe(0)
        expect(runs).toHaveLength(2)
        expect(runs[0].args.capabilities).toEqual([mobileCapability])
        expect(runs[1].args.capabilities).toEqual([mobileCapability])
        expect(runs[1].args).toMatchObject({
            user: 'browserstack-user',
            key: 'browserstack-key',
            hostname: 'hub.browserstack.com',
            protocol: 'https',
            spec: [spec]
        })
        expect(runs[1].args.services?.[0]).toEqual(browserstackService)
        expect(runs[1].args.services).toHaveLength(2)
        expect(runs[1].args.mochaOpts).toEqual({
            ui: 'bdd',
            timeout: 120000,
            grep: '^(?:mobile checkout accepts wallet payment)$'
        })
    })

    it('preserves local Appium server settings when rerunning a failed Cucumber scenario', async () => {
        const workspace = await makeTempDir()
        const feature = path.join(workspace, 'features', 'mobile-login.feature')
        const appiumCapability = {
            platformName: 'iOS',
            browserName: '',
            'appium:automationName': 'XCUITest',
            'appium:deviceName': 'iPhone 15',
            'appium:platformVersion': '17.0',
            'appium:app': path.join(workspace, 'apps', 'Demo.app')
        }
        const appiumArgs: FailedRerunRunArgs = {
            hostname: '127.0.0.1',
            port: 4723,
            path: '/',
            protocol: 'http',
            capabilities: [appiumCapability],
            cucumberOpts: {
                timeout: 90000,
                tagExpression: '@mobile'
            }
        }
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.appium.conf.ts'), {
            args: appiumArgs,
            cwd: workspace,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedScenario(args, feature, 'mobile login accepts biometrics')
                    return 1
                }

                return 0
            }
        })

        expect(result.exitCode).toBe(0)
        expect(runs).toHaveLength(2)
        expect(runs[0].args.capabilities).toEqual([appiumCapability])
        expect(runs[1].args.capabilities).toEqual([appiumCapability])
        expect(runs[1].args).toMatchObject({
            hostname: '127.0.0.1',
            port: 4723,
            path: '/',
            protocol: 'http',
            spec: [feature]
        })
        expect(runs[1].args.cucumberOpts?.timeout).toBe(90000)
        expect(runs[1].args.cucumberOpts?.tagExpression).toBe('@mobile')
        expect(runs[1].args.cucumberOpts?.name?.map(String)).toEqual([
            '/^mobile login accepts biometrics$/'
        ])
    })

    it('keeps the initial failure when no failed tests were recorded', async () => {
        const workspace = await makeTempDir()
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            run: async (configPath, args) => {
                runs.push({ configPath, args })
                return 1
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.failures).toEqual([])
        expect(result.attempts).toHaveLength(1)
        expect(runs).toHaveLength(1)
    })

    it('keeps a rerun failure when the rerun records no failed tests', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'checkout.e2e.ts')
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedTest(args, spec, 'checkout rejects expired card')
                }

                return 1
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.failures).toEqual([])
        expect(result.attempts).toHaveLength(2)
        expect(runs).toHaveLength(2)
    })

    it('does not hide a hard rerun failure behind another recorded failure', async () => {
        const workspace = await makeTempDir()
        const firstSpec = path.join(workspace, 'specs', 'checkout.e2e.ts')
        const secondSpec = path.join(workspace, 'specs', 'account.e2e.ts')
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            maxReruns: 2,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedTest(args, firstSpec, 'checkout rejects expired card')
                    await recordFailedTest(args, secondSpec, 'account updates profile')
                    return 1
                }

                if (runs.length === 3) {
                    await recordFailedTest(args, secondSpec, 'account updates profile')
                }

                return 1
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.attempts).toHaveLength(3)
        expect(runs).toHaveLength(3)
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].spec).toBe(secondSpec)
    })

    it('can preserve the initial failing exit code after successful reruns', async () => {
        const workspace = await makeTempDir()
        const spec = path.join(workspace, 'specs', 'checkout.e2e.ts')
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            passOnSuccessfulRerun: false,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedTest(args, spec, 'checkout rejects expired card')
                    return 1
                }

                return 0
            }
        })

        expect(result.exitCode).toBe(1)
        expect(result.failures).toEqual([])
        expect(result.attempts).toHaveLength(2)
    })

    it('reruns failed Cucumber scenarios with cucumberOpts.name', async () => {
        const workspace = await makeTempDir()
        const feature = path.join(workspace, 'features', 'checkout.feature')
        const runs: RecordedRun[] = []

        const result = await runFailedTestsRerun(path.join(workspace, 'wdio.conf.ts'), {
            cwd: workspace,
            run: async (configPath, args) => {
                runs.push({ configPath, args })

                if (runs.length === 1) {
                    await recordFailedScenario(args, feature, 'checkout rejects expired card')
                    return 1
                }

                return 0
            }
        })

        expect(result.exitCode).toBe(0)
        expect(runs).toHaveLength(2)
        expect(runs[1].args.spec).toEqual([feature])
        expect(runs[1].args.cucumberOpts?.name?.map(String)).toEqual([
            '/^checkout rejects expired card$/'
        ])
    })
})
