import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
    {
        ignores: [
            'build/**',
            'coverage/**',
            'node_modules/**'
        ]
    },
    {
        files: [
            'eslint.config.ts',
            'src/**/*.ts',
            'tests/**/*.ts'
        ],
        extends: [
            js.configs.recommended,
            ...tseslint.configs.recommended
        ],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: 'module',
            globals: {
                console: 'readonly',
                process: 'readonly',
                WebdriverIO: 'readonly'
            }
        },
        rules: {
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_'
            }]
        }
    },
    {
        files: ['tests/**/*.ts'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    }
)
