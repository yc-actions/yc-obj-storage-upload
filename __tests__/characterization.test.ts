/**
 * Behavior contract for the upload logic.
 *
 * Records how run() wires the S3 client, which commands it issues, what the auth
 * middleware puts on the request, and how failures are reported - once per input
 * scenario. Captured on the pre-rewrite code; the rewritten code must reproduce
 * it byte-identically.
 */
// eslint-disable-next-line importPlugin/no-namespace
import * as core from '@actions/core'
import axios from 'axios'

import { normalize } from '../__fixtures__/normalize-request'
import {
    __setHeadObjectMode,
    __setListObjectPages,
    __setUploadFails,
    captureAuthHeaders,
    RecordedCommand,
    recorded,
    resetRecorder
} from '../__fixtures__/s3-recorder'
import { run } from '../src/main'

// jest.mock is hoisted above the imports above, so `run` picks up the recorder.
jest.mock('@aws-sdk/client-s3', () => {
    const actual = jest.requireActual('@aws-sdk/client-s3')
    const recorder = jest.requireActual('../__fixtures__/s3-recorder')
    return { ...actual, S3Client: recorder.makeRecordingS3Client(actual.S3Client) }
})

// Keeps the SA JSON credential path off grpc and off the network.
jest.mock('@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service', () => ({
    IamTokenService: class {
        async getToken(): Promise<string> {
            return 'token-from-sa-json'
        }
    }
}))

const SA_JSON = `{
    "id": "id",
    "created_at": "2021-01-01T00:00:00Z",
    "key_algorithm": "RSA_2048",
    "service_account_id": "service_account_id",
    "private_key": "private_key",
    "public_key": "public_key"
  }`

const REQUIRED: Record<string, string> = {
    'yc-sa-json-credentials': SA_JSON,
    bucket: 'bucket',
    root: '.'
}

const INCLUDE_SRC: Record<string, string[]> = { include: ['./src/*'] }

interface Scenario {
    name: string
    inputs: Record<string, string>
    multiline?: Record<string, string[]>
    booleans?: Record<string, boolean>
    idToken?: string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    axiosResponse?: any
    setup?: () => void
}

const SCENARIOS: Scenario[] = [
    {
        name: 'minimal inputs, SA JSON credentials',
        inputs: REQUIRED,
        multiline: INCLUDE_SRC
    },
    {
        name: 'IAM token credentials',
        inputs: { ...REQUIRED, 'yc-sa-json-credentials': '', 'yc-iam-token': 'test-iam-token' },
        multiline: INCLUDE_SRC
    },
    {
        name: 'workload identity federation credentials',
        inputs: { ...REQUIRED, 'yc-sa-json-credentials': '', 'yc-sa-id': 'test-sa-id' },
        multiline: INCLUDE_SRC,
        idToken: 'github-token',
        axiosResponse: { status: 200, data: { access_token: 'exchanged-token' } }
    },
    {
        name: 'no credentials',
        inputs: { ...REQUIRED, 'yc-sa-json-credentials': '' }
    },
    {
        name: 'OIDC token unavailable',
        inputs: { ...REQUIRED, 'yc-sa-json-credentials': '', 'yc-sa-id': 'test-sa-id' },
        idToken: ''
    },
    {
        name: 'token exchange returns non-200',
        inputs: { ...REQUIRED, 'yc-sa-json-credentials': '', 'yc-sa-id': 'test-sa-id' },
        idToken: 'github-token',
        axiosResponse: { status: 400, statusText: 'Bad Request' }
    },
    {
        name: 'token exchange returns an error body',
        inputs: { ...REQUIRED, 'yc-sa-json-credentials': '', 'yc-sa-id': 'test-sa-id' },
        idToken: 'github-token',
        axiosResponse: { status: 200, data: { error: 'invalid_request', error_description: 'Invalid token' } }
    },
    {
        name: 'bucket input missing',
        inputs: { ...REQUIRED, bucket: '' }
    },
    {
        name: 'clear enabled',
        inputs: REQUIRED,
        multiline: INCLUDE_SRC,
        booleans: { clear: true },
        setup: () => __setListObjectPages([{ Contents: [{ Key: 'src/func.js' }], IsTruncated: false }])
    },
    {
        name: 'prefix set',
        inputs: { ...REQUIRED, prefix: 'prefix/' },
        multiline: INCLUDE_SRC
    },
    {
        name: 'include and exclude patterns',
        inputs: REQUIRED,
        multiline: { include: ['./src/*'], exclude: ['**/*.txt'] }
    },
    {
        name: 'cache-control mapping with a default',
        inputs: REQUIRED,
        multiline: {
            include: ['./src/*'],
            'cache-control': ['*.js:public, max-age=31536000', '*:no-cache']
        }
    },
    {
        name: 'skip-unchanged, remote ETag matches',
        inputs: REQUIRED,
        multiline: INCLUDE_SRC,
        booleans: { 'skip-unchanged': true },
        setup: () => __setHeadObjectMode('match')
    },
    {
        name: 'skip-unchanged, remote ETag differs',
        inputs: REQUIRED,
        multiline: INCLUDE_SRC,
        booleans: { 'skip-unchanged': true },
        setup: () => __setHeadObjectMode('differ')
    },
    {
        name: 'custom concurrency',
        inputs: { ...REQUIRED, concurrency: '2' },
        multiline: INCLUDE_SRC
    },
    {
        name: 'fail-on-error with a failing upload',
        inputs: REQUIRED,
        multiline: INCLUDE_SRC,
        booleans: { 'fail-on-error': true },
        setup: () => __setUploadFails(true)
    }
]

/**
 * Uploads run concurrently, so completion order is not guaranteed. Sorting by
 * command name then Key makes the snapshot stable without losing any content;
 * commands of different types are still distinguishable from one another.
 */
function stableCommands(commands: RecordedCommand[]): RecordedCommand[] {
    return [...commands].sort((a, b) => {
        const byName = a.command.localeCompare(b.command)
        if (byName !== 0) {
            return byName
        }
        const keyA = String((a.input as { Key?: string })?.Key ?? '')
        const keyB = String((b.input as { Key?: string })?.Key ?? '')
        return keyA.localeCompare(keyB)
    })
}

/**
 * Concurrent uploads also fail in a non-deterministic order, so the
 * `core.error` call log needs the same tiebreaker as `stableCommands`: sort
 * by the (single, string) argument each call was made with.
 */
function stableErrorCalls(calls: unknown[][]): unknown[][] {
    return [...calls].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
}

/**
 * `run()` reports failed uploads as a single `core.setFailed` call whose
 * message embeds a comma-joined file list built from completion order. Sort
 * that embedded list so the message text does not vary run to run.
 */
function stableSetFailedCalls(calls: unknown[][]): unknown[][] {
    return calls.map(args =>
        args.map(arg => {
            if (typeof arg !== 'string') {
                return arg
            }
            const match = arg.match(/^(Failed to upload \d+ file\(s\): )(.+)$/)
            if (!match) {
                return arg
            }
            const [, prefix, list] = match
            return (
                prefix +
                list
                    .split(', ')
                    .sort((a, b) => a.localeCompare(b))
                    .join(', ')
            )
        })
    )
}

describe('characterization', () => {
    let setFailedMock: jest.SpyInstance
    let errorMock: jest.SpyInstance

    beforeEach(() => {
        jest.clearAllMocks()
        resetRecorder()

        setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
        errorMock = jest.spyOn(core, 'error').mockImplementation()
        jest.spyOn(core, 'info').mockImplementation()
        jest.spyOn(core, 'debug').mockImplementation()
        jest.spyOn(core, 'startGroup').mockImplementation()
        jest.spyOn(core, 'endGroup').mockImplementation()
    })

    afterEach(() => {
        jest.restoreAllMocks()
    })

    for (const scenario of SCENARIOS) {
        it(`records S3 wiring and commands: ${scenario.name}`, async () => {
            jest.spyOn(core, 'getInput').mockImplementation((name: string, options?: core.InputOptions): string => {
                const value = scenario.inputs[name] ?? ''
                if (options?.required && !value) {
                    throw new Error(`Input required and not supplied: ${name}`)
                }
                return value
            })
            jest.spyOn(core, 'getMultilineInput').mockImplementation(
                (name: string): string[] => scenario.multiline?.[name] ?? []
            )
            jest.spyOn(core, 'getBooleanInput').mockImplementation(
                (name: string): boolean => scenario.booleans?.[name] ?? false
            )
            jest.spyOn(core, 'getIDToken').mockResolvedValue(scenario.idToken ?? '')
            jest.spyOn(axios, 'post').mockResolvedValue(
                scenario.axiosResponse ?? { status: 200, data: { access_token: 'exchanged-token' } }
            )

            scenario.setup?.()

            await run()
            await captureAuthHeaders()

            expect({
                configs: normalize(recorded.configs),
                middlewareOptions: normalize(recorded.middlewareOptions),
                stack: recorded.stack,
                authHeaders: normalize(recorded.authHeaders),
                commands: normalize(stableCommands(recorded.commands)),
                setFailed: normalize(stableSetFailedCalls(setFailedMock.mock.calls)),
                errors: normalize(stableErrorCalls(errorMock.mock.calls))
            }).toMatchSnapshot()
        })
    }
})
