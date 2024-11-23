import {
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    ListObjectsV2Output,
    PutObjectCommand,
    S3Client,
    UploadPartCommand
} from '@aws-sdk/client-s3'
import { expect, test } from '@jest/globals'
import * as fs from 'fs'
import * as path from 'path'
import * as process from 'process'
import { clearBucket, run, upload, UploadInputs } from '../src/main'
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
        const cwd = process.env.GITHUB_WORKSPACE ?? ''
        fs.mkdirSync(path.join(cwd, 'bigfile'), { recursive: true })
        const bigfile = fs.openSync(path.join(cwd, 'bigfile/10mbfile.txt'), 'w')
        const size = 10 * 1024 ** 2
        fs.writeSync(bigfile, Buffer.alloc(size), 0, size, 0)
        fs.closeSync(bigfile)

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
            fs.mkdirSync(path.join(cwd, './bigfile'))
        } catch (e: unknown) {
            if (e instanceof Error && 'code' in e && e.code !== 'EEXIST') {
                console.log(e)
                throw e
            }
        }
        fs.writeFileSync(path.join(cwd, './bigfile/10mbfile.txt'), new Uint8Array(size))

        await upload(s3client, inputs)

        expect(mockedSendFn).toHaveBeenCalledTimes(4)
        expect(createCommands).toEqual(1)
        expect(uploadCommands).toEqual(2)
        expect(completeCommands).toEqual(1)
        if (!createMultipartUploadCommand) {
            throw new Error('createMultipartUploadCommand === null')
        }
        expect(createMultipartUploadCommand.input.Key).toEqual('10mbfile.txt')

        fs.rmdirSync(path.join(cwd, './bigfile'), { recursive: true })
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
})
