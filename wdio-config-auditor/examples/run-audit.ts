/**
 * Example usage of the wdio-config-auditor programmatic API.
 *
 * Run from the package root after `npm run build`:
 *   node --experimental-strip-types examples/run-audit.ts
 *
 * In your own project, import from the package instead:
 *   import { audit } from 'wdio-config-auditor'
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { audit } from '../build/index.js'

const projectDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'example-project')

const result = await audit({ cwd: projectDir })

console.log(JSON.stringify(result, null, 2))

if (result.status === 'fail') {
    console.error('\nAudit failed:')
    for (const broken of result.brokenGlobs) {
        console.error(`  glob "${broken.pattern}" in ${broken.configPath} matches no files`)
    }
    for (const missing of result.missingFiles) {
        console.error(`  "${missing.pattern}" in ${missing.configPath} points at a missing file`)
    }
    for (const orphan of result.orphanedTestFiles) {
        console.error(`  ${orphan} is not referenced by any spec or suite`)
    }
    process.exitCode = 1
}
