import {
    debug,
    endGroup,
    error,
    getBooleanInput,
    getIDToken,
    getInput,
    getMultilineInput,
    info,
    setFailed,
    startGroup
} from '@actions/core'
import {
    type AbortMultipartUploadCommandOutput,
    type CompleteMultipartUploadCommandOutput,
    DeleteObjectsCommand,
    ListObjectsV2Command,
    S3Client
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { HttpRequest } from '@smithy/protocol-http'
import { type FinalizeRequestMiddleware } from '@aws-sdk/types/dist-types/middleware'

import { IamTokenService } from '@yandex-cloud/nodejs-sdk/dist/token-service/iam-token-service'
import { createReadStream, statSync } from 'fs'
import { glob } from 'glob'
import mimeTypes from 'mime-types'
import { minimatch } from 'minimatch'
import path from 'node:path'
import { fromServiceAccountJsonFile } from './service-account-json'
import { CacheControlConfig, getCacheControlValue, parseCacheControlFormats } from './cache-control'
import { RequestChecksumCalculation, ResponseChecksumValidation } from '@aws-sdk/middleware-flexible-checksums'
import { SessionConfig, TokenService } from '@yandex-cloud/nodejs-sdk/dist/types'
import axios from 'axios'

type ActionInputs = {
    bucket: string
    prefix: string
    root: string
    include: string[]
    exclude: string[]
    clear: boolean
    cacheControl: CacheControlConfig
}

export async function run(): Promise<void> {
    try {
        let sessionConfig: SessionConfig = {}
        const ycSaJsonCredentials = getInput('yc-sa-json-credentials')
        const ycIamToken = getInput('yc-iam-token')
        const ycSaId = getInput('yc-sa-id')
        if (ycSaJsonCredentials !== '') {
            const serviceAccountJson = fromServiceAccountJsonFile(JSON.parse(ycSaJsonCredentials))
            info('Parsed Service account JSON')
            sessionConfig = { serviceAccountJson }
        } else if (ycIamToken !== '') {
            sessionConfig = { iamToken: ycIamToken }
            info('Using IAM token')
        } else if (ycSaId !== '') {
            const ghToken = await getIDToken()
            if (!ghToken) {
                throw new Error('No credentials provided')
            }
            const saToken = await exchangeToken(ghToken, ycSaId)
            sessionConfig = { iamToken: saToken }
        } else {
            throw new Error('No credentials')
        }

        const inputs: ActionInputs = {
            bucket: getInput('bucket', { required: true }),
            prefix: getInput('prefix', { required: false }),
            root: getInput('root', { required: true }),
            include: getMultilineInput('include', { required: false }),
            exclude: getMultilineInput('exclude', { required: false }),
            clear: getBooleanInput('clear', { required: false }),
            cacheControl: parseCacheControlFormats(getMultilineInput('cache-control', { required: false }))
        }

        // Initialize Token service with your SA credentials
        let tokenService: TokenService
        if ('serviceAccountJson' in sessionConfig) {
            tokenService = new IamTokenService(sessionConfig.serviceAccountJson)
        } else {
            tokenService = {
                getToken: async () => {
                    const iamToken = sessionConfig.iamToken
                    if (!iamToken) {
                        throw new Error('No IAM token provided')
                    }
                    return iamToken
                }
            }
        }

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
        if (inputs.clear) {
            await clearBucket(s3Client, inputs.bucket)
        }
        await upload(s3Client, inputs)
    } catch (err) {
        if (err instanceof Error) {
            setFailed(err.message)
        }
    }
}

export interface UploadInputs {
    include: string[]
    exclude: string[]
    root: string
    prefix: string
    bucket: string
    cacheControl: CacheControlConfig
}

const uploadFile = async (
    client: S3Client,
    filePath: string,
    { root, bucket, prefix, cacheControl }: UploadInputs
): Promise<CompleteMultipartUploadCommandOutput | AbortMultipartUploadCommandOutput | undefined> => {
    const stat = statSync(filePath)
    if (stat.isDirectory()) {
        return
    }
    const contentType = mimeTypes.lookup(filePath) || 'text/plain'

    let key = path.relative(root, filePath)
    if (prefix) {
        key = path.join(prefix, key)
    }
    try {
        info(`starting to upload ${key}`)
        const parallelUploads3 = new Upload({
            client,
            params: {
                Bucket: bucket,
                Key: key,
                Body: createReadStream(filePath),
                ContentType: contentType,
                CacheControl: getCacheControlValue(cacheControl, key)
            },
            queueSize: 4,
            leavePartsOnError: false
        })

        return await parallelUploads3.done()
    } catch (e) {
        error(`${e}`)
    }
}

export async function upload(s3Client: S3Client, inputs: UploadInputs): Promise<void> {
    startGroup('Upload')

    try {
        info('Upload start')

        const workspace = process.env['GITHUB_WORKSPACE'] ?? ''
        const patterns = parseIgnoreGlobPatterns(inputs.exclude)
        const root = path.join(workspace, inputs.root)

        for (const include of inputs.include) {
            let pathFromSourceRoot = path.join(root, include)
            if (!pathFromSourceRoot.includes('*')) {
                try {
                    const stat = statSync(pathFromSourceRoot)
                    if (stat.isDirectory()) {
                        pathFromSourceRoot = path.join(pathFromSourceRoot, '*')
                    }
                } catch (e) {
                    debug(`${e}`)
                }
            }
            const matches = glob.sync(pathFromSourceRoot, { absolute: false })
            for (const match of matches) {
                const res = !patterns.map(p => minimatch(match, p, { matchBase: true })).some(x => x)
                if (res) {
                    await uploadFile(s3Client, match, {
                        ...inputs,
                        root
                    })
                }
            }
        }
    } finally {
        endGroup()
    }
}

function parseIgnoreGlobPatterns(patterns: string[]): string[] {
    const result: string[] = []

    for (const pattern of patterns) {
        //only not empty patterns
        if (pattern?.length > 0) {
            result.push(pattern)
        }
    }

    info(`Source ignore pattern: "${JSON.stringify(result)}"`)
    return result
}

export async function clearBucket(client: S3Client, bucket: string): Promise<void> {
    info('Clearing bucket')
    const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        // The default and maximum number of keys returned is 1000.
        MaxKeys: 1000
    })

    let isTruncated = true
    let totalDeleted = 0

    while (isTruncated) {
        const { Contents, IsTruncated, NextContinuationToken } = await client.send(listCommand)

        if (!Contents || Contents.length === 0) {
            break
        }

        isTruncated = Boolean(IsTruncated)
        listCommand.input.ContinuationToken = NextContinuationToken

        const deleteCommand = new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: {
                Objects: Contents.map(c => ({ Key: c.Key }))
            }
        })

        const { Deleted } = await client.send(deleteCommand)

        totalDeleted += Deleted?.length ?? 0
    }

    info(`Deleted ${totalDeleted} objects from bucket ${bucket}`)
}

async function exchangeToken(token: string, saId: string): Promise<string> {
    info(`Exchanging token for service account ${saId}`)
    const res = await axios.post(
        'https://auth.yandex.cloud/oauth/token',
        {
            grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
            requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
            audience: saId,
            subject_token: token,
            subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
        },
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        }
    )
    if (res.status !== 200) {
        throw new Error(`Failed to exchange token: ${res.status} ${res.statusText}`)
    }
    if (!res.data.access_token) {
        throw new Error(`Failed to exchange token: ${res.data.error} ${res.data.error_description}`)
    }
    info(`Token exchanged successfully`)
    return res.data.access_token
}
