import {
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    ListObjectsV2Output,
    PutObjectCommand,
    S3Client,
    UploadPartCommand
} from '@aws-sdk/client-s3'
import { expect, test } from '@jest/globals'
import { createHash } from 'crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, writeFileSync, writeSync } from 'fs'
import { join } from 'path'
import { env } from 'process'
import { clearBucket, parseConcurrency, run, runPool, upload, UploadInputs } from '../src/main'
// eslint-disable-next-line importPlugin/no-namespace
import * as core from '@actions/core'
import { newCacheControlConfig } from '../src/cache-control'

const strCompare = (a: string | undefined, b: string | undefined): number => {
    if (!a || !b) {
        return 0
    }
    return a.localeCompare(b)
}

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

describe('parseConcurrency', () => {
    test('defaults to 16 for empty or non-numeric input', () => {
        expect(parseConcurrency('')).toBe(16)
        expect(parseConcurrency('abc')).toBe(16)
    })
    test('honors a valid value', () => {
        expect(parseConcurrency('8')).toBe(8)
    })
    test('clamps values below 1 up to 1', () => {
        expect(parseConcurrency('0')).toBe(1)
        expect(parseConcurrency('-5')).toBe(1)
    })
    test('clamps values above 256 down to 256', () => {
        expect(parseConcurrency('257')).toBe(256)
        expect(parseConcurrency('100000')).toBe(256)
    })
})

describe('runPool', () => {
    test('processes every item exactly once', async () => {
        const items = [1, 2, 3, 4, 5, 6, 7]
        const seen: number[] = []
        await runPool(items, 3, async item => {
            seen.push(item)
        })
        expect(seen.sort((a, b) => a - b)).toEqual(items)
    })

    test('never exceeds the concurrency limit', async () => {
        const items = Array.from({ length: 20 }, (_, i) => i)
        let active = 0
        let maxActive = 0
        await runPool(items, 4, async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            await new Promise(resolve => setTimeout(resolve, 1))
            active -= 1
        })
        expect(maxActive).toBeLessThanOrEqual(4)
    })

    test('handles an empty list without error', async () => {
        const worker = jest.fn()
        await runPool([], 4, worker)
        expect(worker).not.toHaveBeenCalled()
    })

    test('rejects when a worker throws', async () => {
        await expect(
            runPool([1, 2, 3], 2, async item => {
                if (item === 2) {
                    throw new Error('boom')
                }
            })
        ).rejects.toThrow('boom')
    })
})

describe('upload', () => {
    const s3client = new S3Client({})
    const mockedSendFn = jest.spyOn(s3client, 'send')

    beforeEach(() => {
        mockedSendFn.mockReset()
    })

    test('it should clear bucket', async () => {
        mockedSendFn.mockImplementation(async cmd => {
            if (cmd instanceof ListObjectsV2Command) {
                const output: ListObjectsV2Output = {
                    Contents: [
                        {
                            Key: 'src/func.js'
                        }
                    ],
                    IsTruncated: false
                }
                return Promise.resolve(output)
            }
            return Promise.resolve({})
        })
        await clearBucket(s3client, 'bucket')

        const expected = [expect.any(ListObjectsV2Command), expect.any(DeleteObjectsCommand)]

        for (let i = 0; i < expected.length; i++) {
            expect(mockedSendFn).toHaveBeenNthCalledWith(i + 1, expected[i])
        }
    })

    test('it should clear bucket with a lot objects', async () => {
        const listCommnds: ListObjectsV2Output[] = [
            {
                Contents: [
                    {
                        Key: 'src/func.js'
                    }
                ],
                IsTruncated: true,
                NextContinuationToken: 'token'
            },
            {
                Contents: [
                    {
                        Key: 'src/func.js'
                    }
                ],
                IsTruncated: true,
                NextContinuationToken: 'token'
            },
            {
                Contents: [
                    {
                        Key: 'src/func.js'
                    }
                ],
                IsTruncated: false
            }
        ]
        let listCommandIndex = 0
        mockedSendFn.mockImplementation(async cmd => {
            if (cmd instanceof ListObjectsV2Command) {
                const output = listCommnds[listCommandIndex]
                listCommandIndex += 1
                return Promise.resolve(output)
            }
            return Promise.resolve({})
        })
        await clearBucket(s3client, 'bucket')

        const expected = [
            expect.any(ListObjectsV2Command),
            expect.any(DeleteObjectsCommand),
            expect.any(ListObjectsV2Command),
            expect.any(DeleteObjectsCommand),
            expect.any(ListObjectsV2Command),
            expect.any(DeleteObjectsCommand)
        ]

        for (let i = 0; i < expected.length; i++) {
            expect(mockedSendFn).toHaveBeenNthCalledWith(i + 1, expected[i])
        }
        expect(mockedSendFn).toHaveBeenCalledTimes(expected.length)
    })

    test('it should add files from include', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['./src/*'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(3)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['src/exclude.txt', 'src/exclude.yaml', 'src/func.js'])
    })

    test('it uploads all files when a custom concurrency is set', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['./src/*'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig(),
            concurrency: 2
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(3)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['src/exclude.txt', 'src/exclude.yaml', 'src/func.js'])
    })

    test('it should drop files from if they do not match include patterns', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['./src/*.js'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(1)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['src/func.js'])
    })

    test('it should drop files from if they match exclude patterns', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['./src/*'],
            exclude: ['**/*.txt'],
            root: '.',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(2)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['src/exclude.yaml', 'src/func.js'])
    })

    test('it should drop folder prefix if sourceRoot provided', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['*'],
            exclude: [],
            root: './src',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(3)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['exclude.txt', 'exclude.yaml', 'func.js'])
    })

    test('it handle folders', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['src'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(3)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['src/exclude.txt', 'src/exclude.yaml', 'src/func.js'])
    })

    test('it handle folders inside include folder', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['src_with_subfolders/**'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(4)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual([
            'src_with_subfolders/bXdOv4sbedSkTy8PGMUJ/ivAzMS09Ndx3VPJ8WnNL.js',
            'src_with_subfolders/exclude.txt',
            'src_with_subfolders/exclude.yaml',
            'src_with_subfolders/func.js'
        ])
    })

    test('it should respect source root and include only needed files', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['*.js'],
            exclude: [],
            root: './src',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(1)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['func.js'])
    })

    test('it should add prefix', async () => {
        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: 'prefix/',
            include: ['*.js'],
            exclude: [],
            root: './src',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(1)
        const keys = mockedSendFn.mock.calls.map(([cmd]) => (cmd as PutObjectCommand).input.Key).sort(strCompare)
        expect(keys).toEqual(['prefix/func.js'])
    })

    jest.setTimeout(600_000)
    test('it should use multipart on big files', async () => {
        // generate a 10mb file
        const cwd = env.GITHUB_WORKSPACE ?? ''
        mkdirSync(join(cwd, 'bigfile'), { recursive: true })
        const bigfile = openSync(join(cwd, 'bigfile/10mbfile.txt'), 'w')
        const size = 10 * 1024 ** 2
        writeSync(bigfile, Buffer.alloc(size), 0, size, 0)
        closeSync(bigfile)

        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['10mbfile.txt'],
            exclude: [],
            root: './bigfile',
            cacheControl: newCacheControlConfig()
        }
        let createCommands = 0
        let uploadCommands = 0
        let completeCommands = 0

        let createMultipartUploadCommand: CreateMultipartUploadCommand | undefined

        mockedSendFn.mockImplementation(async cmd => {
            if (cmd instanceof CreateMultipartUploadCommand) {
                createCommands += 1
                createMultipartUploadCommand = cmd
                return Promise.resolve({
                    UploadId: 1
                })
            }
            if (cmd instanceof UploadPartCommand) {
                uploadCommands += 1
                return Promise.resolve({
                    ETag: Math.random().toString().slice(2)
                })
            }
            if (cmd instanceof CompleteMultipartUploadCommand) {
                completeCommands += 1
                return Promise.resolve({
                    ETag: Math.random().toString().slice(2)
                })
            }
        })

        try {
            mkdirSync(join(cwd, './bigfile'))
        } catch (e: unknown) {
            if (e instanceof Error && 'code' in e && e.code !== 'EEXIST') {
                // eslint-disable-next-line no-console
                console.log(e)
                throw e
            }
        }
        writeFileSync(join(cwd, './bigfile/10mbfile.txt'), new Uint8Array(size))

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(4)
        expect(createCommands).toEqual(1)
        expect(uploadCommands).toEqual(2)
        expect(completeCommands).toEqual(1)
        if (!createMultipartUploadCommand) {
            throw new Error('createMultipartUploadCommand === null')
        }
        expect(createMultipartUploadCommand.input.Key).toEqual('10mbfile.txt')

        rmdirSync(join(cwd, './bigfile'), { recursive: true })
    })

    describe('skip-unchanged', () => {
        test('skips a file whose remote ETag matches the local md5', async () => {
            mockedSendFn.mockImplementation(async cmd => {
                if (cmd instanceof HeadObjectCommand) {
                    const key = cmd.input.Key as string
                    const md5 = createHash('md5')
                        .update(readFileSync(join('__tests__', key)))
                        .digest('hex')
                    return { ETag: `"${md5}"` }
                }
                return {}
            })

            const inputs: UploadInputs = {
                bucket: 'bucket',
                prefix: '',
                include: ['./src/*'],
                exclude: [],
                root: '.',
                cacheControl: newCacheControlConfig(),
                skipUnchanged: true
            }

            await upload(s3client, inputs)

            const putCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)
            expect(putCalls.length).toBe(0)
        })

        test('uploads a file whose remote ETag differs', async () => {
            mockedSendFn.mockImplementation(async cmd => {
                if (cmd instanceof HeadObjectCommand) {
                    return { ETag: '"00000000000000000000000000000000"' }
                }
                return {}
            })

            const inputs: UploadInputs = {
                bucket: 'bucket',
                prefix: '',
                include: ['./src/*'],
                exclude: [],
                root: '.',
                cacheControl: newCacheControlConfig(),
                skipUnchanged: true
            }

            await upload(s3client, inputs)

            const putCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)
            expect(putCalls.length).toBe(3)
        })

        test('uploads when the remote ETag is a multipart ETag', async () => {
            mockedSendFn.mockImplementation(async cmd => {
                if (cmd instanceof HeadObjectCommand) {
                    return { ETag: '"d41d8cd98f00b204e9800998ecf8427e-2"' }
                }
                return {}
            })

            const inputs: UploadInputs = {
                bucket: 'bucket',
                prefix: '',
                include: ['./src/*'],
                exclude: [],
                root: '.',
                cacheControl: newCacheControlConfig(),
                skipUnchanged: true
            }

            await upload(s3client, inputs)

            const putCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)
            expect(putCalls.length).toBe(3)
        })

        test('uploads when HeadObject reports the key does not exist', async () => {
            mockedSendFn.mockImplementation(async cmd => {
                if (cmd instanceof HeadObjectCommand) {
                    const err = new Error('NotFound') as Error & { name: string }
                    err.name = 'NotFound'
                    throw err
                }
                return {}
            })

            const inputs: UploadInputs = {
                bucket: 'bucket',
                prefix: '',
                include: ['./src/*'],
                exclude: [],
                root: '.',
                cacheControl: newCacheControlConfig(),
                skipUnchanged: true
            }

            await upload(s3client, inputs)

            const putCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)
            expect(putCalls.length).toBe(3)
        })

        test('never calls HeadObject when skipUnchanged is not set', async () => {
            const inputs: UploadInputs = {
                bucket: 'bucket',
                prefix: '',
                include: ['./src/*'],
                exclude: [],
                root: '.',
                cacheControl: newCacheControlConfig()
            }

            await upload(s3client, inputs)

            const headCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof HeadObjectCommand)
            expect(headCalls.length).toBe(0)
        })
    })

    test('fails the action when failOnError is set and a file fails to upload', async () => {
        const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
        mockedSendFn.mockImplementation(async cmd => {
            if (cmd instanceof PutObjectCommand || cmd instanceof CreateMultipartUploadCommand) {
                throw new Error('upload boom')
            }
            return {}
        })

        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['./src/*'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig(),
            failOnError: true
        }

        await upload(s3client, inputs)

        // All three files were attempted...
        const putCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)
        expect(putCalls.length).toBe(3)
        // ...and the action was failed once with a summary of the failures.
        expect(setFailedMock).toHaveBeenCalledTimes(1)
        expect(setFailedMock).toHaveBeenCalledWith(expect.stringContaining('Failed to upload 3 file(s)'))
        setFailedMock.mockRestore()
    })

    test('does not fail the action on upload errors by default, but still attempts every file', async () => {
        const setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()
        mockedSendFn.mockImplementation(async cmd => {
            if (cmd instanceof PutObjectCommand || cmd instanceof CreateMultipartUploadCommand) {
                throw new Error('upload boom')
            }
            return {}
        })

        const inputs: UploadInputs = {
            bucket: 'bucket',
            prefix: '',
            include: ['./src/*'],
            exclude: [],
            root: '.',
            cacheControl: newCacheControlConfig()
        }

        await upload(s3client, inputs)

        const putCalls = mockedSendFn.mock.calls.filter(([cmd]) => cmd instanceof PutObjectCommand)
        expect(putCalls.length).toBe(3)
        expect(setFailedMock).not.toHaveBeenCalled()
        setFailedMock.mockRestore()
    })
})

describe('run', () => {
    // Mock the GitHub Actions core library
    let getInputMock: jest.SpyInstance
    let getBooleanInputMock: jest.SpyInstance
    let setFailedMock: jest.SpyInstance

    const s3client = new S3Client({})
    const mockedSendFn = jest.spyOn(s3client, 'send')

    beforeEach(() => {
        jest.clearAllMocks()
        getInputMock = jest.spyOn(core, 'getInput').mockImplementation()
        getBooleanInputMock = jest.spyOn(core, 'getBooleanInput').mockImplementation()
        setFailedMock = jest.spyOn(core, 'setFailed').mockImplementation()

        getBooleanInputMock.mockImplementation((): boolean => {
            return false
        })

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
        const getIDTokenMock = jest.spyOn(core, 'getIDToken').mockResolvedValue('github-token')
        const axiosMock = jest.spyOn(require('axios'), 'post').mockResolvedValue({
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
        expect(axiosMock).toHaveBeenCalledWith(
            'https://auth.yandex.cloud/oauth/token',
            expect.objectContaining({
                audience: 'test-sa-id',
                subject_token: 'github-token'
            }),
            expect.any(Object)
        )

        getIDTokenMock.mockRestore()
        axiosMock.mockRestore()
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
        const getIDTokenMock = jest.spyOn(core, 'getIDToken').mockResolvedValue('')

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

        getIDTokenMock.mockRestore()
    })

    test('it should handle token exchange failure', async () => {
        const getIDTokenMock = jest.spyOn(core, 'getIDToken').mockResolvedValue('github-token')
        const axiosMock = jest.spyOn(require('axios'), 'post').mockResolvedValue({
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

        getIDTokenMock.mockRestore()
        axiosMock.mockRestore()
    })

    test('it should handle token exchange error response', async () => {
        const getIDTokenMock = jest.spyOn(core, 'getIDToken').mockResolvedValue('github-token')
        const axiosMock = jest.spyOn(require('axios'), 'post').mockResolvedValue({
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

        getIDTokenMock.mockRestore()
        axiosMock.mockRestore()
    })

    test('it should handle error during file upload', async () => {
        const errorSpy = jest.spyOn(core, 'error').mockImplementation()

        getInputMock.mockImplementation((name: string, options): string => {
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }
            return val ?? ''
        })

        const getMultilineInputMock = jest.spyOn(core, 'getMultilineInput').mockImplementation((name: string) => {
            if (name === 'include') {
                return ['./src/*']
            }
            return []
        })

        mockedSendFn.mockRejectedValue(new Error('Upload failed'))

        await run()

        expect(errorSpy).toHaveBeenCalled()

        errorSpy.mockRestore()
        getMultilineInputMock.mockRestore()
    })

    test('it should handle non-existent path in include patterns', async () => {
        const debugSpy = jest.spyOn(core, 'debug').mockImplementation()

        getInputMock.mockImplementation((name: string, options): string => {
            const val = requiredInputs[name]
            if (options && options.required && !val) {
                throw new Error(`Input required and not supplied: ${name}`)
            }
            return val ?? ''
        })

        const getMultilineInputMock = jest.spyOn(core, 'getMultilineInput').mockImplementation((name: string) => {
            if (name === 'include') {
                return ['./nonexistent-path']
            }
            return []
        })

        await run()

        expect(setFailedMock).not.toHaveBeenCalled()
        expect(debugSpy).toHaveBeenCalled()

        debugSpy.mockRestore()
        getMultilineInputMock.mockRestore()
    })

    test('it should handle clear bucket with empty contents', async () => {
        const s3client = new S3Client({})
        const sendMock = jest.spyOn(s3client, 'send')

        sendMock.mockResolvedValue({
            Contents: [],
            IsTruncated: false
        })

        await clearBucket(s3client, 'test-bucket')

        expect(sendMock).toHaveBeenCalledWith(expect.any(ListObjectsV2Command))
        expect(sendMock).toHaveBeenCalledTimes(1)

        sendMock.mockRestore()
    })

    test('it should handle clear bucket with undefined contents', async () => {
        const s3client = new S3Client({})
        const sendMock = jest.spyOn(s3client, 'send')

        sendMock.mockResolvedValue({
            Contents: undefined,
            IsTruncated: false
        })

        await clearBucket(s3client, 'test-bucket')

        expect(sendMock).toHaveBeenCalledWith(expect.any(ListObjectsV2Command))
        expect(sendMock).toHaveBeenCalledTimes(1)

        sendMock.mockRestore()
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
