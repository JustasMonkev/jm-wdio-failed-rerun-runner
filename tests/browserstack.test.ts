import { afterEach, describe, expect, it } from 'vitest'

import {
    BROWSERSTACK_RERUN_ENV,
    BROWSERSTACK_RERUN_TESTS_ENV,
    processBrowserStackEnv
} from '#src/browserstack'

function snapshotEnv() {
    return {
        rerun: process.env[BROWSERSTACK_RERUN_ENV],
        rerunTests: process.env[BROWSERSTACK_RERUN_TESTS_ENV]
    }
}

describe('BrowserStack rerun environment adapter', () => {
    afterEach(() => {
        delete process.env[BROWSERSTACK_RERUN_ENV]
        delete process.env[BROWSERSTACK_RERUN_TESTS_ENV]
    })

    it('exposes the BrowserStack rerun contract while a rerun runs', async () => {
        const result = await processBrowserStackEnv.withRerun(
            ['/repo/specs/checkout.e2e.ts', '/repo/specs/account.e2e.ts'],
            async () => snapshotEnv()
        )

        expect(result).toEqual({
            rerun: 'true',
            rerunTests: '/repo/specs/checkout.e2e.ts,/repo/specs/account.e2e.ts'
        })
    })

    it('removes the rerun variables after the run when they were not set before', async () => {
        await processBrowserStackEnv.withRerun(['/repo/specs/checkout.e2e.ts'], async () => 0)

        expect(snapshotEnv()).toEqual({
            rerun: undefined,
            rerunTests: undefined
        })
    })

    it('restores previous rerun variables after the run', async () => {
        process.env[BROWSERSTACK_RERUN_ENV] = 'outside-rerun'
        process.env[BROWSERSTACK_RERUN_TESTS_ENV] = 'outside-tests'

        await processBrowserStackEnv.withRerun(['/repo/specs/checkout.e2e.ts'], async () => 0)

        expect(snapshotEnv()).toEqual({
            rerun: 'outside-rerun',
            rerunTests: 'outside-tests'
        })
    })

    it('does not mark the rerun when a spec path contains a comma', async () => {
        const result = await processBrowserStackEnv.withRerun(
            ['/repo/specs/checkout,legacy.e2e.ts'],
            async () => snapshotEnv()
        )

        expect(result).toEqual({
            rerun: undefined,
            rerunTests: undefined
        })
    })

    it('restores the environment when the run fails', async () => {
        await expect(processBrowserStackEnv.withRerun(['/repo/specs/checkout.e2e.ts'], async () => {
            throw new Error('launcher crashed')
        })).rejects.toThrow('launcher crashed')

        expect(snapshotEnv()).toEqual({
            rerun: undefined,
            rerunTests: undefined
        })
    })
})
