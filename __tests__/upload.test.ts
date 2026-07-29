import { expect, jest, test } from '@jest/globals'
import {
    CompleteMultipartUploadCommand,
    CreateMultipartUploadCommand,
    HeadObjectCommand,
    PutObjectCommand,
    S3Client,
    UploadPartCommand
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, rmdirSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { env } from 'node:process'

import * as core from '../__fixtures__/core.js'

jest.unstable_mockModule('@actions/core', () => core)

const { upload, runPool } = await import('../src/upload.js')
const { newCacheControlConfig } = await import('../src/cache-control.js')

type UploadInputs = import('../src/upload.js').UploadInputs

const strCompare = (a: string | undefined, b: string | undefined): number => {
    if (!a || !b) {
        return 0
    }
    return a.localeCompare(b)
}

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
                        .update(readFileSync(join(env.GITHUB_WORKSPACE ?? '', key)))
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
        expect(core.setFailed).toHaveBeenCalledTimes(1)
        expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('Failed to upload 3 file(s)'))
    })

    test('does not fail the action on upload errors by default, but still attempts every file', async () => {
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
        expect(core.setFailed).not.toHaveBeenCalled()
    })
})
