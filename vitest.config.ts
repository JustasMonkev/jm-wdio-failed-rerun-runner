import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['tests/**/*.test.ts'],
        coverage: {
            provider: 'v8',
            // Tests exercise the emitted `build/` output via the `#src/*` subpath imports,
            // and v8 maps that back onto `src/*.ts` through the sourcemaps, so the report
            // is expressed in source terms. Listing `src/**/*.ts` as `include` instead
            // would ask v8 to cover files it never loaded and report 0%.
            reporter: ['text', 'lcov'],
            // A ratchet just under the current numbers: it fails a regression without
            // failing an unrelated change that happens to shift a line.
            thresholds: {
                statements: 96,
                branches: 88,
                functions: 100,
                lines: 96
            }
        }
    }
})
