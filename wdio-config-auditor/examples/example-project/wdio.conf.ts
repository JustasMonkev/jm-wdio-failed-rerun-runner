import { config as shared } from './wdio.shared.conf.js'

export const config = {
    ...shared,
    specs: ['./specs/**/*.e2e.ts'],
    exclude: ['./specs/wip.e2e.ts'],
}
