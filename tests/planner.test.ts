import { describe, expect, it } from 'vitest'

import { buildExactTitleFilters, buildExactTitleGrep, createRerunPlans, createRerunSpecPlans } from '#src/planner'
import type { FailedRerunFramework, FailedTestRecord } from '#src/types'

function failedTest(
    spec: string,
    fullTitle: string,
    framework: FailedRerunFramework = 'mocha'
): FailedTestRecord {
    return {
        attempt: 'initial',
        framework,
        spec,
        fullTitle
    }
}

describe('planner', () => {
    it('builds exact grep expressions with escaped titles', () => {
        expect(buildExactTitleGrep([
            'checkout accepts card (visa)',
            'cart total is $12.00?',
            'checkout accepts card (visa)'
        ])).toBe('^(?:cart total is \\$12\\.00\\?|checkout accepts card \\(visa\\))$')
    })

    it('builds exact anchored string filters for frameworks that accept title lists', () => {
        expect(buildExactTitleFilters([
            'checkout accepts card (visa)',
            'cart total is $12.00?',
            'checkout accepts card (visa)'
        ])).toEqual([
            '^cart total is \\$12\\.00\\?$',
            '^checkout accepts card \\(visa\\)$'
        ])
    })

    it('keeps title filters intact across the launcher-to-worker process boundary', () => {
        // WebdriverIO forwards launcher args to workers with `childProcess.send()`, which
        // uses JSON serialization: a RegExp would arrive as `{}` and match no scenarios.
        const filters = buildExactTitleFilters(['checkout accepts card (visa)'])

        expect(JSON.parse(JSON.stringify(filters))).toEqual(filters)
    })

    it('groups failed tests by framework and spec so exact-title filters stay scoped to one file', () => {
        const firstSpec = 'specs/checkout.e2e.ts'
        const secondSpec = 'specs/account.e2e.ts'

        const records = [
            failedTest(firstSpec, 'checkout rejects expired card'),
            failedTest(secondSpec, 'checkout rejects expired card'),
            failedTest(firstSpec, 'checkout accepts visa'),
            failedTest(firstSpec, 'checkout rejects expired card', 'cucumber')
        ]
        const plans = createRerunPlans(records)

        expect(createRerunSpecPlans(records)).toEqual(plans)
        expect(plans).toHaveLength(3)
        expect(plans[0]).toMatchObject({
            framework: 'mocha',
            spec: firstSpec,
            specs: [firstSpec],
            grep: '^(?:checkout accepts visa|checkout rejects expired card)$'
        })
        expect(plans[0].tests.map((test) => test.fullTitle)).toEqual([
            'checkout rejects expired card',
            'checkout accepts visa'
        ])
        expect(plans[1]).toMatchObject({
            framework: 'mocha',
            spec: secondSpec,
            specs: [secondSpec],
            grep: '^(?:checkout rejects expired card)$'
        })
        expect(plans[2]).toMatchObject({
            framework: 'cucumber',
            spec: firstSpec,
            specs: [firstSpec]
        })
    })
})
