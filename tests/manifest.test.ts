import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { appendFailedTest, readFailedTests, resetManifest } from '#src/manifest.js'
import type { FailedTestRecord } from '#src/types.js'

const tempDirs: string[] = []

async function makeManifestPath() {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wdio-failed-rerun-manifest-'))
    tempDirs.push(tempDir)
    return path.join(tempDir, 'failed.ndjson')
}

function failedTest(spec: string, fullTitle: string): FailedTestRecord {
    return {
        attempt: 'initial',
        framework: 'mocha',
        spec,
        fullTitle
    }
}

describe('manifest', () => {
    afterEach(async () => {
        while (tempDirs.length > 0) {
            await fs.rm(tempDirs.pop()!, { recursive: true, force: true })
        }
    })

    it('returns an empty list for a missing manifest', async () => {
        const manifestPath = await makeManifestPath()

        expect(await readFailedTests(manifestPath)).toEqual([])
    })

    it('resets and reads newline-delimited failure records', async () => {
        const manifestPath = await makeManifestPath()

        await appendFailedTest(manifestPath, failedTest('specs/checkout.e2e.ts', 'checkout rejects expired card'))
        await resetManifest(manifestPath)
        await appendFailedTest(manifestPath, failedTest('specs/account.e2e.ts', 'account updates profile'))

        expect(await readFailedTests(manifestPath)).toEqual([
            failedTest('specs/account.e2e.ts', 'account updates profile')
        ])
    })

    it('dedupes failures by framework, spec, and full title', async () => {
        const manifestPath = await makeManifestPath()
        const duplicate = failedTest('specs/checkout.e2e.ts', 'checkout rejects expired card')

        await appendFailedTest(manifestPath, duplicate)
        await appendFailedTest(manifestPath, duplicate)
        await appendFailedTest(manifestPath, failedTest('specs/checkout.e2e.ts', 'checkout accepts visa'))

        expect(await readFailedTests(manifestPath)).toEqual([
            duplicate,
            failedTest('specs/checkout.e2e.ts', 'checkout accepts visa')
        ])
    })
})
