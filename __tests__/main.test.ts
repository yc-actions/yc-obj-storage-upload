import { expect, jest, test } from '@jest/globals'
import { S3Client } from '@aws-sdk/client-s3'

import * as core from '../__fixtures__/core.js'
import * as axios from '../__fixtures__/axios.js'

jest.unstable_mockModule('@actions/core', () => core)
jest.unstable_mockModule('axios', () => axios)

const { run } = await import('../src/main.js')

const requiredInputs: Record<string, string> = {
    'yc-sa-json-credentials': `{
    "id": "id",
    "created_at": "2021-01-01T00:00:00Z",
    "key_algorithm": "RSA_2048",
    "service_account_id": "service_account_id",
    "private_key": "private_key",
    "public_key": "public_key"
  }`,
    bucket: 'bucket',
    root: '.',
    clear: 'false'
}

describe('run', () => {
    const s3client = new S3Client({})
    const mockedSendFn = jest.spyOn(s3client, 'send')

    beforeEach(() => {
        jest.clearAllMocks()

        core.getBooleanInput.mockImplementation((): boolean => {
            return false
        })
        // Under jest.unstable_mockModule the whole @actions/core module is
        // replaced, so an unconfigured getMultilineInput has no real
        // implementation to fall back on (unlike the old jest.spyOn, where
        // an un-mocked call ran the real @actions/core function, which
        // returns [] for an absent input). Default it the same way so tests
        // that don't care about include/exclude/cache-control still reach
        // parseCacheControlFormats with an iterable.
        core.getMultilineInput.mockImplementation((): string[] => {
            return []
        })

        mockedSendFn.mockReset()
    })

    test('it should fail if bucket is not provided', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                bucket: ''
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })
        await run()
        expect(core.setFailed).toHaveBeenCalledWith('Input required and not supplied: bucket')
    })
    test('it should work with minimal inputs', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })
        await run()
        expect(core.setFailed).not.toHaveBeenCalled()
    })

    test('it should use yc-iam-token when provided', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                'yc-sa-json-credentials': '',
                'yc-iam-token': 'test-iam-token'
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })
        await run()
        expect(core.setFailed).not.toHaveBeenCalled()
    })

    test('it should use yc-sa-id with OIDC token', async () => {
        core.getIDToken.mockResolvedValue('github-token')
        axios.post.mockResolvedValue({
            status: 200,
            data: { access_token: 'exchanged-token' }
        })

        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                'yc-sa-json-credentials': '',
                'yc-sa-id': 'test-sa-id'
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })

        await run()
        expect(core.setFailed).not.toHaveBeenCalled()
        expect(axios.post).toHaveBeenCalledWith(
            'https://auth.yandex.cloud/oauth/token',
            expect.objectContaining({
                audience: 'test-sa-id',
                subject_token: 'github-token'
            }),
            expect.any(Object)
        )
    })

    test('it should fail when no credentials provided', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                'yc-sa-json-credentials': ''
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })

        await run()
        expect(core.setFailed).toHaveBeenCalledWith('No credentials')
    })

    test('it should fail when OIDC token is not available', async () => {
        core.getIDToken.mockResolvedValue('')

        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                'yc-sa-json-credentials': '',
                'yc-sa-id': 'test-sa-id'
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })

        await run()
        expect(core.setFailed).toHaveBeenCalledWith('No credentials provided')
    })

    test('it should handle token exchange failure', async () => {
        core.getIDToken.mockResolvedValue('github-token')
        axios.post.mockResolvedValue({
            status: 400,
            statusText: 'Bad Request'
        })

        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                'yc-sa-json-credentials': '',
                'yc-sa-id': 'test-sa-id'
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })

        await run()
        expect(core.setFailed).toHaveBeenCalledWith('Failed to exchange token: 400 Bad Request')
    })

    test('it should handle token exchange error response', async () => {
        core.getIDToken.mockResolvedValue('github-token')
        axios.post.mockResolvedValue({
            status: 200,
            data: { error: 'invalid_request', error_description: 'Invalid token' }
        })

        core.getInput.mockImplementation((name: string, options): string => {
            const inputs: Record<string, string> = {
                ...requiredInputs,
                'yc-sa-json-credentials': '',
                'yc-sa-id': 'test-sa-id'
            }

            const val = inputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })

        await run()
        expect(core.setFailed).toHaveBeenCalledWith('Failed to exchange token: invalid_request Invalid token')
    })

    test('it should handle error during file upload', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }
            return val ?? ''
        })

        core.getMultilineInput.mockImplementation((name: string) => {
            if (name === 'include') {
                return ['./src/*']
            }
            return []
        })

        mockedSendFn.mockRejectedValue(new Error('Upload failed'))

        await run()

        expect(core.error).toHaveBeenCalled()
    })

    test('it should handle non-existent path in include patterns', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }
            return val ?? ''
        })

        core.getMultilineInput.mockImplementation((name: string) => {
            if (name === 'include') {
                return ['./nonexistent-path']
            }
            return []
        })

        await run()

        expect(core.setFailed).not.toHaveBeenCalled()
        expect(core.debug).toHaveBeenCalled()
    })

    test('it should handle errors in run function', async () => {
        core.getInput.mockImplementation((name: string, options): string => {
            if (name === 'bucket') {
                throw new Error('Unexpected error')
            }
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }
            return val ?? ''
        })

        await run()

        expect(core.setFailed).toHaveBeenCalledWith('Unexpected error')
    })
})
