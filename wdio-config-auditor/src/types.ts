/**
 * Options accepted by {@link audit}.
 */
export interface AuditOptions {
    /**
     * Project root that contains `package.json`.
     * Defaults to `process.cwd()`.
     */
    cwd?: string
    /**
     * Explicit WDIO config files to audit (absolute, or relative to `cwd`).
     * When omitted, configs are discovered from package.json scripts and by
     * convention (`**\/wdio*.conf*.{js,ts,mjs,mts,cjs,cts}`).
     */
    configPaths?: string[]
    /**
     * Glob patterns (relative to `cwd`) that identify candidate test files
     * for orphan detection.
     * Defaults to common spec/test/e2e naming conventions.
     */
    testFilePatterns?: string[]
    /**
     * Glob patterns excluded from discovery and orphan detection.
     * Defaults to `node_modules`, `dist`, `build`, `coverage`, `.git` and
     * similar output directories.
     */
    ignorePatterns?: string[]
    /**
     * Which findings flip {@link AuditResult.status} to `'fail'`.
     * Every flag defaults to `true` except where noted.
     */
    failOn?: FailOnOptions
}

/** Controls which findings cause a failing audit. */
export interface FailOnOptions {
    /** Fail when a glob pattern matches no files. Default `true`. */
    brokenGlobs?: boolean
    /** Fail when a literal file reference does not exist. Default `true`. */
    missingFiles?: boolean
    /** Fail when test files on disk are not referenced by WDIO. Default `true`. */
    orphanedTestFiles?: boolean
    /** Fail when no WDIO config file can be found or loaded. Default `true`. */
    noConfig?: boolean
    /** Fail when a discovered config file cannot be loaded. Default `true`. */
    loadErrors?: boolean
}

/** A package.json script that invokes the WDIO test runner. */
export interface DiscoveredScript {
    /** Script name, e.g. `"test:e2e"`. */
    name: string
    /** Full script command as written in package.json. */
    command: string
    /**
     * Absolute path of the config file the script points at, or `null` when
     * the script relies on the WDIO default (`wdio.conf.(js|ts)`) or the
     * reference could not be resolved.
     */
    configPath: string | null
    /** Config path exactly as written in the script, if any. */
    configArg: string | null
}

/** How a config file entered the audit. */
export type ConfigDiscoveryMethod = 'explicit' | 'script' | 'convention' | 'import'

/** A WDIO config file that was found (and possibly loaded). */
export interface ConfigFileInfo {
    /** Absolute path of the config file. */
    path: string
    /** How this file was discovered. */
    discoveredVia: ConfigDiscoveryMethod
    /** Whether the file was successfully loaded and exported a config object. */
    loaded: boolean
    /** Load/evaluation error message, when `loaded` is `false`. */
    loadError?: string
}

/** A top-level `specs` entry of a config file. */
export interface SpecEntry {
    /** Spec pattern exactly as written in the config. */
    pattern: string
    /** Absolute path of the config file declaring the pattern. */
    configPath: string
    /** Absolute paths of the test files this pattern resolves to. */
    resolvedFiles: string[]
}

/** A named suite declared in a config file. */
export interface SuiteEntry {
    /** Suite name (the key under `suites`). */
    name: string
    /** Absolute path of the config file declaring the suite. */
    configPath: string
    /** Spec patterns of the suite, exactly as written. */
    patterns: string[]
    /** Absolute paths of the test files the suite resolves to. */
    resolvedFiles: string[]
}

/** A glob pattern that matched zero files. */
export interface BrokenGlob {
    /** The glob pattern exactly as written. */
    pattern: string
    /** Absolute path of the config file declaring the pattern. */
    configPath: string
    /** Suite name, when the pattern comes from a suite. */
    suite?: string
}

/** A literal (non-glob) file reference that points at a non-existing file. */
export interface MissingFile {
    /** Absolute path the reference resolves to. */
    path: string
    /** The reference exactly as written in the config. */
    pattern: string
    /** Absolute path of the config file declaring the reference. */
    configPath: string
    /** Suite name, when the reference comes from a suite. */
    suite?: string
}

/** Result of a full project audit. */
export interface AuditResult {
    /** `'pass'` when no enabled `failOn` finding was produced. */
    status: 'pass' | 'fail'
    /** package.json scripts that invoke WDIO. */
    scripts: DiscoveredScript[]
    /** Every config file that was discovered, including followed imports. */
    configFiles: ConfigFileInfo[]
    /** Top-level `specs` patterns across all loaded configs. */
    specs: SpecEntry[]
    /** Named suites across all loaded configs. */
    suites: SuiteEntry[]
    /** Union of every test file referenced by specs/suites, minus `exclude`. */
    resolvedTestFiles: string[]
    /** Test files on disk that no spec or suite references. */
    orphanedTestFiles: string[]
    /** Glob patterns that matched zero files. */
    brokenGlobs: BrokenGlob[]
    /** Literal file references that do not exist on disk. */
    missingFiles: MissingFile[]
    /** Non-fatal problems encountered while auditing. */
    errors: string[]
}

/**
 * The shape of a loaded WDIO config that this library inspects.
 * Mirrors the relevant subset of `@wdio/types` `Options.Testrunner`.
 */
export interface WdioConfigShape {
    specs?: ReadonlyArray<string | ReadonlyArray<string>>
    exclude?: ReadonlyArray<string>
    suites?: Readonly<Record<string, ReadonlyArray<string | ReadonlyArray<string>>>>
}
