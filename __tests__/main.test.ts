import { jest } from '@jest/globals'
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
    // Mock the GitHub Actions core library
    let getInputMock: jest.Mock
    let getBooleanInputMock: jest.Mock
    let setFailedMock: jest.Mock

    const s3client = new S3Client({})
    const mockedSendFn = jest.spyOn(s3client, 'send')

    beforeEach(() => {
        jest.clearAllMocks()
        getInputMock = core.getInput
        getBooleanInputMock = core.getBooleanInput
        setFailedMock = core.setFailed

        getBooleanInputMock.mockImplementation((): boolean => {
            return false
        })
        // Real @actions/core#getMultilineInput returns [] for an input that was
        // never set; the fixture double has no such fallback, so tests that don't
        // care about include/exclude/cache-control need one here to match the
        // pre-ESM behavior of falling through to the real, unspied implementation.
        core.getMultilineInput.mockImplementation((): string[] => [])

        mockedSendFn.mockReset()
    })

    test('it should fail if bucket is not provided', async () => {
        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).toHaveBeenCalledWith('Input required and not supplied: bucket')
    })
    test('it should work with minimal inputs', async () => {
        getInputMock.mockImplementation((name: string, options): string => {
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }

            return val ?? ''
        })
        await run()
        expect(setFailedMock).not.toHaveBeenCalled()
    })

    test('it should use yc-iam-token when provided', async () => {
        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).not.toHaveBeenCalled()
    })

    test('it should use yc-sa-id with OIDC token', async () => {
        core.getIDToken.mockResolvedValue('github-token')
        axios.post.mockResolvedValue({
            status: 200,
            data: { access_token: 'exchanged-token' }
        })

        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).not.toHaveBeenCalled()
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
        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).toHaveBeenCalledWith('No credentials')
    })

    test('it should fail when OIDC token is not available', async () => {
        core.getIDToken.mockResolvedValue('')

        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).toHaveBeenCalledWith('No credentials provided')
    })

    test('it should handle token exchange failure', async () => {
        core.getIDToken.mockResolvedValue('github-token')
        axios.post.mockResolvedValue({
            status: 400,
            statusText: 'Bad Request'
        })

        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).toHaveBeenCalledWith('Failed to exchange token: 400 Bad Request')
    })

    test('it should handle token exchange error response', async () => {
        core.getIDToken.mockResolvedValue('github-token')
        axios.post.mockResolvedValue({
            status: 200,
            data: { error: 'invalid_request', error_description: 'Invalid token' }
        })

        getInputMock.mockImplementation((name: string, options): string => {
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
        expect(setFailedMock).toHaveBeenCalledWith('Failed to exchange token: invalid_request Invalid token')
    })

    test('it should handle error during file upload', async () => {
        getInputMock.mockImplementation((name: string, options): string => {
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
        getInputMock.mockImplementation((name: string, options): string => {
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

        expect(setFailedMock).not.toHaveBeenCalled()
        expect(core.debug).toHaveBeenCalled()
    })

    test('it should handle errors in run function', async () => {
        getInputMock.mockImplementation((name: string, options): string => {
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

        expect(setFailedMock).toHaveBeenCalledWith('Unexpected error')
    })
})
