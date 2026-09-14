// See: https://eslint.org/docs/latest/use/configure/configuration-files

import { FlatCompat } from '@eslint/eslintrc'
import js from '@eslint/js'
import typescriptEslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import jest from 'eslint-plugin-jest'
import prettier from 'eslint-plugin-prettier'
import globals from 'globals'

const compat = new FlatCompat({
    baseDirectory: import.meta.dirname,
    recommendedConfig: js.configs.recommended,
    allConfig: js.configs.all
})

export default [
    {
        ignores: ['**/coverage', '**/dist', '**/node_modules']
    },
    ...compat.extends(
        'eslint:recommended',
        'plugin:@typescript-eslint/eslint-recommended',
        'plugin:@typescript-eslint/recommended',
        'plugin:jest/recommended',
        'plugin:prettier/recommended'
    ),
    {
        plugins: {
            jest,
            prettier,
            '@typescript-eslint': typescriptEslint
        },

        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest,
                Atomics: 'readonly',
                SharedArrayBuffer: 'readonly'
            },

            parser: tsParser,
            ecmaVersion: 2023,
            sourceType: 'module',

            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        '__fixtures__/*.ts',
                        '__tests__/*.ts',
                        // tsconfig.json excludes __fixtures__ and __tests__, so these workspace
                        // data fixtures (upload test payloads, not real source) also fall back to
                        // the default project. '**' globs are rejected by projectService, so each
                        // directory depth needs its own entry.
                        '__fixtures__/workspace/src/*.js',
                        '__fixtures__/workspace/src_with_subfolders/*.js',
                        '__fixtures__/workspace/src_with_subfolders/*/*.js',
                        'eslint.config.mjs',
                        'jest.config.js',
                        'rollup.config.ts'
                    ],
                    // tsconfig.json's `exclude` keeps __fixtures__ and __tests__ out of the real
                    // project, so all of __fixtures__/*.ts, __tests__/*.ts, the three root config
                    // files, and the workspace fixtures above fall back to the default project at
                    // once (13 files), past typescript-eslint's default cap of 8.
                    maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20
                },
                tsconfigRootDir: import.meta.dirname
            }
        },

        rules: {
            camelcase: 'off',
            'no-console': 'off',
            'no-shadow': 'off',
            'no-unused-vars': 'off',
            'prettier/prettier': 'error'
        }
    }
]
