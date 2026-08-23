# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Focused reruns could report a green build without running any tests.** Three
  defects compounded into one failure mode:
  - Mocha full titles were truncated to the immediate `describe`. WebdriverIO
    hands `afterTest` a spread of the Mocha test object, which drops `fullTitle`
    (a prototype method) and reduces `parent` to the immediate suite title, so
    the generated `mochaOpts.grep` could not match the title Mocha filters on.
    Any suite nesting `describe` blocks reran nothing.
  - Cucumber filters could not survive the worker boundary. WebdriverIO forwards
    launcher arguments with `childProcess.send()`, which serializes as JSON, so
    the `RegExp` objects in `cucumberOpts.name` arrived as `{}` and matched no
    scenarios. They are now the anchored strings WebdriverIO documents.
  - Nothing verified that a rerun ran what it targeted. An empty manifest is
    indistinguishable from "everything passed", so a filter matching zero tests
    produced exit code `0`. Reruns now record executed tests, and a targeted test
    that never ran is a hard failure reported in `notExecuted`.
- **One capability's pass erased another's failure.** The same spec and title run once
  per capability in separate workers, and manifest deduplication collapsed them on
  title alone, so a browser that passed could erase a browser that failed and the run
  went green. Records are now keyed by worker as well, while matching a rerun to the
  failure it targets still ignores the worker, since a rerun always runs in a fresh one.
- **The summary accumulated every rerun failure instead of taking the last.** With
  `maxReruns` above 1, a test that failed an early round and passed a later one was
  reported as broken while the run exited 0.
- **The combined rerun manifest bypassed a substituted manifest store**, writing to the
  filesystem behind a custom adapter's back.
- **The CLI exited 0 on every failing run.** WebdriverIO's launcher registers an
  `exit-hook` handler, and `exit-hook@4` replaces the exit path such that a process
  which only sets `process.exitCode` still exits `0`. Exiting explicitly is the only
  reliable signal, so the CLI now drains stdout and stderr and then exits with the code -
  `process.exit` alone would truncate the summary the reporter had just printed.
- **Mocha full titles were read by calling `fullTitle` detached from its runnable.**
  Mocha implements it as `this.titlePath().join(' ')`, so the call threw
  `this.titlePath is not a function`, took down the `afterTest` hook, and lost the
  failure record entirely. It is now invoked as a method of the runnable that owns it,
  and a throwing accessor falls back instead of failing the hook.
- **A passing rerun was reported as "never ran" whenever `mochaOpts.retries` was set.**
  Mocha marks every test with `_retries`, and a test that passes first time still has
  `_currentRetry: 0`; treating that as a pending retry suppressed the record that proves
  the test executed, so a genuinely recovered test failed the build. Mocha only retries
  failures, so the retry guard no longer applies to passing tests.
- **A skipped Cucumber scenario counted as a recovery.** `@wdio/cucumber-framework`
  reports SKIPPED as `passed: true`, so a scenario skipped on rerun - by a tag filter or
  a skipping Before hook - looked exactly like a test that had recovered.
- **`serializeError` could throw and lose the failure record.** It runs inside the
  `afterTest` hook, so an error carrying an accessor that throws, or a Proxy that throws
  from `ownKeys`, took down the very record the rerun depends on; deeply nested error
  data overflowed the stack. Property reads are now guarded and recursion is depth-capped.
- **`--max-reruns` accepted values that hang the run.** `Number('9e20')` passes an integer
  check, so a permanently failing test would rerun ~1e21 times, launching WebdriverIO each
  round. Parsing is now strict decimal and bounded, and the programmatic API is clamped.
- **A skipped test was recorded as a failure.** WebdriverIO reports `this.skip()` as
  `passed: false, skipped: true`, so a skipped test was queued for rerun, skipped
  again, and never resolved, forcing a non-zero exit once reruns were exhausted.
- **In-run retries were not detected**, so every intermediate attempt of a
  `mochaOpts.retries` test was recorded. `result.retries.attempts < limit` can never
  be true in `afterTest`: WebdriverIO exhausts its retry budget before returning.
  Mocha's own `_currentRetry`/`_retries` are now consulted.
- **Cucumber retries were never detected**: cucumber-js sets `willBeRetried` on the
  hook parameter, not under `result` where `@wdio/types` declares it.
- Manifest dedupe kept the first record for a test, so a later `passed` entry could
  not supersede an earlier failure from an in-run retry. The last record now wins.
- **`--rerun-manifest-path` kept only the last spec group.** Every rerun group resolved
  to the same file and reset it first, so the documented CI artifact ended up holding
  whichever group ran last. Groups now write their own `<name>.rerun-<round>-<group><ext>`
  files and the given path collects all rerun failures.
- **The CLI could report success on failure.** Exit-code handling was keyed off
  `WDIO_UNIT_TESTS`, which is `@wdio/cli`'s own variable, not this package's. With it
  exported, `process.exit` was skipped and `cli.ts` discarded `run()`'s return value,
  so a failing run exited `0`. `run()` now simply returns the code and `cli.ts` sets
  `process.exitCode`, which also stops truncating the summary the reporter just printed.
- `npm run typecheck` failed on a clean checkout, and the CI workflow ran it before
  building; `#src/*` resolves to `build/*.d.ts`, so a `pretypecheck` build was needed.
- `serializeError` reported a shared non-cyclic object as `[Circular]` the second
  time it appeared, discarding real diagnostic data.
- A single malformed manifest line aborted the entire rerun; unreadable lines are
  now skipped.
- A missing config path produced a module-resolution stack trace naming an
  internal wrapper temp file; it is now one clear line.
- `repository.url` named the wrong GitHub owner, breaking the npm page link and
  npm provenance.
- Published sourcemaps were dangling: they reference `../src/*.ts`, which was not
  in the tarball. `src` now ships.
- `npm run coverage`, and therefore `npm run check`, failed on a clean checkout
  because tests import `#src/*`, which resolves to `build/*.js`.

### Added

- **Jasmine support.** Jasmine failures were silently dropped: WebdriverIO spreads
  Jasmine's own spec result into `afterTest`, which carries `fullName`/`description`
  rather than Mocha's `fullTitle`/`title`, so no record had a usable title and no
  rerun ever happened. The framework is now read from the WebdriverIO config, and
  reruns filter with `jasmineOpts.grep`.
- Rerun progress output and a closing summary separating tests that recovered
  (`flaky`) from tests that stayed broken (`broken`), plus `notExecuted`. The same
  breakdown is exposed on `result.summary`; `--quiet` silences it.
- `-q` / `--quiet` CLI flag and a `quiet` option.
- A CI workflow covering Node 20/22/24 on Linux plus Windows and macOS, and an
  end-to-end job running the example project.
- Dependabot configuration and coverage thresholds.

### Changed

- Dependencies updated to their latest compatible versions. TypeScript is held at
  `^6.0.3` because `typescript-eslint@8.67.0` declares a `typescript >=4.8.4 <6.1.0`
  peer range.

## [0.0.1]

- Initial release: run a WebdriverIO suite, record failures to an NDJSON manifest,
  and rerun only the failed tests with framework-specific exact-title filters.
