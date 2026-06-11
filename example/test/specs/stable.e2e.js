import { browser } from '@wdio/globals'

describe('stable suite', () => {
    it('always passes', async () => {
        // This spec file has no failures, so it never runs a second time.
        await browser.url('about:blank')
    })
})
