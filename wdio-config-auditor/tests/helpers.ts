import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** Create a throwaway project directory from a map of relative path -> content. */
export async function createFixtureProject(files: Record<string, string>): Promise<{
    dir: string
    cleanup: () => Promise<void>
}> {
    const dir = await mkdtemp(path.join(tmpdir(), 'wdio-config-auditor-'))
    for (const [relativePath, content] of Object.entries(files)) {
        const filePath = path.join(dir, relativePath)
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf8')
    }
    return {
        dir,
        cleanup: () => rm(dir, { recursive: true, force: true }),
    }
}

export function pkgJson(scripts: Record<string, string>): string {
    return JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts }, null, 2)
}
