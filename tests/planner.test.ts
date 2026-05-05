import { describe, expect, it } from 'vitest'

import { buildExactTitleGrep, buildExactTitleRegExps, createRerunSpecPlans } from '#src/planner.js'
import type { FailedRerunFramework, FailedTestRecord } from '#src/types.js'

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

    it('builds exact regular expressions for framework filters that accept RegExp arrays', () => {
        expect(buildExactTitleRegExps([
            'checkout accepts card (visa)',
            'cart total is $12.00?',
            'checkout accepts card (visa)'
        ]).map(String)).toEqual([
            '/^cart total is \\$12\\.00\\?$/',
            '/^checkout accepts card \\(visa\\)$/'
        ])
    })

    it('groups failed tests by framework and spec', () => {
        const firstSpec = 'specs/checkout.e2e.ts'
        const secondSpec = 'specs/account.e2e.ts'

        const plans = createRerunSpecPlans([
            failedTest(firstSpec, 'checkout rejects expired card'),
            failedTest(secondSpec, 'account updates profile'),
            failedTest(firstSpec, 'checkout accepts visa'),
            failedTest(firstSpec, 'checkout rejects expired card', 'cucumber')
        ])

        expect(plans).toHaveLength(3)
        expect(plans[0]).toMatchObject({
            framework: 'mocha',
            spec: firstSpec,
            grep: '^(?:checkout accepts visa|checkout rejects expired card)$'
        })
        expect(plans[0].tests.map((test) => test.fullTitle)).toEqual([
            'checkout rejects expired card',
            'checkout accepts visa'
        ])
        expect(plans[1]).toMatchObject({
            framework: 'mocha',
            spec: secondSpec,
            grep: '^(?:account updates profile)$'
        })
        expect(plans[2]).toMatchObject({
            framework: 'cucumber',
            spec: firstSpec
        })
    })
})
