// See: https://jestjs.io/docs/configuration

/** @type {import('ts-jest').JestConfigWithTsJest} **/
export default {
    clearMocks: true,
    collectCoverage: true,
    // src/index.ts is a three-line entrypoint whose only statement is the run()
    // call; including it would move the denominator for no signal.
    collectCoverageFrom: ['./src/**', '!./src/index.ts'],
    coverageDirectory: './coverage',
    coveragePathIgnorePatterns: ['/node_modules/', '/dist/'],
    coverageReporters: ['json-summary', 'text', 'lcov'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleFileExtensions: ['ts', 'js'],
    preset: 'ts-jest',
    reporters: ['default'],
    resolver: 'ts-jest-resolver',
    testEnvironment: 'node',
    testMatch: ['**/*.test.ts'],
    // SCAFFOLDING - Task 2 only. Task 3 removes both entries. The suite is
    // incomplete until they are gone.
    testPathIgnorePatterns: [
        '/dist/',
        '/node_modules/',
        '__tests__/main.test.ts',
        '__tests__/characterization.test.ts'
    ],
    transform: {
        '^.+\\.ts$': [
            'ts-jest',
            {
                tsconfig: 'tsconfig.json',
                useESM: true
            }
        ]
    },
    verbose: true
}
