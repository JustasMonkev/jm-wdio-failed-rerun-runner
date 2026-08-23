import { browser } from '@wdio/globals'

// WDIO_FAILED_RERUN_RETRY is '0' during the initial run and '1', '2', ...
// during focused rerun rounds. This test simulates a flaky test: it fails
// on the initial run and passes when rerun.
//
// The describe blocks are deliberately NESTED. WebdriverIO hands `afterTest` a
// spread of the Mocha test object, which drops `fullTitle` and reduces `parent`
// to the immediate suite title, so a runner that rebuilds the title from
// parent + title loses the outer describe and reruns nothing at all. A
// single-level suite hides that entirely, so the demo uses two levels.
describe('flaky suite', () => {
    describe('when the environment settles', () => {
        it('passes only on rerun', async () => {
            const attempt = process.env.WDIO_FAILED_RERUN_RETRY
            console.log(`[example] flaky test attempt: retry=${attempt}, ` +
                `BROWSERSTACK_RERUN=${process.env.BROWSERSTACK_RERUN}`)

            await browser.url('about:blank')

            if (attempt === '0') {
                throw new Error('intentional failure on initial run')
            }
        })

        it('sibling test that always passes', async () => {
            // This test shares a spec file with the flaky test, but it is NOT
            // rerun: the rerun round narrows execution to the failed test title.
            await browser.url('about:blank')
        })
    })
})
