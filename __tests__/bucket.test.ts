import { expect, jest, test } from '@jest/globals'
import { DeleteObjectsCommand, ListObjectsV2Command, ListObjectsV2Output, S3Client } from '@aws-sdk/client-s3'
import { clearBucket } from '../src/bucket.js'

describe('clearBucket', () => {
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
})
