import { jest } from '@jest/globals'
import { HeadObjectCommand } from '@aws-sdk/client-s3'
import type { HttpRequest as HttpRequestType } from '@smithy/protocol-http'
import type { TokenService } from '@yandex-cloud/nodejs-sdk/dist/types'

const { createS3Client } = await import('../src/s3-client.js')

describe('createS3Client', () => {
    // The characterization snapshot mocks S3Client.prototype.send, which sits above the whole
    // middleware stack, so it cannot see whether ycAuthMiddleware is actually wired in. This test
    // drives a real request through the real stack via a fake requestHandler installed at the
    // bottom, so the auth header and the removal of AWS SigV4 signing are genuinely exercised.
    test('sets X-YaCloud-SubjectToken and removes AWS request signing', async () => {
        const getToken = jest.fn<TokenService['getToken']>().mockResolvedValue('stub-iam-token')
        const tokenService: TokenService = { getToken }

        const s3Client = createS3Client(tokenService)

        let capturedRequest: HttpRequestType | undefined
        s3Client.config.requestHandler = {
            handle: async (request: HttpRequestType) => {
                capturedRequest = request
                throw new Error('fake requestHandler: no network in tests')
            }
        }

        await expect(s3Client.send(new HeadObjectCommand({ Bucket: 'bucket', Key: 'key' }))).rejects.toThrow()

        expect(getToken).toHaveBeenCalledTimes(1)
        expect(capturedRequest).toBeDefined()
        expect(capturedRequest?.headers['X-YaCloud-SubjectToken']).toBe('stub-iam-token')
        expect(capturedRequest?.headers['Authorization']).toBeUndefined()
    })
})
