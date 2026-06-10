# wdio-config-auditor

Validate that WebdriverIO tests are correctly declared and discoverable from
`package.json` and WDIO configuration files.

Test suites rot silently: a spec file gets renamed and a suite keeps pointing
at the old path, a glob stops matching after a refactor, or a new test file is
added but never referenced by any config — and nothing fails until you notice
the test "passed" by never running. `wdio-config-auditor` makes that rot
visible and CI-enforceable.

## What it checks

- **Scripts** — finds `package.json` scripts that invoke the `wdio` runner and
  resolves the config file each one points at.
- **Config files** — discovers `wdio.conf.ts` / `wdio.conf.js` (and any
  `*wdio*.conf*.{js,ts,mjs,mts,cjs,cts}` variant) by script reference and by
  convention, and **follows imported and merged configs** (shared base configs
  imported with `import { config as base } from './wdio.shared.conf.js'`).
- **Specs & suites** — resolves every glob pattern in `specs`, `suites` and
  `exclude`, relative to the declaring config file, exactly like WDIO does.
- **Broken globs** — glob patterns that match zero files.
- **Missing files** — literal file references that point at non-existing files.
- **Orphaned tests** — test files on disk that no spec or suite references
  (files matched by an `exclude` pattern count as referenced).

## Requirements

- Node.js **20+**
- ESM (the package is `"type": "module"`)
- TypeScript configs are loaded natively — no build step needed in the audited
  project.

## Installation

```sh
npm install --save-dev wdio-config-auditor
```

## CLI usage

```sh
npx wdio-config-auditor                       # audit the current directory
npx wdio-config-auditor --cwd ./e2e           # audit another project root
npx wdio-config-auditor --config wdio.conf.ts # audit a specific config only
npx wdio-config-auditor --no-fail-orphans     # orphaned tests don't fail the run
```

The CLI prints the full [`AuditResult`](#auditresult) as JSON and exits with
code `1` when the audit fails, which makes it a one-liner in CI:

```json
{
  "scripts": { "lint:wdio": "wdio-config-auditor" }
}
```

## Programmatic usage

```ts
import { audit } from 'wdio-config-auditor'

const result = await audit({ cwd: '/path/to/project' })

if (result.status === 'fail') {
    for (const broken of result.brokenGlobs) {
        console.error(`glob "${broken.pattern}" in ${broken.configPath} matches no files`)
    }
    for (const missing of result.missingFiles) {
        console.error(`"${missing.pattern}" points at missing file ${missing.path}`)
    }
    for (const orphan of result.orphanedTestFiles) {
        console.error(`${orphan} is not referenced by any spec or suite`)
    }
    process.exitCode = 1
}
```

### Options

```ts
const result = await audit({
    // Project root containing package.json (default: process.cwd())
    cwd: './my-app',

    // Audit only these configs instead of discovering them
    configPaths: ['wdio.desktop.conf.ts', 'wdio.mobile.conf.ts'],

    // What counts as a "test file" for orphan detection
    testFilePatterns: ['e2e/**/*.e2e.ts'],

    // Directories excluded from discovery and orphan detection
    ignorePatterns: ['**/node_modules/**', '**/dist/**'],

    // Choose which findings fail the audit (all default to true)
    failOn: {
        brokenGlobs: true,
        missingFiles: true,
        orphanedTestFiles: false, // tolerate unreferenced test files
        noConfig: true,
        loadErrors: true,
    },
})
```

## `AuditResult`

The result is plain, JSON-serialisable data — every field is fully typed:

| Field               | Type               | Meaning                                                        |
| ------------------- | ------------------ | -------------------------------------------------------------- |
| `status`            | `'pass' \| 'fail'` | Overall outcome, controlled by `failOn`                        |
| `scripts`           | `DiscoveredScript[]` | package.json scripts that invoke WDIO                        |
| `configFiles`       | `ConfigFileInfo[]` | Every discovered config, incl. followed imports and load state |
| `specs`             | `SpecEntry[]`      | Top-level `specs` patterns with their resolved files           |
| `suites`            | `SuiteEntry[]`     | Named suites with their patterns and resolved files            |
| `resolvedTestFiles` | `string[]`         | Union of all referenced test files, minus `exclude`            |
| `orphanedTestFiles` | `string[]`         | Test files on disk that nothing references                     |
| `brokenGlobs`       | `BrokenGlob[]`     | Glob patterns that matched zero files                          |
| `missingFiles`      | `MissingFile[]`    | Literal references to non-existing files                       |
| `errors`            | `string[]`         | Non-fatal problems (unreadable package.json, load errors, …)   |

Example output:

```json
{
  "status": "fail",
  "scripts": [
    {
      "name": "test:e2e",
      "command": "wdio run ./wdio.conf.ts",
      "configArg": "./wdio.conf.ts",
      "configPath": "/app/wdio.conf.ts"
    }
  ],
  "configFiles": [
    { "path": "/app/wdio.conf.ts", "discoveredVia": "script", "loaded": true },
    { "path": "/app/wdio.shared.conf.ts", "discoveredVia": "import", "loaded": true }
  ],
  "specs": [
    {
      "pattern": "./specs/**/*.e2e.ts",
      "configPath": "/app/wdio.conf.ts",
      "resolvedFiles": ["/app/specs/login.e2e.ts"]
    }
  ],
  "suites": [
    {
      "name": "smoke",
      "configPath": "/app/wdio.conf.ts",
      "patterns": ["./specs/login.e2e.ts"],
      "resolvedFiles": ["/app/specs/login.e2e.ts"]
    }
  ],
  "resolvedTestFiles": ["/app/specs/login.e2e.ts"],
  "orphanedTestFiles": ["/app/specs/forgotten.spec.ts"],
  "brokenGlobs": [{ "pattern": "./gone/**/*.e2e.ts", "configPath": "/app/wdio.conf.ts" }],
  "missingFiles": [
    {
      "path": "/app/specs/deleted.e2e.ts",
      "pattern": "./specs/deleted.e2e.ts",
      "configPath": "/app/wdio.conf.ts",
      "suite": "smoke"
    }
  ],
  "errors": []
}
```

## How config discovery works

1. Every `package.json` script invoking `wdio` is parsed; an explicit config
   argument (`wdio run ./wdio.conf.ts`) is resolved relative to the project
   root. Scripts referencing non-existing configs are reported in `errors`.
2. Config files are also discovered by naming convention anywhere in the
   project (ignoring `node_modules`, `dist`, `build`, `coverage`, …).
3. Each config is loaded with [jiti](https://github.com/unjs/jiti), so
   TypeScript, ESM and CJS configs all work without a build step. Merged base
   configs (`{ ...baseConfig, specs: [...] }`) are evaluated for real — the
   audited `specs`/`suites` are the merged result, not a static guess.
4. Relative imports inside each config are followed; any imported module that
   exports a `config` is audited as a config file too (`discoveredVia: "import"`).

Spec patterns are resolved relative to the directory of the config file that
declares them, matching WDIO's behaviour.

## Example project

See [`examples/`](./examples) for a complete fixture project and
[`examples/run-audit.ts`](./examples/run-audit.ts) for a runnable script:

```sh
npm run build
node --experimental-strip-types examples/run-audit.ts
```

## Development

```sh
npm install
npm run check   # typecheck + build + tests
npm test        # vitest
```

## License

MIT
