import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// A rerun runs in the same process as the initial attempt, so a config that reads the
// rerun environment at module scope would otherwise keep the value it saw the first time.
// Dropping the config's own cache entry is not enough: a helper it requires holds its own
// reading, so the whole project-local subtree goes.
//
// Files under node_modules stay cached deliberately. Re-evaluating third-party modules
// would hand out fresh instances of ones WebdriverIO holds references to, and they do not
// read the rerun environment at module scope.
//
// Only CommonJS is reachable this way. Node exposes no equivalent for the ES module
// registry, so an ES-module helper keeps its first reading; the per-attempt query on the
// config's own URL is what covers the config itself.
export function purgeCommonJsCache(entry: string, seen = new Set<string>()) {
    let resolved: string
    try {
        resolved = require.resolve(entry)
    } catch {
        // An ES module has no CommonJS cache entry to drop.
        return seen
    }

    // `children` is a genuine graph, not a tree: two modules requiring each other list
    // each other, so a circular require would recurse for ever without this.
    if (seen.has(resolved) || resolved.includes('node_modules')) {
        return seen
    }

    seen.add(resolved)
    for (const child of require.cache[resolved]?.children ?? []) {
        purgeCommonJsCache(child.filename, seen)
    }

    delete require.cache[resolved]
    return seen
}

export const CONFIG_CACHE_PATH = new URL('./configCache.js', import.meta.url).href
