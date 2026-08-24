import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url))

async function readPackageJson() {
    return JSON.parse(await fs.readFile(packageJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>
        devDependencies?: Record<string, string>
        peerDependencies?: Record<string, string>
    }
}

describe('WebdriverIO is a peer dependency, not a bundled one', () => {
    // The launcher loads `@wdio/cli` through a deliberately dynamic bare specifier so it
    // resolves the consumer's copy: the Launcher that runs a config has to be the one that
    // config was written against. Declaring it as a hard dependency installs a second copy
    // beside theirs, which can be a different version, and drags the whole WebdriverIO
    // toolchain into the production dependency graph of every project that installs this.
    it.each(['@wdio/cli', '@wdio/types'])('declares %s as a peer, never a dependency', async (name) => {
        const packageJson = await readPackageJson()

        expect(packageJson.dependencies ?? {}).not.toHaveProperty(name)
        expect(packageJson.peerDependencies ?? {}).toHaveProperty(name)
        // Still needed locally to build and test against.
        expect(packageJson.devDependencies ?? {}).toHaveProperty(name)
    })

    it('keeps the runtime dependencies to what is genuinely imported at run time', async () => {
        const packageJson = await readPackageJson()

        // Anything added here ships to every consumer, so it should be a deliberate choice
        // rather than something that accumulated.
        expect(Object.keys(packageJson.dependencies ?? {})).toEqual(['zod'])
    })
})
