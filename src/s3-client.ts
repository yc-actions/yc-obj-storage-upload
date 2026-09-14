import { S3Client } from '@aws-sdk/client-s3'
import { RequestChecksumCalculation, ResponseChecksumValidation } from '@aws-sdk/middleware-flexible-checksums'
import { HttpRequest } from '@smithy/protocol-http'
import { type FinalizeRequestMiddleware } from '@smithy/types'
import { TokenService } from '@yandex-cloud/nodejs-sdk/dist/types'

export function createS3Client(tokenService: TokenService): S3Client {
    const s3Client = new S3Client({
        region: 'ru-central1',
        endpoint: 'https://storage.yandexcloud.net',
        requestChecksumCalculation: RequestChecksumCalculation.WHEN_REQUIRED,
        responseChecksumValidation: ResponseChecksumValidation.WHEN_REQUIRED
    })

    // eslint-disable-next-line  @typescript-eslint/no-explicit-any
    const middleware: FinalizeRequestMiddleware<any, any> = next => {
        return async args => {
            if (!HttpRequest.isInstance(args.request)) {
                return next(args)
            }
            args.request.headers['X-YaCloud-SubjectToken'] = await tokenService.getToken()
            return next(args)
        }
    }

    s3Client.middlewareStack.removeByTag('HTTP_AUTH_SCHEME')
    s3Client.middlewareStack.removeByTag('HTTP_SIGNING')
    s3Client.middlewareStack.addRelativeTo(middleware, {
        name: 'ycAuthMiddleware',
        tags: ['YCAUTH'],
        relation: 'after',
        toMiddleware: 'retryMiddleware',
        override: true
    })

    return s3Client
}
