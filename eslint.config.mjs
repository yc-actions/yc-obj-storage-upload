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
        ignores: ['**/coverage', '**/dist', '**/node_modules', '__fixtures__/workspace']
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
                ...globals.jest
            },

            parser: tsParser,
            ecmaVersion: 2023,
            sourceType: 'module',

            parserOptions: {
                projectService: {
                    allowDefaultProject: [
                        '__fixtures__/*.ts',
                        '__tests__/*.ts',
                        'eslint.config.mjs',
                        'jest.config.js',
                        'rollup.config.ts'
                    ],
                    // __fixtures__/core.ts and __fixtures__/axios.ts (added in the
                    // ESM test port) push the default-project glob match past the
                    // built-in cap of 8 files. __tests__/bundle.test.ts (Task 4)
                    // pushed it to 11. Task 5 split __tests__/main.test.ts into
                    // action-inputs.test.ts, bucket.test.ts, and upload.test.ts,
                    // pushing it to 14.
                    maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 14
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
