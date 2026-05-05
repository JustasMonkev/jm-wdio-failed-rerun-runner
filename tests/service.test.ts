import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readFailedTests } from '#src/manifest.js'
import FailedTestRerunService from '#src/service.js'

const tempDirs: string[] = []

async function makeManifestPath() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-service-'))
    tempDirs.push(tempDir)
    return path.join(tempDir, 'failed.ndjson')
}

describe('FailedTestRerunService', () => {
    afterEach(async () => {
        while (tempDirs.length > 0) {
            await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
        }
    })

    it('records a failed Mocha test with serializable error details', async () => {
        const manifestPath = await makeManifestPath()
        const error = new Error('Payment declined', {
            cause: {
                code: 'card_declined'
            }
        }) as Error & {
            metadata: {
                attempt: number
                labels: string[]
            }
        }
        error.name = 'CheckoutError'
        error.metadata = {
            attempt: 2,
            labels: ['payment', 'retry']
        }

        const service = new FailedTestRerunService({
            manifestPath,
            attempt: 'rerun'
        }, {}, {} as WebdriverIO.Config)

        await service.afterTest({
            title: 'rejects expired card',
            fullTitle: () => 'checkout rejects expired card',
            file: '/repo/specs/checkout.e2e.ts'
        } as any, {}, {
            passed: false,
            duration: 12,
            error,
            retries: { attempts: 1, limit: 1 }
        } as any)

        expect(await readFailedTests(manifestPath)).toEqual([
            {
                attempt: 'rerun',
                framework: 'mocha',
                spec: '/repo/specs/checkout.e2e.ts',
                fullTitle: 'checkout rejects expired card',
                title: 'rejects expired card',
                error: {
                    name: 'CheckoutError',
                    message: 'Payment declined',
                    stack: expect.any(String),
                    cause: {
                        code: 'card_declined'
                    },
                    details: {
                        metadata: {
                            attempt: 2,
                            labels: ['payment', 'retry']
                        }
                    }
                }
            }
        ])
    })

    it('does not record passed tests', async () => {
        const manifestPath = await makeManifestPath()
        const service = new FailedTestRerunService({
            manifestPath
        }, {}, {} as WebdriverIO.Config)

        await service.afterTest({
            title: 'passes',
            fullTitle: 'checkout passes',
            file: '/repo/specs/checkout.e2e.ts'
        } as any, {}, {
            passed: true,
            duration: 1,
            retries: { attempts: 0, limit: 0 }
        } as any)

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('records a failed Cucumber scenario from afterScenario', async () => {
        const manifestPath = await makeManifestPath()
        const service = new FailedTestRerunService({
            manifestPath
        }, {}, {} as WebdriverIO.Config)

        await service.afterScenario({
            pickle: {
                name: 'checkout rejects expired card',
                uri: '/repo/features/checkout.feature'
            }
        } as any, {
            passed: false,
            duration: 7,
            error: 'Scenario failed'
        }, {})

        expect(await readFailedTests(manifestPath)).toEqual([
            {
                attempt: 'initial',
                framework: 'cucumber',
                spec: '/repo/features/checkout.feature',
                fullTitle: 'checkout rejects expired card',
                title: 'checkout rejects expired card',
                error: {
                    message: 'Scenario failed'
                }
            }
        ])
    })
})
