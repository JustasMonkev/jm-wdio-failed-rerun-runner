# Example: focused failed-test reruns

A minimal WebdriverIO project that demonstrates `jm-wdio-failed-rerun-runner`.

It contains three tests in two spec files:

- `flaky.e2e.js` / "passes only on rerun" — fails on the initial run, passes on rerun
- `flaky.e2e.js` / "sibling test that always passes"
- `stable.e2e.js` / "always passes"

## Run it

Requires Node >= 18.20 and a local Chrome installation (the run is headless).

```sh
npm install
npm test
```

What you will see:

1. The initial run executes all three tests; the flaky one fails, so the run fails.
2. A single focused rerun starts for `flaky.e2e.js` with an exact-title filter —
   only the one failed test runs again. The sibling test in the same file and the
   other spec file are not re-executed.
3. The rerun passes, so the overall exit code is `0`.

No extra files or configuration are needed — failure manifests default to temp
files. The flaky test also logs its environment: during the rerun you will see
`retry=1` and `BROWSERSTACK_RERUN=true`, which is the rerun contract the
BrowserStack service consumes when you add it to `services`.

## Things to try

- Make the flaky test fail permanently (`throw` unconditionally) and observe
  that the exit code stays `1`.
- Add `--manifest-path ./initial-failures.ndjson` and
  `--rerun-manifest-path ./rerun-failures.ndjson` to the `test` script to keep
  the failure manifests as build artifacts instead of temp files.
- Add `--max-reruns 2` to the `test` script and make the test pass only when
  `WDIO_FAILED_RERUN_RETRY === '2'` to see a second rerun round.
- Add `--no-pass-on-successful-rerun` to keep the initial failing exit code
  even when the rerun passes.
